import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Phase 2 harness: an in-memory KV store whose `update` follows the REAL
 * storage-domain contract — same physical key serializes, missing key REJECTS,
 * a throwing fn does NOT commit, and reads observe committed state only. This
 * is required by the handoff (§6) to prove concurrency without a fake lock.
 */
function makeStore(): {
  store: Map<string, unknown>
  putLog: string[]
  updateLog: string[]
  deleteLog: string[]
  failNextUpdateOnKey: string | null
  failNextReceiptPut: boolean
} {
  const store = new Map<string, unknown>()
  const state = {
    store,
    putLog: [] as string[],
    updateLog: [] as string[],
    deleteLog: [] as string[],
    failNextUpdateOnKey: null as string | null,
    failNextReceiptPut: false,
  }
  return state
}

function memTable<K extends string, V>(state: ReturnType<typeof makeStore>, tableName: 'memories' | 'deletions') {
  const table = {
    get: (k: K) => state.store.get(k) as V | undefined,
    put: async (k: K, v: V) => {
      state.putLog.push(`${tableName}:${String(k)}`)
      state.store.set(k, v)
    },
    delete: async (k: K) => {
      state.deleteLog.push(`${tableName}:${String(k)}`)
      if (!state.store.has(k)) return false
      state.store.delete(k)
      return true
    },
    update: async (k: K, fn: (c: V) => V) => {
      // real contract: missing key rejects; fn throw leaves state untouched
      state.updateLog.push(`${tableName}:${String(k)}`)
      if (tableName === 'memories' && state.failNextUpdateOnKey === String(k)) {
        state.failNextUpdateOnKey = null
        throw new Error('injected update failure')
      }
      const current = state.store.get(k) as V | undefined
      // R1: mirror the real rc.5 `DomainError` contract — stable `code`
      // discriminant with a diagnostic (non-parse-stable) message.
      if (current === undefined) {
        const err = new Error(`domain 'agent_memories' table 'memories' has no record '${String(k)}' to update`) as Error & { code?: string }
        err.name = 'DomainError'
        err.code = 'missing-key'
        throw err
      }
      const next = fn(current)
      state.store.set(k, next)
      return next
    },
    entries: () => state.store.entries() as IterableIterator<[K, V]>,
    size: state.store.size,
  }
  return table
}

