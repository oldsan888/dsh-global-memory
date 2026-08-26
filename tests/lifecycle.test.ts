import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/**
 * A minimal in-memory KvTable matching the host's `dsh-storage-domain` KvTable
 * contract (put/get/delete/update/entries/size), so `apply()` can run without a
 * real DSH profile. This is a Phase 0 test harness — it does not touch the real
 * database or real storage backend.
 */
function memTable<K extends string, V>(): {
  table: { get(k: K): V | undefined; put(k: K, v: V): Promise<void>; delete(k: K): Promise<boolean>; update(k: K, fn: (c: V) => V): Promise<V>; entries(): IterableIterator<[K, V]>; size: number }
  store: Map<K, V>
} {
  const store = new Map<K, V>()
  const table = {
    get: (k: K) => store.get(k),
    put: async (k: K, v: V) => { store.set(k, v) },
    delete: async (k: K) => { if (!store.has(k)) return false; store.delete(k); return true },
    update: async (k: K, fn: (c: V) => V) => {
      // Real host contract: missing key rejects with the DomainError code
      // shape (stable `code === 'missing-key'`, diagnostic message); a
      // throwing fn must not commit.
      const current = store.get(k)
      if (current === undefined) {
        const err = new Error(`domain 'agent_memories' table 'memories' has no record '${String(k)}' to update`) as Error & { code?: string }
        err.name = 'DomainError'
        err.code = 'missing-key'
        throw err
      }
      const next = fn(current)
      store.set(k, next)
      return next
    },
    entries: () => store.entries(),
    size: store.size,
  }
  return { table, store }
}

interface ToolDef { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

function makeCtx() {
  const registered: ToolDef[] = []
  const disposers: Array<() => void> = []
  const listeners: Array<{ event: string; listener: unknown }> = []
  const { table, store } = memTable<string, unknown>()
  const { table: receiptsTable, store: receiptsStore } = memTable<string, unknown>()
  const closeSpy = vi.fn(async () => {})
  const ctx = {
    storageDomain: {
      open: vi.fn(async () => ({
        table: (name: string) => name === 'memories' ? table : name === 'deletions' ? receiptsTable : (() => { throw new Error('no table') })(),
        close: closeSpy,
      })),
    },
    tools: { register: (d: ToolDef) => void registered.push(d) },
    effect: (f: () => () => void) => { const d = f(); if (d) disposers.push(d) },
    on: (event: string, listener: unknown) => void listeners.push({ event, listener }),
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, registered, disposers, listeners, store, table, closeSpy, receiptsStore }
}

/**
 * A valid tool-call executor: the Phase 1 `memory_write` requires a real
 * `callId` (server-side source) — tests must provide one, per handoff §3.1.
 */
const noExec = { agent: { session: { id: 's-test' } }, callId: 'call-test-1' }

async function runPlug(overrides: Record<string, unknown> = {}) {
  const { ctx, registered, disposers, listeners, store, closeSpy, receiptsStore } = makeCtx()
  // NOTE: do NOT set autoInject here by default — the "defaults on" case must
  // exercise the plugin's own `config.autoInject ?? true` default.
  await apply(ctx, {
    embedding: { enabled: false },
    ...overrides,
  })
  const byName = (n: string) => registered.find(d => d.name === n)
  return { ctx, registered, disposers, listeners, store, closeSpy, receiptsStore, byName }
}

describe('apply() Phase 0 lifecycle', () => {
  it('registers exactly the five memory tools (Phase 4 adds read-only memory_status)', async () => {
    const { registered } = await runPlug()
    expect(registered.map(d => d.name).sort()).toEqual(['memory_delete', 'memory_recall', 'memory_retire', 'memory_status', 'memory_write'])
  })

  it('closes the domain on plugin disposal (ctx.effect disposer)', async () => {
    const { disposers, closeSpy } = await runPlug()
    expect(disposers.length).toBeGreaterThan(0)
    // Phase 3 disposer is async: abort embedding → await backfill → close.
    for (const d of disposers) await d()
    expect(closeSpy).toHaveBeenCalled()
  })

  it('does not register a pre-step listener when autoInject=false', async () => {
    const { listeners } = await runPlug({ autoInject: false })
    expect(listeners.some(l => l.event === 'agent/pre-step')).toBe(false)
  })

  it('registers a pre-step listener when autoInject defaults on', async () => {
    const { listeners } = await runPlug({})
    expect(listeners.some(l => l.event === 'agent/pre-step')).toBe(true)
  })
})

describe('memory_write Phase 0 semantics', () => {
  // apply() now bootstraps an `agent-memory-profile`; helper counts only
  // non-bootstrap rows so Phase 0 row-count assertions stay meaningful.
  const nonBootstrap = (store: Map<string, unknown>) =>
    [...store.values()].filter(r => (r as { key?: string }).key !== 'agent-memory-profile')

  it('creates a record, then reuses the same key to refresh in place (same value)', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const first = await write.execute({ content: '示例用户喜欢简洁回复', key: 'comm-style', scope: 'communication' }, noExec)
    expect(first).toMatchObject({ created: true })
    const firstId = (first as { id: string }).id
    const second = await write.execute({ content: '示例用户喜欢简洁回复（更新）', key: 'comm-style', scope: 'communication', value: 'v1' }, noExec)
    expect(second).toMatchObject({ created: false, id: firstId })
    expect(nonBootstrap(store)).toHaveLength(1)
  })

  it('updates the same physical keyed record in place and appends a revision (Phase 2)', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: '旧立场 A', key: 'stance', value: 'A' }, noExec)
    const firstId = (v1 as { id: string }).id
    const v2 = await write.execute({ content: '新立场 B', key: 'stance', value: 'B' }, noExec)
    expect((v2 as { created: boolean }).created).toBe(false)
    expect((v2 as { id: string }).id).toBe(firstId) // same physical record
    const rows = nonBootstrap(store)
    expect(rows.length).toBe(1) // no supersede chain, no second row
    const row = rows[0] as { content?: string; supersededBy?: string; revisions?: Array<{ content?: string }> }
    expect(row.content).toBe('新立场 B')
    expect(row.supersededBy).toBeUndefined()
    expect(row.revisions).toHaveLength(1) // old body kept as a revision
    expect(row.revisions![0].content).toBe('旧立场 A')
  })

  it('dedupes keyless writes above the similarity threshold', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    await write.execute({ content: '用户偏好中文回答' }, noExec)
    await write.execute({ content: '用户偏好中文回复' }, noExec)
    expect(nonBootstrap(store)).toHaveLength(1)
  })
})

