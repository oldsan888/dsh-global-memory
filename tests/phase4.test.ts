import { getEventListeners } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  buildDatabaseSnapshot,
  buildSnapshotDetailed,
  buildSnapshotText,
  createRuntimeMetrics,
  hashContent,
  runGovernance,
  waitOrAbort,
} from '../src/index.ts'
import { embedAttempt } from '../src/memory-core.ts'
import type { ReclassifyEntry } from '../src/governance.ts'
import type { MemoryId, MemoryRecord } from '../src/spec.ts'

let sequence = 0
function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  sequence++
  const content = overrides.content ?? `memory-${sequence}`
  return {
    id: (overrides.id ?? `m-${sequence}`) as MemoryId,
    content,
    createdAt: overrides.createdAt ?? sequence,
    updatedAt: overrides.updatedAt ?? sequence,
    ...overrides,
  }
}

describe('Phase 4 injection diagnostics', () => {
  it('uses the exact same renderer as auto-inject and reports eligibility skips once', () => {
    const now = 10_000
    const rows = [
      record({ id: 'ok' as MemoryId, content: 'stable fact', kind: 'fact', basis: 'user-stated' }),
      record({ id: 'inactive' as MemoryId, content: 'retired', kind: 'fact', basis: 'user-stated', retiredAt: 1 }),
      record({ id: 'expired' as MemoryId, content: 'old', kind: 'fact', basis: 'user-stated', expiresAt: now }),
      record({ id: 'restricted' as MemoryId, content: 'secret sentinel', kind: 'fact', basis: 'user-stated', sensitivity: 'restricted' }),
      record({ id: 'summary' as MemoryId, content: 'summary', kind: 'project-summary', basis: 'user-stated' }),
      record({ id: 'untrusted' as MemoryId, content: 'guess', kind: 'fact', basis: 'agent-inferred' }),
    ]
    const options = { topK: 8, maxChars: 3600, now }
    const detailed = buildSnapshotDetailed(rows, options)

    expect(detailed.text).toBe(buildSnapshotText(rows, options))
    expect(detailed.diagnostics.renderedChars).toBe(detailed.text?.length)
    expect(detailed.diagnostics.selectedIds).toEqual(['ok'])
    expect(detailed.diagnostics.skipped).toMatchObject({
      inactive: 1, expired: 1, restricted: 1,
      'ineligible-kind': 1, 'untrusted-basis': 1,
    })
    expect(Object.values(detailed.diagnostics.skipped).reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('reports aggregate lane caps, top-k and total-budget without truncating bodies', () => {
    const profiles = [
      record({ id: 'p600' as MemoryId, content: 'p'.repeat(600), kind: 'profile', basis: 'user-stated', importance: 1 }),
      record({ id: 'p400' as MemoryId, content: 'q'.repeat(400), kind: 'profile', basis: 'user-stated', importance: 0.9 }),
    ]
    const lane = buildSnapshotDetailed(profiles, { topK: 8, maxChars: 3600, now: 1 })
    expect(lane.diagnostics.selectedIds).toEqual(['p600'])
    expect(lane.diagnostics.lanes.profile).toMatchObject({ used: 600, cap: 900, selected: 1 })
    expect(lane.diagnostics.skipped['profile-cap']).toBe(1)

    const facts = [
      record({ id: 'f1' as MemoryId, content: 'one', kind: 'fact', basis: 'user-stated', importance: 1 }),
      record({ id: 'f2' as MemoryId, content: 'two', kind: 'fact', basis: 'user-stated', importance: 0.5 }),
    ]
    const top = buildSnapshotDetailed(facts, { topK: 1, maxChars: 3600, now: 1 })
    expect(top.diagnostics.selected).toBe(1)
    expect(top.diagnostics.skipped['top-k']).toBe(1)

    const tiny = buildSnapshotDetailed(facts, { topK: 8, maxChars: 1, now: 1 })
    expect(tiny.text).toBeUndefined()
    expect(tiny.diagnostics.skipped['total-budget']).toBe(2)
  })
})

describe('Phase 4 bounded database health snapshot', () => {
  it('counts physical states and strict embedding health without returning bodies', () => {
    const now = 100
    const healthyContent = 'HEALTH_BODY_SECRET'
    const rows = [
      record({
        id: 'active' as MemoryId, content: healthyContent, scope: 'work', kind: 'fact', basis: 'user-stated',
        embedding: [0.1, 0.2], embeddingModel: 'model-a', embeddingDim: 2,
        contentHash: hashContent(healthyContent),
      }),
      record({ id: 'retired' as MemoryId, content: 'retired body', scope: 'work', retiredAt: 1 }),
      record({ id: 'superseded' as MemoryId, content: 'superseded body', scope: 'music', supersededBy: 'new' as MemoryId }),
      record({ id: 'expired' as MemoryId, content: 'x'.repeat(1001), scope: 'other', kind: 'fact', basis: 'user-stated', expiresAt: now }),
      record({ id: 'legacy-vector' as MemoryId, content: 'legacy body', embedding: [0.3, 0.4] }),
    ]
    const snapshot = buildDatabaseSnapshot(rows, {
      now, deletionReceipts: 3, configuredModel: 'model-a', configuredDim: 2,
      scopeTopN: 1, modelDimTopN: 1, longTopN: 1,
    })

    expect(snapshot).toMatchObject({
      total: 5, active: 3, retired: 1, superseded: 1, deletionReceipts: 3,
      expired: 1,
      longRecords: { over800: 1, over1000: 1, top: [{ id: 'expired', chars: 1001 }] },
      embedding: { present: 2, healthy: 1, pending: 0, unhealthy: 1 },
    })
    expect(snapshot.byScopeTop).toEqual([{ scope: 'work', count: 2 }])
    expect(snapshot.otherScopeCount).toBe(3)
    expect(JSON.stringify(snapshot)).not.toContain(healthyContent)
    expect(JSON.stringify(snapshot)).not.toContain('legacy body')
  })

  it('reports zero healthy vectors when the vector path is disabled/unconfigured', () => {
    const content = 'vector body'
    const row = record({
      content, embedding: [1, 0], embeddingModel: 'configured-but-disabled', embeddingDim: 2,
      contentHash: hashContent(content),
    })
    const snapshot = buildDatabaseSnapshot([row], { now: 1, configuredModel: undefined, configuredDim: undefined })
    expect(snapshot.embedding).toMatchObject({ present: 1, healthy: 0, unhealthy: 1 })
  })

  it('keeps top-N lists bounded and deterministically sorted', () => {
    const rows = Array.from({ length: 25 }, (_, i) => record({
      id: `scope-${String(i).padStart(2, '0')}` as MemoryId,
      content: 'x'.repeat(i + 1), scope: `s-${String(i).padStart(2, '0')}`,
      embedding: [i + 1], embeddingModel: `m-${String(i).padStart(2, '0')}`, embeddingDim: 1,
      contentHash: hashContent('x'.repeat(i + 1)),
    }))
    const snapshot = buildDatabaseSnapshot(rows, {
      now: 1, configuredModel: 'does-not-match', scopeTopN: 20, modelDimTopN: 20, longTopN: 20,
    })
    expect(snapshot.byScopeTop).toHaveLength(20)
    expect(snapshot.embedding.modelDimTop).toHaveLength(20)
    expect(snapshot.longRecords.top).toHaveLength(20)
    expect(snapshot.otherScopeCount).toBe(5)
    expect(snapshot.embedding.otherModelDimCount).toBe(5)
    expect(snapshot.byScopeTop.map(x => x.scope)).toEqual([...snapshot.byScopeTop.map(x => x.scope)].sort())
    expect(snapshot.longRecords.top[0]).toEqual({ id: 'scope-24', chars: 25 })
  })
})

describe('Phase 4 anonymous in-memory metrics', () => {
  it('uses a fixed recent-256 latency window and deterministic percentiles', () => {
    const metrics = createRuntimeMetrics(() => 1234)
    for (let latency = 1; latency <= 300; latency++) {
      metrics.recordRecallCall({ latencyMs: latency, failed: latency === 300, zeroResults: latency % 2 === 0, returnedItems: 2 })
    }
    const recall = metrics.recall()
    expect(metrics.since).toBe(1234)
    expect(recall).toMatchObject({ calls: 300, failures: 1, returnedItems: 598, latencySamples: 256 })
    expect(recall.p50Ms).toBe(172)
    expect(recall.p95Ms).toBe(288)
  })

  it('keeps embedding outcomes mutually exclusive and resets with a fresh instance', () => {
    const metrics = createRuntimeMetrics(() => 1)
    metrics.recordEmbeddingOutcome('success')
    metrics.recordEmbeddingOutcome('failure')
    metrics.recordEmbeddingOutcome('timeout')
    metrics.recordEmbeddingOutcome('cancelled')
    expect(metrics.embedding()).toEqual({ attempts: 4, successes: 1, failures: 1, timeouts: 1, cancelled: 1 })
    expect(createRuntimeMetrics(() => 2).embedding().attempts).toBe(0)
  })

  it('meters each real embedding HTTP attempt exactly once and disabled mode zero times', async () => {
    const originalFetch = globalThis.fetch
    const outcomes: string[] = []
    const settings = { enabled: true, baseUrl: 'http://embed', apiKey: 'k', model: 'm', dim: 2 }
    try {
      globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })) as typeof fetch
      expect((await embedAttempt('ok', settings, undefined, outcome => outcomes.push(outcome))).ok).toBe(true)
      globalThis.fetch = vi.fn(async () => new Response('busy', { status: 500 })) as typeof fetch
      expect((await embedAttempt('fail', settings, undefined, outcome => outcomes.push(outcome))).ok).toBe(false)
      globalThis.fetch = vi.fn(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }) as typeof fetch
      expect((await embedAttempt('timeout', settings, undefined, outcome => outcomes.push(outcome))).ok).toBe(false)
      const controller = new AbortController()
      controller.abort()
      globalThis.fetch = vi.fn(async () => { throw Object.assign(new Error('abort'), { name: 'AbortError' }) }) as typeof fetch
      expect((await embedAttempt('cancel', settings, controller.signal, outcome => outcomes.push(outcome))).ok).toBe(false)
      await embedAttempt('disabled', { enabled: false }, undefined, outcome => outcomes.push(outcome))
      expect(outcomes).toEqual(['success', 'failure', 'timeout', 'cancelled'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 4 governance core', () => {
  function governanceTable(initial: MemoryRecord[]) {
    const store = new Map(initial.map(row => [String(row.id), row]))
    const update = vi.fn(async (id: string, fn: (row: MemoryRecord) => MemoryRecord) => {
      const current = store.get(id)
      if (!current) throw new Error('missing-key')
      const next = fn(current)
      store.set(id, next)
      return next
    })
    return { store, update, table: { get: (id: string) => store.get(id), update } }
  }

  function manifestFor(row: MemoryRecord, toKind: 'project-summary' | 'reference' = 'reference'): ReclassifyEntry {
    return {
      id: String(row.id), expectedContentHash: hashContent(row.content), expectedUpdatedAt: row.updatedAt,
      fromKind: row.kind ?? null, toKind, action: 'reclassify',
    }
  }

  it('defaults to a zero-write dry-run', async () => {
    const row = record({ id: 'g1' as MemoryId, content: 'long body', kind: 'fact', scope: 'work' })
    const { table, update, store } = governanceTable([row])
    const result = await runGovernance(table, [manifestFor(row)], { apply: false })
    expect(result).toMatchObject({ mode: 'dry-run', aborted: false, planned: 1, changed: 0 })
    expect(update).not.toHaveBeenCalled()
    expect(store.get('g1')?.kind).toBe('fact')
  })

  it('changes only kind and is idempotent on the second apply', async () => {
    const row = record({
      id: 'g2' as MemoryId, content: 'immutable body', kind: 'fact', scope: 'work', key: 'k',
      embedding: [0.5], embeddingModel: 'm', embeddingDim: 1, contentHash: hashContent('immutable body'),
      revisions: [{ content: 'older', updatedAt: 1 }], source: { toolCallId: 'c1' },
    })
    const { table, store } = governanceTable([row])
    const manifest = [manifestFor(row, 'project-summary')]
    expect(await runGovernance(table, manifest, { apply: true })).toMatchObject({ changed: 1, skipped: 0 })
    const after = store.get('g2')!
    expect(after).toEqual({ ...row, kind: 'project-summary' })
    expect(await runGovernance(table, manifest, { apply: true })).toMatchObject({ changed: 0, skipped: 1 })
  })

  it('rejects the whole batch before writes when any guard drifts', async () => {
    const a = record({ id: 'ga' as MemoryId, content: 'a', kind: 'fact' })
    const b = record({ id: 'gb' as MemoryId, content: 'b', kind: 'fact' })
    const { table, update, store } = governanceTable([a, b])
    const bad = { ...manifestFor(b), expectedContentHash: hashContent('changed elsewhere') }
    const result = await runGovernance(table, [manifestFor(a), bad], { apply: true })
    expect(result).toMatchObject({ aborted: true, changed: 0, conflicts: 1 })
    expect(update).not.toHaveBeenCalled()
    expect(store.get('ga')?.kind).toBe('fact')
  })

  it('rejects malformed runtime JSON manifests before any read or write', async () => {
    const row = record({ id: 'invalid-json' as MemoryId, content: 'body', kind: 'fact' })
    const { table, update } = governanceTable([row])
    const invalid = { ...manifestFor(row), toKind: 'profile' } as unknown as ReclassifyEntry
    await expect(runGovernance(table, [invalid], { apply: true })).rejects.toThrow(/toKind/)
    expect(update).not.toHaveBeenCalled()
  })
})

describe('Phase 3 S1 retry-wait listener cleanup', () => {
  it('does not retain listeners after normal completion', async () => {
    const controller = new AbortController()
    for (let i = 0; i < 20; i++) await waitOrAbort(0, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })

  it('resolves an already-aborted signal without registering a listener', async () => {
    const controller = new AbortController()
    controller.abort()
    await waitOrAbort(1000, controller.signal)
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})

describe('memory_status runtime surface', () => {
  it('is read-only, network-free, content-free, and does not meter itself', async () => {
    const store = new Map<string, MemoryRecord>()
    const receipts = new Map<string, unknown>()
    const put = vi.fn(async (id: string, value: MemoryRecord) => void store.set(id, value))
    const update = vi.fn(async (id: string, fn: (row: MemoryRecord) => MemoryRecord) => {
      const current = store.get(id)
      if (!current) throw new Error('missing-key')
      const next = fn(current)
      store.set(id, next)
      return next
    })
    const del = vi.fn(async (id: string) => store.delete(id))
    const memoryTable = {
      get: (id: string) => store.get(id), put, update, delete: del,
      entries: () => store.entries(), get size() { return store.size },
    }
    const receiptTable = {
      get: (id: string) => receipts.get(id), put: vi.fn(), update: vi.fn(), delete: vi.fn(),
      entries: () => receipts.entries(), get size() { return receipts.size },
    }
    const tools: Array<{ name: string; execute(args: unknown, exec: unknown): Promise<unknown> }> = []
    const ctx = {
      storageDomain: { open: async () => ({ table: (name: string) => name === 'memories' ? memoryTable : receiptTable, close: async () => {} }) },
      tools: { register: (tool: typeof tools[number]) => void tools.push(tool) },
      effect: () => {}, on: () => {}, logger: { warn: () => {} },
    } as unknown as Context

    const secret = 'PHASE4-SECRET-CONTENT-DO-NOT-RETURN'
    store.set('secret-id', record({
      id: 'secret-id' as MemoryId, content: secret, kind: 'fact', basis: 'user-stated',
      embedding: [0.123456789], embeddingModel: 'm', embeddingDim: 1, contentHash: hashContent(secret),
      revisions: [{ content: 'PHASE4-SECRET-REVISION', updatedAt: 1 }],
    }))
    const originalFetch = globalThis.fetch
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      await apply(ctx, { autoInject: false, backfillOnStart: false, embedding: { enabled: false, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 1 } })
      put.mockClear(); update.mockClear(); del.mockClear()
      const status = tools.find(tool => tool.name === 'memory_status')!
      const first = await status.execute({}, {}) as { database: { embedding: { healthy: number } }; runtime: { recall: { calls: number }; embedding: { attempts: number } } }
      const serialized = JSON.stringify(first)
      expect(serialized).not.toContain(secret)
      expect(serialized).not.toContain('PHASE4-SECRET-REVISION')
      expect(first.database.embedding.healthy).toBe(0)
      expect(first.runtime.recall.calls).toBe(0)
      expect(first.runtime.embedding.attempts).toBe(0)
      expect(put).not.toHaveBeenCalled()
      expect(update).not.toHaveBeenCalled()
      expect(del).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()

      const second = await status.execute({}, {}) as { runtime: { recall: { calls: number }; embedding: { attempts: number } } }
      expect(second.runtime).toEqual(first.runtime)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