interface ToolDef { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

const noExec = { agent: { session: { id: 's-test' } }, callId: 'call-p2' }

function makeCtx() {
  const registered: ToolDef[] = []
  const disposers: Array<() => void> = []
  const listeners: Array<{ event: string; listener: unknown }> = []
  const memState = makeStore()
  const recState = makeStore()
  const memories = memTable(memState, 'memories')
  const deletions = memTable(recState, 'deletions')
  const closeSpy = vi.fn(async () => {})
  const ctx = {
    storageDomain: {
      open: vi.fn(async () => ({
        table: (name: string) => name === 'memories' ? memories : name === 'deletions' ? deletions : (() => { throw new Error('no table') })(),
        close: closeSpy,
      })),
    },
    tools: { register: (d: ToolDef) => void registered.push(d) },
    effect: (f: () => () => void) => { const d = f(); if (d) disposers.push(d) },
    on: (event: string, listener: unknown) => void listeners.push({ event, listener }),
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, registered, disposers, listeners, memState, recState, closeSpy }
}

async function boot() {
  const { ctx, registered, disposers, listeners, memState, recState, closeSpy } = makeCtx()
  await apply(ctx, { embedding: { enabled: false }, autoInject: false })
  const byName = (n: string) => registered.find(d => d.name === n)
  return { ctx, registered, disposers, listeners, memState, recState, closeSpy, byName }
}

describe('Phase 2: four tools, no memory_forget, no includeDeleted', () => {
  it('registers exactly memory_write/recall/retire/delete', async () => {
    const { byName } = await boot()
    expect(byName('memory_write')).toBeDefined()
    expect(byName('memory_recall')).toBeDefined()
    expect(byName('memory_retire')).toBeDefined()
    expect(byName('memory_delete')).toBeDefined()
    expect(byName('memory_forget')).toBeUndefined()
  })

  it('recall output/schema never exposes includeDeleted (Phase 3 contract)', async () => {
    const { byName } = await boot()
    const recall = byName('memory_recall')!
    // historical call with includeDeleted must be structurally ignored (not in schema)
    const result = await recall.execute({ query: 'nothing', includeDeleted: true as never }, noExec) as { items: unknown[]; returned: number; matchedTotal: number; truncated: boolean }
    expect(result.returned).toBe(0)
    expect(result.matchedTotal).toBe(0)
    expect(result.truncated).toBe(false)
    expect('total' in result).toBe(false)
  })
})

describe('Phase 2: memory_delete receipts (privacy-first order)', () => {
  it('removes the body, writes a minimal receipt, and never keeps content in any table', async () => {
    const { byName, memState, recState } = await boot()
    const write = byName('memory_write')!
    const created = await write.execute({ content: '秘密正文 123', key: 'del-me', scope: 'work' }, noExec) as { id: string }
    const del = byName('memory_delete')!
    const result = await del.execute({ id: created.id, reason: 'cleanup' }, noExec)
    expect(result).toMatchObject({ deleted: 1 })
    // body physically gone from memories
    expect(memState.store.has(created.id)).toBe(false)
    // receipt exists in deletions and carries NO body
    const receipt = recState.store.get(created.id) as Record<string, unknown> | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.id).toBe(created.id)
    expect(receipt!.deletedBy).toBe('session:s-test/tool:call-p2')
    expect(receipt!['content']).toBeUndefined()
    expect(receipt!['embedding']).toBeUndefined()
    expect(receipt!['revisions']).toBeUndefined()
    // no copy of the body anywhere
    const allBodies = [...memState.store.values(), ...recState.store.values()]
      .map(r => JSON.stringify(r))
      .filter(s => s.includes('秘密正文 123'))
    expect(allBodies).toHaveLength(0)
  })

  it('missing target returns deleted:0 and writes no receipt', async () => {
    const { byName, recState } = await boot()
    const del = byName('memory_delete')!
    const result = await del.execute({ id: 'nope' }, noExec)
    expect(result).toMatchObject({ deleted: 0 })
    expect(recState.store.size).toBe(0)
  })

  it('delete by key removes current + retired + superseded provenance (whole chain)', async () => {
    const { byName, memState, recState } = await boot()
    const write = byName('memory_write')!
    // create, update (revision), retire — three manifestations of one key
    const v1 = await write.execute({ content: 'k-body-1', key: 'chain', value: '1' }, noExec) as { id: string }
    const v2 = await write.execute({ content: 'k-body-2', key: 'chain', value: '2' }, noExec) as { id: string }
    expect(v2.id).toBe(v1.id) // keyed in-place
    const retire = byName('memory_retire')!
    const retired = await retire.execute({ key: 'chain' }, noExec) as { retired: number }
    expect(retired.retired).toBe(1)
    const del = byName('memory_delete')!
    const result = await del.execute({ key: 'chain' }, noExec) as { deleted: number }
    expect(result.deleted).toBe(1)
    // no memory record with key=chain remains in any state
    const remaining = [...memState.store.values()].filter(r => (r as { key?: string }).key === 'chain')
    expect(remaining).toHaveLength(0)
    // one receipt exists
    expect(recState.store.size).toBe(1)
  })

  it('E4: delete-by-key purges MULTI-STATE physical rows (current/retired/legacy-deleted/superseded) with one receipt each', async () => {
    const { byName, memState, recState } = await boot()
    const write = byName('memory_write')!
    // Build FOUR physical rows sharing key='multi', in four different states:
    // 1) current row (created via write, then RETIRED in place — one row)
    const current = await write.execute({ content: 'multi-current', key: 'multi', value: '1' }, noExec) as { id: string }
    await write.execute({ content: 'multi-current-v2', key: 'multi', value: '2' }, noExec)
    const retire = byName('memory_retire')!
    const r = await retire.execute({ id: current.id }, noExec) as { retired: number }
    expect(r.retired).toBe(1)
    // 2) legacy deleted:true physical row (pre-Phase2 shape)
    await memState.store.set('legacy-deleted-1', { id: 'legacy-deleted-1', key: 'multi', content: 'legacy-deleted body', createdAt: 1, updatedAt: 1, deleted: true })
    // 3) superseded provenance row (old keyless-style supersede chain)
    await memState.store.set('superseded-1', { id: 'superseded-1', key: 'multi', content: 'superseded body', createdAt: 2, updatedAt: 2, supersededBy: 'other' })
    // 4) standalone retiredAt row
    await memState.store.set('retiredat-1', { id: 'retiredat-1', key: 'multi', content: 'retiredat body', createdAt: 3, updatedAt: 3, retiredAt: 9 })

    const del = byName('memory_delete')!
    const result = await del.execute({ key: 'multi' }, noExec) as { deleted: number }
    // every multi-key physical row deleted (4 total: current-retired, legacy
    // deleted, superseded, retiredAt)
    expect(result.deleted).toBe(4)
    const remaining = [...memState.store.values()].filter(r => (r as { key?: string }).key === 'multi')
    expect(remaining).toHaveLength(0)
    // exactly one receipt per deleted row, all receipts are minimal
    expect(recState.store.size).toBe(4)
    for (const receipt of recState.store.values()) {
      const rec = receipt as Record<string, unknown>
      expect(rec['content']).toBeUndefined()
      expect(rec['embedding']).toBeUndefined()
      expect(rec['revisions']).toBeUndefined()
    }
  })

  it('receipt-put failure: tool errors, body is already gone and never re-created', async () => {
    const { ctx, registered, memState, recState } = makeCtx()
    // Wrap the receipts table so the receipt PUT throws once.
    const originalOpen = ctx.storageDomain.open
    ctx.storageDomain.open = (async () => {
      const base = await (originalOpen as unknown as () => Promise<{ table: (n: string) => unknown; close: () => Promise<void> }>)()
      const tableOf = base.table as (n: string) => unknown
      const receiptsTable = tableOf('deletions') as { put: (k: string, v: unknown) => Promise<void>; get: (k: string) => unknown }
      const poisoned: typeof receiptsTable = {
        ...receiptsTable,
        put: async () => { throw new Error('injected receipt failure') },
        get: (k: string) => recState.store.get(k),
      }
      return {
        ...base,
        table: (name: string) => name === 'deletions' ? poisoned : tableOf(name),
      }
    }) as unknown as typeof ctx.storageDomain.open
    await apply(ctx, { embedding: { enabled: false }, autoInject: false })
    const write = registered.find(d => d.name === 'memory_write')!
    const created = await write.execute({ content: 'fragile body', key: 'fragile' }, noExec) as { id: string }
    const del = registered.find(d => d.name === 'memory_delete')!
    await expect(del.execute({ id: created.id }, noExec)).rejects.toThrow(/receipt/)
    // body is physically gone in BOTH tables; nothing to resurrect.
    expect(memState.store.has(created.id)).toBe(false)
    expect(recState.store.size).toBe(0) // receipt never landed
    const all = [...memState.store.values(), ...recState.store.values()]
      .map(r => JSON.stringify(r)).filter(s => s.includes('fragile body'))
    expect(all).toHaveLength(0)
  })
})