describe('memory_retire Phase 2 semantics (soft retire)', () => {
  it('marks a record with retiredAt, keeping the row readable via raw store', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const created = await write.execute({ content: '临时事实', key: 'tmp' }, noExec)
    const id = (created as { id: string }).id
    const retire = byName('memory_retire')!
    const result = await retire.execute({ id }, noExec)
    expect(result).toMatchObject({ retired: 1 })
    const row = store.get(id) as { retiredAt?: number; deleted?: boolean }
    expect(row.retiredAt).toBeGreaterThan(0)
    expect(row.deleted).toBeUndefined() // Phase 2 no longer writes deleted:true
  })

  it('returns retired:0 for unknown id', async () => {
    const { byName } = await runPlug()
    const retire = byName('memory_retire')!
    expect(await retire.execute({ id: 'nope' }, noExec)).toMatchObject({ retired: 0 })
  })

  it('requires exactly one of id or key', async () => {
    const { byName } = await runPlug()
    const retire = byName('memory_retire')!
    await expect(retire.execute({}, noExec)).rejects.toThrow(/exactly one/)
    await expect(retire.execute({ id: 'a', key: 'b' }, noExec)).rejects.toThrow(/exactly one/)
  })
})

describe('auto-inject snapshot (pre-step) Phase 0 behaviour', () => {
  const SNAPSHOT_FORM = 'global-memory-auto-inject'
  const DEPLOY_PROFILE_BODY = '部署者明确提供的用户画像：偏好简洁回复，重要事项主动通知。'

  /** Build an apply() harness capturing pre-step listener + tools. */
  async function harness() {
    const { ctx, listeners, registered } = makeCtx()
    await apply(ctx, {
      embedding: { enabled: false }, autoInjectTopK: 4,
      profileBootstrap: { content: DEPLOY_PROFILE_BODY },
    })
    const preStep = listeners.find(l => l.event === 'agent/pre-step')!.listener as (
      payload: { agent: unknown; step: number },
      next: () => Promise<{ kind: 'reject' } | { kind: 'enter'; messages: unknown[] }>,
    ) => Promise<unknown>
    const writeTool = registered.find(d => d.name === 'memory_write')
    if (!writeTool) throw new Error('memory_write not registered')
    return { preStep, writeTool }
  }

  it('injects one bounded snapshot into a fresh session, then skips on a session that already has it', async () => {
    const { preStep, writeTool } = await harness()
    // seed two durable memories via the real tool (basis user-stated so they
    // are L0-eligible alongside the bootstrapped profile)
    await writeTool.execute({ content: '示例用户偏好桌面通知', basis: 'user-stated', key: 'desktop-notify' }, noExec)
    await writeTool.execute({ content: '音乐搜索走官方权威音源', basis: 'user-stated', key: 'music-source' }, noExec)

    // fresh agent: no events on the visible surface yet
    const freshAgent = { session: { surface: { nodes: [] }, events: [] } }
    const next = async () => ({ kind: 'enter' as const, messages: [] })
    const first = await preStep({ agent: freshAgent, step: 1 }, next)
    const firstEnter = first as { kind: 'enter'; messages: Array<{ content: Array<{ type: string; text: string }>; source?: { form?: string; sections?: Array<{ name: string }> } }> }
    expect(firstEnter.kind).toBe('enter')
    expect(firstEnter.messages.length).toBe(1)
    const injected = firstEnter.messages[0]
    // M1: the injected message uses the real host contract `form:'snapshot'`
    // which is the only form allowed to carry `sections`.
    expect(injected.source?.form).toBe('snapshot')
    expect(injected.source?.sections?.some(s => s.name === SNAPSHOT_FORM)).toBe(true)
    // Phase 1 fixed header (semantics frozen) — not the old English prefix.
    expect(injected.content[0].text).toContain('低优先级长期记忆背景')
    // The snapshot respects the total hard budget.
    expect(injected.content[0].text.length).toBeLessThanOrEqual(3600)
    // It carries the deployment-provided profile (L0-eligible).
    expect(injected.content[0].text).toContain('部署者明确提供的用户画像')

    // now simulate a session that already carries that snapshot (durable history)
    const seededAgent = {
      session: {
        surface: { nodes: [0] },
        events: [
          { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-global-memory', sections: [{ name: SNAPSHOT_FORM }] } } },
        ],
      },
    }
    const second = await preStep({ agent: seededAgent, step: 1 }, next)
    // decision unchanged (no new snapshot appended)
    expect(second).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not inject on step !== 1 (pre-step listener guard)', async () => {
    const { preStep } = await harness()
    const freshAgent = { session: { surface: { nodes: [] }, events: [] } }
    const next = async () => ({ kind: 'enter' as const, messages: [] })
    const result = await preStep({ agent: freshAgent, step: 2 }, next)
    expect(result).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not inject when the downstream decision rejects', async () => {
    const { preStep } = await harness()
    const freshAgent = { session: { surface: { nodes: [] }, events: [] } }
    const next = async () => ({ kind: 'reject' as const })
    const result = await preStep({ agent: freshAgent, step: 1 }, next)
    expect(result).toEqual({ kind: 'reject' })
  })
})

describe('memory_recall Phase 0 semantics', () => {
  it('recalls by keyword and respects scope filter', async () => {
    const { byName } = await runPlug()
    const write = byName('memory_write')!
    await write.execute({ content: '示例 TTS 语音合成在本地端口', scope: 'voice' }, noExec)
    await write.execute({ content: '音乐插件走官方权威音源', scope: 'music' }, noExec)
    const recall = byName('memory_recall')!
    const hit = await recall.execute({ query: 'TTS 语音合成' }, noExec) as { items: Array<{ scope?: string }> }
    expect(hit.items.length).toBeGreaterThan(0)
    expect(hit.items[0].scope).toBe('voice')
    const scoped = await recall.execute({ query: 'TTS 语音合成', scope: 'music' }, noExec) as { items: unknown[] }
    expect(scoped.items.length).toBe(0)
  })
})

describe('Phase 1 memory_write classification & source', () => {
  const execWith = (over: Record<string, unknown>) => ({ ...noExec, ...over })

  it('persists server-side source (toolCallId + sessionId) from the real exec', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    await write.execute({ content: '分类事实', key: 'classified-fact', basis: 'user-stated' }, noExec)
    const row = [...store.values()].find(r => (r as { key?: string }).key === 'classified-fact') as {
      source?: { toolCallId?: string; sessionId?: string; entrypoint?: string }
      schemaVersion?: number
      kind?: string
      basis?: string
    }
    expect(row?.source?.toolCallId).toBe('call-test-1')
    expect(row?.source?.sessionId).toBe('s-test')
    expect(row?.source?.entrypoint).toBeUndefined() // ordinary write never fabricates entrypoint
    expect(row?.schemaVersion).toBe(1)
    expect(row?.kind).toBe('fact')
    expect(row?.basis).toBe('user-stated')
  })

  it('rejects restricted BEFORE any table write or fetch', async () => {
    const { byName, store } = await runPlug({ embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' } })
    const write = byName('memory_write')!
    const before = store.size
    await expect(write.execute({ content: 'secret', sensitivity: 'restricted' }, noExec)).rejects.toThrow(/restricted/)
    expect(store.size).toBe(before) // no row added
  })

  it('rejects importance>=0.8 without writeReason', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const before = store.size
    await expect(write.execute({ content: 'high', importance: 0.8 }, noExec)).rejects.toThrow(/writeReason/)
    expect(store.size).toBe(before)
  })

  it('rejects a reserved key with conflicting kind', async () => {
    const { byName } = await runPlug()
    const write = byName('memory_write')!
    await expect(write.execute({ content: 'x', key: 'agent-memory-profile', kind: 'fact' }, noExec)).rejects.toThrow(/requires kind=profile/)
  })

  it('rejects over-kind-cap content', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const before = store.size
    await expect(write.execute({ content: 'x'.repeat(801), kind: 'fact' }, noExec)).rejects.toThrow(/limit of 800/)
    expect(store.size).toBe(before)
    // project-summary allows 1200
    const ok = await write.execute({ content: 'y'.repeat(1200), kind: 'project-summary' }, noExec)
    expect((ok as { created: boolean }).created).toBe(true)
  })

  describe('per-kind write caps through the tool execution path (M6)', () => {
    const caps: Array<[string, number]> = [
      ['profile', 900], ['agent-self', 700], ['preference', 800], ['fact', 800],
      ['project-summary', 1200], ['reference', 800],
    ]
    it.each(caps)('kind=%s: exactly cap succeeds, cap+1 is rejected', async (kind, cap) => {
      const { byName, store } = await runPlug()
      const write = byName('memory_write')!
      // exactly the cap succeeds
      const ok = await write.execute({ content: 'a'.repeat(cap), kind }, noExec)
      expect((ok as { created: boolean }).created).toBe(true)
      // cap+1 rejected and table unchanged
      const before = store.size
      await expect(write.execute({ content: 'b'.repeat(cap + 1), kind }, noExec)).rejects.toThrow(new RegExp(`limit of ${cap}`))
      expect(store.size).toBe(before)
    })
  })

  it('restricted: zero table write AND zero network request even when embedding is enabled (M6)', async () => {
    const calls: unknown[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((...a: unknown[]) => { calls.push(a); return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 })) }) as typeof fetch
    try {
      const { byName, store } = await runPlug({ embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 1024 } })
      const write = byName('memory_write')!
      const before = store.size
      await expect(write.execute({ content: 'secret', sensitivity: 'restricted' }, noExec)).rejects.toThrow(/restricted/)
      expect(store.size).toBe(before) // zero table write
      expect(calls.length).toBe(0) // zero network request
    } finally {
      globalThis.fetch = original
    }
  })

  it('carries classification/source/writeReason onto refresh and supersede current writes', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    await write.execute({ content: '事实 v1', key: 'k1', basis: 'user-stated', importance: 0.9, writeReason: 'approved', kind: 'fact' }, noExec)
    const v1 = [...store.values()].find(r => (r as { key?: string }).key === 'k1') as {
      writeReason?: string; basis?: string; source?: { toolCallId?: string }
    }
    expect(v1.writeReason).toBe('approved')
    expect(v1.basis).toBe('user-stated')
    expect(v1.source?.toolCallId).toBe('call-test-1')
    // write the same key again with different content + a new exec callId.
    // Content differs → either refresh (created:false) or supersede (new active
    // row, created:true); EITHER way the current active record for key k1 must
    // carry the LATEST write's classification/source/reason.
    await write.execute({ content: '事实 v2 updated', key: 'k1', basis: 'user-stated', importance: 0.9, writeReason: 'reviewed', kind: 'fact' }, execWith({ callId: 'call-test-2' }))
    const activeK1 = [...store.values()].filter(r => (r as { key?: string }).key === 'k1' && (r as { supersededBy?: unknown }).supersededBy === undefined)
    expect(activeK1.length).toBe(1)
    const cur = activeK1[0] as { writeReason?: string; content?: string; source?: { toolCallId?: string } }
    expect(cur.writeReason).toBe('reviewed')
    expect(cur.source?.toolCallId).toBe('call-test-2')
    expect(cur.content).toBe('事实 v2 updated')
  })

  it('requires a real callId (no silent undefined source)', async () => {
    const { byName } = await runPlug()
    const write = byName('memory_write')!
    await expect(write.execute({ content: 'x' }, { agent: { session: { id: 's' } }, callId: undefined })).rejects.toThrow(/callId/)
  })

  it('refresh does not retain a stale writeReason from the previous write (M5)', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const writeKey = 'reason-replace'
    // first write: high importance, reason provided (exact same content+key+value
    // so second write refreshes rather than supersedes)
    const v1 = await write.execute({ content: '稳定事实', key: writeKey, kind: 'fact', basis: 'user-stated', importance: 0.9, writeReason: 'approved v1', value: 'v1' }, noExec)
    expect((v1 as { created: boolean }).created).toBe(true)
    // second write: same key + same value → refresh (created:false); no reason this time
    const v2 = await write.execute({ content: '稳定事实', key: writeKey, kind: 'fact', basis: 'user-stated', importance: 0.5, value: 'v1' }, noExec)
    expect((v2 as { created: boolean }).created).toBe(false)
    const current = [...store.values()].find(r => (r as { key?: string }).key === writeKey && (r as { supersededBy?: unknown }).supersededBy === undefined) as { writeReason?: string; importance?: number }
    expect(current.writeReason).toBeUndefined() // old reason not inherited
    expect(current.importance).toBe(0.5)
  })

  it('refresh omitting importance+reason never leaves high-importance-without-reason (R2)', async () => {
    const { byName, store } = await runPlug()
    const write = byName('memory_write')!
    const writeKey = 'invariant'
    // first write: importance=0.9 + reason
    await write.execute({ content: '不变式事实', key: writeKey, kind: 'fact', basis: 'user-stated', importance: 0.9, writeReason: 'needed', value: 'v1' }, noExec)
    // refresh omitting BOTH importance and reason (same content+key+value → refresh)
    const v2 = await write.execute({ content: '不变式事实', key: writeKey, kind: 'fact', basis: 'user-stated', value: 'v1' }, noExec)
    expect((v2 as { created: boolean }).created).toBe(false)
    const current = [...store.values()].find(r => (r as { key?: string }).key === writeKey && (r as { supersededBy?: unknown }).supersededBy === undefined) as { writeReason?: string; importance?: number }
    // both stripped: no stale importance, no stale reason → invariant holds
    expect(current.importance).toBeUndefined()
    expect(current.writeReason).toBeUndefined()
    if (current.importance !== undefined && current.importance >= 0.8) {
      expect(current.writeReason).toBeTruthy()
    }
  })
})

describe('Phase 1 profile bootstrap (deployment opt-in, M1)', () => {
  const DEPLOY_PROFILE_BODY = '部署者明确提供的用户画像：偏好简洁回复，重要事项主动通知。'

  it('does NOT create a profile when profileBootstrap is not configured (public default)', async () => {
    const { store } = await runPlug({}) // no profileBootstrap
    expect([...store.values()].some(r => (r as { key?: string }).key === 'agent-memory-profile')).toBe(false)
  })

  it('creates exactly one active profile on first apply, and keeps it across re-apply', async () => {
    const { ctx, store } = makeCtx()
    const cfg = { embedding: { enabled: false }, profileBootstrap: { content: DEPLOY_PROFILE_BODY } }
    await apply(ctx, cfg)
    await apply(ctx, cfg) // second open
    const profiles = [...store.values()].filter(r => (r as { key?: string }).key === 'agent-memory-profile')
    expect(profiles.length).toBe(1)
    const p = profiles[0] as {
      content?: string; kind?: string; basis?: string; sensitivity?: string; importance?: number
      writeReason?: string; source?: { entrypoint?: string }; schemaVersion?: number
    }
    expect(p.content).toBe(DEPLOY_PROFILE_BODY)
    expect(p.kind).toBe('profile')
    expect(p.basis).toBe('user-stated')
    expect(p.sensitivity).toBe('normal')
    expect(p.importance).toBe(1)
    expect(p.writeReason).toBe('user-approved profile bootstrap')
    const source = p.source as { entrypoint?: string; toolCallId?: string; sessionId?: string } | undefined
    expect(source?.entrypoint).toBe('profile-bootstrap')
    expect(source?.toolCallId).toBeUndefined() // no tool call
    expect(source?.sessionId).toBeUndefined()
    expect(p.schemaVersion).toBe(1)
  })

  it('does not create a profile for blank/whitespace content', async () => {
    const { store } = await runPlug({ profileBootstrap: { content: '   ' } })
    expect([...store.values()].some(r => (r as { key?: string }).key === 'agent-memory-profile')).toBe(false)
  })

  it('does not touch agent-memory-self during bootstrap', async () => {
    const { store } = await runPlug({ profileBootstrap: { content: DEPLOY_PROFILE_BODY } })
    expect([...store.values()].some(r => (r as { key?: string }).key === 'agent-memory-self')).toBe(false)
  })

  it('does not overwrite an existing active profile (bootstrap skips when present)', async () => {
    const { ctx, registered, store } = makeCtx()
    const cfg = { embedding: { enabled: false }, profileBootstrap: { content: DEPLOY_PROFILE_BODY } }
    await apply(ctx, cfg)
    const write = registered.find(d => d.name === 'memory_write')!
    // user updates the profile in place (Phase 2 keyed semantics: same physical
    // record, created:false — bootstrap's job is simply to not recreate)
    const created = await write.execute({ content: '自定义画像 v2', key: 'agent-memory-profile', basis: 'user-stated', importance: 0.9, writeReason: 'user updated' }, noExec)
    expect((created as { created: boolean }).created).toBe(false)
    await apply(ctx, cfg) // re-apply must not recreate
    const profiles = [...store.values()].filter(r => (r as { key?: string }).key === 'agent-memory-profile')
    // exactly one physical profile row; bootstrap did not overwrite the user's content.
    expect(profiles.length).toBe(1)
    expect((profiles[0] as { content: string }).content).toBe('自定义画像 v2')
  })

  it('rejects a non-string profileBootstrap.content with zero writes (R3)', async () => {
    const { ctx, store } = makeCtx()
    const before = store.size
    await expect(apply(ctx, {
      embedding: { enabled: false },
      profileBootstrap: { content: 123 as unknown as string },
    })).rejects.toThrow(/must be a non-empty string/)
    expect(store.size).toBe(before)
  })

  it('rejects an over-900 profileBootstrap.content with zero writes (R3)', async () => {
    const { ctx, store } = makeCtx()
    const before = store.size
    await expect(apply(ctx, {
      embedding: { enabled: false },
      profileBootstrap: { content: 'p'.repeat(901) },
    })).rejects.toThrow(/exceeds the profile limit of 900/)
    expect(store.size).toBe(before)
  })

  it('accepts exactly 900 chars of profileBootstrap.content (R3 boundary)', async () => {
    const { ctx, store } = makeCtx()
    await apply(ctx, {
      embedding: { enabled: false },
      profileBootstrap: { content: 'p'.repeat(900) },
    })
    const profiles = [...store.values()].filter(r => (r as { key?: string }).key === 'agent-memory-profile')
    expect(profiles.length).toBe(1)
    expect((profiles[0] as { content: string }).content).toHaveLength(900)
  })
})

describe('Phase 1 embedding default-off & no fetch on restricted/disabled', () => {
  it('public patch model: embedding enabled must be false (see cordis.patch.yml) — no fetch in write when disabled', async () => {
    const calls: unknown[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((...a: unknown[]) => { calls.push(a); return Promise.resolve(new Response('{}', { status: 200 })) }) as typeof fetch
    try {
      const { byName } = await runPlug({ embedding: { enabled: false } })
      const write = byName('memory_write')!
      await write.execute({ content: 'no fetch please', basis: 'user-stated' }, noExec)
      expect(calls.length).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })
})