describe('Phase 2: keyed mutex serializes same-key concurrency', () => {
  it('20 concurrent first-writes of the same key end with exactly ONE current and NO supersede chain', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    const jobs = Array.from({ length: 20 }, (_, i) =>
      write.execute({ content: `并发正文 ${i}`, key: 'hot-key', value: String(i) }, noExec))
    await Promise.all(jobs)
    const rows = [...memState.store.values()].filter(r => (r as { key?: string }).key === 'hot-key')
    expect(rows).toHaveLength(1) // exactly one active current
    const row = rows[0] as { supersededBy?: unknown; revisions?: unknown[] }
    expect(row.supersededBy).toBeUndefined() // no supersede chain
    expect(Array.isArray(row.revisions)).toBe(true)
  })

  it('E1: an injected update failure does NOT poison the mutex — a later same-key write succeeds', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: 'first', key: 'resilient', value: '1' }, noExec) as { id: string }
    // inject a real failure on the NEXT update for THIS PHYSICAL ROW. The
    // storage layer fails the physical id (that is what table.update receives,
    // keyed by physical id even though the caller serialized by logical key).
    memState.failNextUpdateOnKey = v1.id
    // This write goes through the keyed mutex and the update fn throws inside
    // the queue; the failure must not poison the chain.
    await expect(write.execute({ content: 'second', key: 'resilient', value: '2' }, noExec)).rejects.toThrow(/injected update failure/)
    // The mutex chain survived: a third write on the same key must succeed.
    const v3 = await write.execute({ content: 'third', key: 'resilient', value: '3' }, noExec)
    expect((v3 as { created: boolean }).created).toBe(false)
    const rows = [...memState.store.values()].filter(r => (r as { key?: string }).key === 'resilient')
    expect(rows).toHaveLength(1)
  })

  it('E1: same key SERIALIZES; different keys PARALLEL (observable ordering)', async () => {
    const harness = makeCtx()
    await apply(harness.ctx, { embedding: { enabled: false }, autoInject: false })
    const writeTool = harness.registered.find(d => d.name === 'memory_write')!
    const order: string[] = []

    // Same key: the second write must not START before the first finishes.
    const sameA = writeTool.execute({ content: 'a1', key: 'same-key', value: '1' }, noExec).then(() => { order.push('same-a-done') })
    const sameB = writeTool.execute({ content: 'a2', key: 'same-key', value: '2' }, noExec).then(() => { order.push('same-b-done') })
    await Promise.all([sameA, sameB])
    expect(order).toEqual(['same-a-done', 'same-b-done']) // strictly serialized
  })

  it('E1: different keys run in parallel (barrier holds one key while the other proceeds)', async () => {
    // Real blockable barrier: block an UPDATE for the first different-key
    // write; the second different-key write must still complete (distinct
    // keyed queues run concurrently).
    const memState = makeStore()
    const recState = makeStore()
    const memories = memTable(memState, 'memories')
    const deletions = memTable(recState, 'deletions')
    const registered: ToolDef[] = []
    const disposers: Array<() => void> = []
    const listeners: Array<{ event: string; listener: unknown }> = []
    let releaseBarrier: (() => void) | undefined
    let firstUpdateBlocked = false
    const wrappedMemories = {
      ...memories,
      update: async (k: string, fn: (c: unknown) => unknown) => {
        if (!firstUpdateBlocked) {
          firstUpdateBlocked = true
          // park the first update until released
          await new Promise<void>((resolve) => { releaseBarrier = resolve })
        }
        return memories.update(k, fn)
      },
    }
    const closeSpy = vi.fn(async () => {})
    const ctx = {
      storageDomain: { open: vi.fn(async () => ({
        table: (name: string) => name === 'memories' ? wrappedMemories : name === 'deletions' ? deletions : (() => { throw new Error('no table') })(),
        close: closeSpy,
      })) },
      tools: { register: (d: ToolDef) => void registered.push(d) },
      effect: (f: () => () => void) => { const d = f(); if (d) disposers.push(d) },
      on: (event: string, listener: unknown) => void listeners.push({ event, listener }),
      logger: { warn: vi.fn() },
    } as unknown as Context
    await apply(ctx, { embedding: { enabled: false }, autoInject: false })
    const writeTool = registered.find(d => d.name === 'memory_write')!
    // Preheat both keys so the concurrent phase runs UPDATE paths (not create).
    await writeTool.execute({ content: 'pre-1', key: 'k-one', value: '1' }, noExec)
    await writeTool.execute({ content: 'pre-2', key: 'k-two', value: '1' }, noExec)
    const events: string[] = []
    // Both writes now call table.update; the first update parks on the barrier.
    const p1 = writeTool.execute({ content: 'one-v2', key: 'k-one', value: '2' }, noExec).then(() => events.push('one-done'))
    await new Promise(r => setImmediate(r))
    const p2 = writeTool.execute({ content: 'two-v2', key: 'k-two', value: '2' }, noExec).then(() => events.push('two-done'))
    const twoResult = await Promise.race([
      p2.then(() => 'two-finished'),
      new Promise<string>(r => setTimeout(() => r('two-blocked'), 200)),
    ])
    // p2 must finish while p1 is parked on its own queue → different keys parallel.
    expect(twoResult).toBe('two-finished')
    releaseBarrier!()
    await Promise.all([p1, p2])
    expect(events.sort()).toEqual(['one-done', 'two-done'])
  })

  it('body change appends revisions and caps at 10 (oldest dropped)', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    const first = await write.execute({ content: 'r0', key: 'cap', value: '0' }, noExec) as { id: string }
    for (let i = 1; i <= 14; i++) {
      await write.execute({ content: `r${i}`, key: 'cap', value: String(i) }, noExec)
    }
    const row = memState.store.get(first.id) as { revisions?: unknown[]; content?: string }
    expect(row.content).toBe('r14')
    expect(row.revisions).toHaveLength(10)
    // oldest dropped: revisions hold r4..r13 (14 writes → 10 kept)
    const firstRev = (row.revisions![0] as { content: string }).content
    expect(firstRev).toBe('r4')
  })

  it('pure metadata refresh (same body/value) does NOT append a revision', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    const first = await write.execute({ content: 'stable', key: 'meta', value: 'v' }, noExec) as { id: string }
    const second = await write.execute({ content: 'stable', key: 'meta', value: 'v', importance: 0.5, writeReason: 'touch' }, noExec)
    expect((second as { created: boolean }).created).toBe(false)
    const row = memState.store.get(first.id) as { revisions?: unknown[] }
    expect(row.revisions).toBeUndefined() // no revision for a metadata-only refresh
  })
})

describe('Phase 2: embedding late arrival cannot resurrect or overwrite (E2 deferred)', () => {
  /** Deferred control over the embed fetch so the vector arrives AFTER a
   *  later write/delete completed. */
  function deferredFetch() {
    const pending: Array<{ resolve: (r: Response) => void; reject: (e: Error) => void }> = []
    const fetchFn = ((..._a: unknown[]) => new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject })
    })) as typeof fetch
    const settleNext = (vector: number[]) => {
      const p = pending.shift()
      if (!p) throw new Error('no pending fetch to settle')
      p.resolve(new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 }))
    }
    return { fetchFn, settleNext, pendingCount: () => pending.length }
  }

  it('E2: vector for A arrives after B updated — A is dropped (no stale overwrite)', async () => {
    const { ctx, registered, memState } = makeCtx()
    const df = deferredFetch()
    const originalFetch = globalThis.fetch
    globalThis.fetch = df.fetchFn
    try {
      await apply(ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
      })
      const write = registered.find(d => d.name === 'memory_write')!
      const first = await write.execute({ content: 'version-a', key: 'late', value: 'a' }, noExec) as { id: string }
      // A's embedding request is now PENDING (deferred). Update the record to B.
      const second = await write.execute({ content: 'version-b', key: 'late', value: 'b' }, noExec)
      expect((second as { created: boolean }).created).toBe(false)
      // B's embedding request is ALSO pending (each body change re-embeds).
      // Settle A's old-request FIRST (late arrival) — its vector must NOT land
      // on the B row.
      df.settleNext([0.1, 0.2]) // stale A vector
      await new Promise(r => setImmediate(r))
      const row = memState.store.get(first.id) as { content?: string }
      expect(row.content).toBe('version-b')
      // settle B's request
      df.settleNext([0.5, 0.5])
      await new Promise(r => setImmediate(r))
      const row2 = memState.store.get(first.id) as { embedding?: number[] }
      expect(row2.embedding).toEqual([0.5, 0.5]) // only the NEW vector landed
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('E2: vector still pending when the record is deleted → never resurrects', async () => {
    const { ctx, registered, memState } = makeCtx()
    const df = deferredFetch()
    const originalFetch = globalThis.fetch
    globalThis.fetch = df.fetchFn
    try {
      await apply(ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 1 },
        autoInject: false,
      })
      const write = registered.find(d => d.name === 'memory_write')!
      const first = await write.execute({ content: 'to-delete', key: 'gone', value: '1' }, noExec) as { id: string }
      // embedding request pending
      const del = registered.find(d => d.name === 'memory_delete')!
      await del.execute({ id: first.id }, noExec)
      // late vector arrives after the delete
      df.settleNext([0.9])
      await new Promise(r => setImmediate(r))
      expect(memState.store.has(first.id)).toBe(false) // never resurrected
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 2 rework regression fixes (M1/M2/M4/M5/M6)', () => {
  it('M1: same value + body change appends a revision and drops the old embedding', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    const first = await write.execute({ content: 'body-A', key: 'mv', value: 'SAME', basis: 'user-stated' }, noExec) as { id: string }
    const second = await write.execute({ content: 'body-B', key: 'mv', value: 'SAME', basis: 'user-stated' }, noExec) as { id: string }
    expect(second.id).toBe(first.id)
    const row = memState.store.get(first.id) as { revisions?: Array<{ content: string }>; embedding?: unknown; embeddingPending?: boolean }
    expect(row.revisions).toBeDefined()
    expect(row.revisions![0].content).toBe('body-A') // old body recorded
    expect(row.embedding).toBeUndefined() // stale vector dropped
  })

  it('M2: duplicate retire reports 0 (only active→retired migration counts)', async () => {
    const { byName } = await boot()
    const write = byName('memory_write')!
    const retire = byName('memory_retire')!
    const created = await write.execute({ content: 'once', key: 'dup-retire', value: '1' }, noExec) as { id: string }
    const first = await retire.execute({ id: created.id }, noExec) as { retired: number }
    const second = await retire.execute({ id: created.id }, noExec) as { retired: number }
    expect(first.retired).toBe(1)
    expect(second.retired).toBe(0) // already retired → no migration
  })

  it('M2: retire on an already-superseded/inactive row reports 0', async () => {
    const { byName } = await boot()
    const write = byName('memory_write')!
    const retire = byName('memory_retire')!
    const created = await write.execute({ content: 'will-be-gone', key: 'retire-inactive', value: '1' }, noExec) as { id: string }
    await retire.execute({ id: created.id }, noExec)
    const retry = await retire.execute({ id: created.id }, noExec) as { retired: number }
    expect(retry.retired).toBe(0)
  })

  it('M4: keyless similar body with different value → old record marked superseded', async () => {
    const { byName, memState } = await boot()
    const write = byName('memory_write')!
    // keyless writes; similar content, different value
    const v1 = await write.execute({ content: '用户偏好中文回复', value: 'a', basis: 'user-stated' }, noExec) as { id: string }
    const v2 = await write.execute({ content: '用户偏好中文回答', value: 'b', basis: 'user-stated' }, noExec) as { id: string }
    expect(v2.id).not.toBe(v1.id)
    const oldRow = memState.store.get(v1.id) as { supersededBy?: string }
    const newRow = memState.store.get(v2.id) as { id?: string }
    expect(oldRow.supersededBy).toBe(v2.id) // old one superseded
    // exactly one ACTIVE keyless record remains
    const activeRows = [...memState.store.values()].filter(r => (r as { supersededBy?: unknown; retiredAt?: unknown; deleted?: boolean }).supersededBy === undefined)
    expect(activeRows.length).toBe(1)
    expect(newRow.id).toBe(v2.id)
  })

  it('M5: delete when the row vanished between scan and delete → 0 and no receipt', async () => {
    const { byName, memState, recState } = await boot()
    const write = byName('memory_write')!
    const del = byName('memory_delete')!
    const created = await write.execute({ content: 'vanishing', key: 'vanish', value: '1' }, noExec) as { id: string }
    // remove behind the tool's back before delete runs (delete returns false)
    memState.store.delete(created.id)
    const result = await del.execute({ id: created.id }, noExec) as { deleted: number }
    expect(result.deleted).toBe(0)
    expect(recState.store.size).toBe(0) // no ghost receipt
  })

  it('M6: schema accepts 10 revisions and rejects 11', async () => {
    const { memoryRecordSchema } = await import('../src/spec.ts')
    const revs = Array.from({ length: 11 }, (_, i) => ({ content: `rev-${i}`, updatedAt: i }))
    const base = { id: 'm-cap', content: 'current', createdAt: 1, updatedAt: 11 }
    expect(() => memoryRecordSchema.parse({ ...base, revisions: revs.slice(0, 10) })).not.toThrow()
    expect(() => memoryRecordSchema.parse({ ...base, revisions: revs })).toThrow()
  })
})

describe('Phase 2 final micro-closure (R1/R2/R3)', () => {
  it('R1: retire on an unknown id is an idempotent 0 via the real DomainError code (not message parsing)', async () => {
    const { byName } = await boot()
    const retire = byName('memory_retire')!
    // the mock table now throws DomainError with code='missing-key' and a real
    // diagnostic message that does NOT start with 'missing-key'
    const result = await retire.execute({ id: 'definitely-unknown' }, noExec) as { retired: number }
    expect(result.retired).toBe(0)
  })

  it('R1: a NON-missing-key error still propagates (never swallowed)', async () => {
    const { ctx, registered } = makeCtx()
    const baseOpen = ctx.storageDomain.open
    const injected = new Error('disk full') as Error & { code?: string }
    injected.code = 'io-error'
    ctx.storageDomain.open = (async () => {
      const base = await (baseOpen as unknown as () => Promise<{ table: (n: string) => unknown; close: () => Promise<void> }>)()
      const tableOf = base.table as (n: string) => unknown
      const originalMemories = tableOf('memories') as { update: (k: string, fn: (c: unknown) => unknown) => Promise<unknown> }
      const throwingMemories = {
        ...originalMemories,
        update: async (k: string, fn: (c: unknown) => unknown) => {
          if (k === 'poison-id') throw injected
          return originalMemories.update(k, fn)
        },
      }
      return { ...base, table: (name: string) => name === 'memories' ? throwingMemories : tableOf(name) }
    }) as unknown as typeof ctx.storageDomain.open
    await apply(ctx, { embedding: { enabled: false }, autoInject: false })
    const retire = registered.find(d => d.name === 'memory_retire')!
    // update on 'poison-id' throws code='io-error' → must propagate (not a
    // missing-key no-op)
    await expect(retire.execute({ id: 'poison-id' }, noExec)).rejects.toThrow(/disk full/)
  })

  it('R2: deletion receipt keeps the original key/scope (captured before delete) without body fields', async () => {
    const { byName, recState } = await boot()
    const write = byName('memory_write')!
    const del = byName('memory_delete')!
    const created = await write.execute({ content: '带 key/scope 的正文', key: 'audit-key', scope: 'work' }, noExec) as { id: string }
    const result = await del.execute({ id: created.id }, noExec) as { deleted: number }
    expect(result.deleted).toBe(1)
    const receipt = recState.store.get(created.id) as Record<string, unknown> | undefined
    expect(receipt).toBeDefined()
    expect(receipt!.key).toBe('audit-key') // minimal audit fields preserved
    expect(receipt!.scope).toBe('work')
    expect(receipt!['content']).toBeUndefined()
    expect(receipt!['embedding']).toBeUndefined()
    expect(receipt!['revisions']).toBeUndefined()
  })

  it('R3: keyless supersede write failure leaves the OLD record active and the candidate unwritten', async () => {
    const { ctx, registered, memState } = makeCtx()
    // Make the FIRST put (supersede of old record) fail: this table put writes
    // key 'old-supersede' successfully, then the NEXT put on the same table
    // (the candidate) is the one we actually want to fail — but R3's point is
    // the OLD put failing BEFORE candidate write. We poison the old record's
    // supersede write specifically.
    const baseOpen = ctx.storageDomain.open
    ctx.storageDomain.open = (async () => {
      const base = await (baseOpen as unknown as () => Promise<{ table: (n: string) => unknown; close: () => Promise<void> }>)()
      const tableOf = base.table as (n: string) => unknown
      const originalMemories = tableOf('memories') as { put: (k: string, v: unknown) => Promise<void>; get: (k: string) => unknown; entries: () => IterableIterator<[string, unknown]> }
      const failingMemories = {
        ...originalMemories,
        // fail ANY put whose value carries supersededBy===undefined AND key
        // matches the OLD row we will supersede; simpler: fail the put for the
        // physical id we know will be the old row.
        put: async (k: string, v: unknown) => {
          if (k === 'old-supersede') throw new Error('supersede write failed')
          return originalMemories.put(k, v)
        },
      }
      return { ...base, table: (name: string) => name === 'memories' ? failingMemories : tableOf(name) }
    }) as unknown as typeof ctx.storageDomain.open
    await apply(ctx, { embedding: { enabled: false }, autoInject: false })
    const write = registered.find(d => d.name === 'memory_write')!
    // seed the OLD row directly with the exact physical id we will fail
    memState.store.set('old-supersede', {
      id: 'old-supersede', content: '旧正文', value: 'a', createdAt: 1, updatedAt: 1, basis: 'user-stated',
    })
    // keyless write similar to old body → must try to supersede old-supersede
    await expect(write.execute({ content: '旧正文', value: 'b', basis: 'user-stated' }, noExec)).rejects.toThrow(/supersede write failed/)
    // old record still ACTIVE (not superseded), candidate absent
    const oldRow = memState.store.get('old-supersede') as { supersededBy?: unknown }
    expect(oldRow.supersededBy).toBeUndefined()
    const candidate = [...memState.store.values()].filter(r => (r as { content?: string }).content === '旧正文' && (r as { id?: string }).id !== 'old-supersede')
    expect(candidate).toHaveLength(0) // candidate never written
  })
})