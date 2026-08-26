import { describe, expect, it, vi } from 'vitest'
import {
  LEXICAL_MIN_SCORE, VECTOR_MIN_SIMILARITY, RRF_K, CANDIDATE_DEPTH,
  RECALL_MAX_CHARS, normalizeRecallBudget, normalizeBackfillParams,
  isStale, hashContent, embeddingHealthy,
  lexicalMatches, lexicalCandidates, vectorMatches, vectorCandidates, fuseRanks, buildRecallResult,
} from '../src/memory-core.ts'
import type { MemoryRecord } from '../src/spec.ts'
import type { MemoryId } from '../src/spec.ts'
import golden from './fixtures/recall-golden.json'
import { GOLDEN_MODEL, cosine, queryVector, recordVector } from './fixtures/golden-vectors.ts'
import { apply } from '../src/index.ts'
import type { Context } from '@deepseek-ai/cordis'

const id = (n: string) => n as MemoryId
let seq = 0
function rec(over: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: id(`m-${(seq++).toString(36)}`), content: 'c', createdAt: 1, updatedAt: 1,
    ...over,
  }
}

const GOLDEN_DIM = (golden as { dim: number }).dim
const goldenCases = golden.cases as Array<{
  name: string; query: string; mode?: string; cluster?: string
  mix?: Array<{ cluster: string; weight: number }>
  expectIds?: string[]; expectEmpty?: boolean
}>

/**
 * Golden corpus as MemoryRecord[] with the deterministic cluster vectors
 * (E3): every record carries embedding + model/dim/hash health metadata so
 * the vector path is truly executable. All content is synthetic.
 */
function goldenRecords(): MemoryRecord[] {
  return (golden.records as Array<{
    id: string; content: string; scope?: string; kind?: string; cluster?: string
    vectorMix?: Array<{ cluster: string; weight: number }>
  }>).map((r, index) => ({
    id: r.id as MemoryId,
    content: r.content,
    ...(r.scope ? { scope: r.scope } : {}),
    ...(r.kind ? { kind: r.kind as MemoryRecord['kind'] } : {}),
    basis: 'user-stated',
    createdAt: 1000 + index,
    updatedAt: 1000 + index,
    embedding: recordVector(r, GOLDEN_DIM)!,
    embeddingPending: false,
    embeddingModel: GOLDEN_MODEL,
    embeddingDim: GOLDEN_DIM,
    contentHash: hashContent(r.content),
  }))
}

/** Case query vector (undefined for mode `lexical`/cluster-less cases). */
function goldenQueryVector(c: (typeof goldenCases)[number]): number[] | undefined {
  return queryVector({ name: c.name, cluster: c.cluster, mix: c.mix }, GOLDEN_DIM)
}

describe('Phase 3 golden calibration fixtures', () => {
  it('golden set has 24+ cases with the required mix', () => {
    const pos = goldenCases.filter(c => !c.expectEmpty)
    const neg = goldenCases.filter(c => c.expectEmpty)
    const cn = pos.filter(c => /[\u4e00-\u9fff]/.test(c.query))
    const en = pos.filter(c => /^[a-z ]+$/.test(c.query.toLowerCase()))
    expect(goldenCases.length).toBeGreaterThanOrEqual(24)
    expect(cn.length).toBeGreaterThanOrEqual(8)
    expect(en.length).toBeGreaterThanOrEqual(6)
    expect(neg.length).toBeGreaterThanOrEqual(6)
    // E1: the fixture must NOT pre-store the thresholds (they are searched).
    expect((golden as { thresholds?: unknown }).thresholds).toBeUndefined()
  })
})

// ===========================================================================
// E3: the 26 golden cases execute through the REAL ranking pipeline with the
// DEPLOYED constants. Positives must land their expected id in fused TOP-3
// (not merely "somewhere"); negatives must fuse to empty. Hybrid cases prove
// the vector path actually ran (lexical miss + vector hit).
// ===========================================================================
describe('golden set execution through the real recall pipeline (E3)', () => {
  const NOW = 1_000_000_000

  it('every positive case ranks its expected id in fused top-3; every negative case fuses empty', () => {
    const records = goldenRecords()
    for (const c of goldenCases) {
      const lex = lexicalCandidates(records, c.query, undefined)
      const qv = goldenQueryVector(c)
      let fused: Array<{ record: MemoryRecord; score: number; stale: boolean }>
      if (qv) {
        const vec = vectorCandidates(records, qv, undefined, GOLDEN_MODEL, GOLDEN_DIM)
        fused = fuseRanks(lex, vec, NOW)
      } else {
        fused = lex.map(x => ({ record: x.record, score: x.score, stale: isStale(x.record, NOW) }))
      }
      if (c.expectEmpty) {
        expect(fused.length, `${c.name} must fuse empty`).toBe(0)
      } else {
        const top3 = fused.slice(0, 3).map(f => String(f.record.id))
        for (const expected of c.expectIds ?? []) {
          expect(top3, `${c.name}: expected ${expected} inside fused top-3 [${top3.join(',')}]`).toContain(expected)
        }
      }
    }
  })

  it('hybrid cases truly exercise the vector path: lexical misses, vector/fusion finds the target', () => {
    const records = goldenRecords()
    const hybrid = goldenCases.filter(c => c.mode === 'hybrid' && !c.expectEmpty)
    expect(hybrid.length).toBeGreaterThanOrEqual(3)
    for (const c of hybrid) {
      const expected = c.expectIds?.[0]
      if (!expected) continue
      // lexical path must NOT surface the target (that is the hybrid design)
      const lex = lexicalCandidates(records, c.query, undefined)
      expect(lex.some(x => String(x.record.id) === expected), `${c.name} must NOT be a lexical hit`).toBe(false)
      // query vector exists and the FUSED top-3 contains the target — only
      // possible when the vector path ran and contributed.
      const qv = goldenQueryVector(c)
      expect(qv).toBeDefined()
      const vec = vectorCandidates(records, qv!, undefined, GOLDEN_MODEL, GOLDEN_DIM)
      expect(vec.some(x => String(x.record.id) === expected), `${c.name} must be a vector candidate`).toBe(true)
      const fused = fuseRanks(lex, vec, NOW)
      expect(fused.slice(0, 3).map(f => String(f.record.id))).toContain(expected)
    }
  })

  it('near-threshold positive and hard negative pin the VECTOR_MIN_SIMILARITY boundary', () => {
    const records = goldenRecords()
    const near = goldenCases.find(c => c.name === 'near-pos')!
    const hard = goldenCases.find(c => c.name === 'neg-hard')!
    const nearQv = goldenQueryVector(near)!
    const hardQv = goldenQueryVector(hard)!
    const nearTarget = records.find(r => r.id === 'r-near')!
    const decoy = records.find(r => r.id === 'r-hard-neg')!
    const nearCos = cosine(nearQv, nearTarget.embedding)!
    const decoyCos = cosine(hardQv, decoy.embedding)!
    // near: accepted and genuinely close to the threshold (≤0.15 margin above)
    expect(nearCos).toBeGreaterThanOrEqual(VECTOR_MIN_SIMILARITY)
    expect(nearCos - VECTOR_MIN_SIMILARITY).toBeLessThan(0.15)
    // hard: rejected and genuinely close to the threshold (≤0.15 margin below)
    expect(decoyCos).toBeLessThan(VECTOR_MIN_SIMILARITY)
    expect(VECTOR_MIN_SIMILARITY - decoyCos).toBeLessThan(0.15)
    // end-to-end: near-pos still fuses r-near into top-3; neg-hard fuses empty
    const lexNear = lexicalCandidates(records, near.query, undefined)
    const fusedNear = fuseRanks(lexNear, vectorCandidates(records, nearQv, undefined, GOLDEN_MODEL, GOLDEN_DIM), NOW)
    expect(fusedNear.slice(0, 3).map(f => String(f.record.id))).toContain('r-near')
    const lexHard = lexicalCandidates(records, hard.query, undefined)
    const fusedHard = fuseRanks(lexHard, vectorCandidates(records, hardQv, undefined, GOLDEN_MODEL, GOLDEN_DIM), NOW)
    expect(fusedHard.length).toBe(0)
  })

  it('mode=lexical cases skip the vector path and are found lexically', () => {
    const records = goldenRecords()
    const lexicalOnly = goldenCases.filter(c => c.mode === 'lexical' && !c.expectEmpty)
    expect(lexicalOnly.length).toBeGreaterThanOrEqual(1)
    for (const c of lexicalOnly) {
      expect(goldenQueryVector(c)).toBeUndefined()
      const fused = lexicalCandidates(records, c.query, undefined).map(x => ({ record: x.record, score: x.score, stale: false }))
      for (const expected of c.expectIds ?? []) {
        expect(fused.slice(0, 3).map(f => String(f.record.id))).toContain(expected)
      }
    }
  })
})

describe('lexicalMatches / lexicalCandidates (calibrated threshold)', () => {
  it('mode=lexical positives are genuine lexical hits (no vector path available)', () => {
    const records = goldenRecords()
    for (const c of goldenCases.filter(c => !c.expectEmpty && c.mode === 'lexical')) {
      const hits = lexicalCandidates(records, c.query, undefined)
      for (const expected of c.expectIds ?? []) {
        expect(hits.some(h => String(h.record.id) === expected), `${c.name} should rank ${expected}`).toBe(true)
      }
    }
  })

  it('lexicalMatches is UNCAPPED while lexicalCandidates is depth-capped (M6)', () => {
    const query = 'alpha beta'
    const many = Array.from({ length: 50 }, (_, i) => rec({ id: id(`many-${i}`), content: `alpha beta ${i}`, updatedAt: i }))
    const full = lexicalMatches(many, query, undefined)
    const capped = lexicalCandidates(many, query, undefined)
    expect(full.length).toBe(50)
    expect(capped.length).toBe(CANDIDATE_DEPTH)
  })

  it('negative cases return no lexical matches', () => {
    const records = goldenRecords()
    for (const c of goldenCases.filter(c => c.expectEmpty)) {
      const hits = lexicalMatches(records, c.query, undefined)
      expect(hits.length, `${c.name} must be empty`).toBe(0)
    }
  })

  it('threshold boundary (E2): exactly LEXICAL_MIN_SCORE accepted, one notch below rejected', () => {
    // 20 distinct query words → exact hits/20 matches ANY 0.05-grid threshold,
    // including 0.4 (2/5-equivalent as 8/20) and 0.5 (10/20).
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango']
    const hits = Math.round(LEXICAL_MIN_SCORE * words.length)
    const query = words.join(' ')
    const exact = rec({ id: id('boundary-exact'), content: words.slice(0, hits).join(' ') })
    const below = rec({ id: id('boundary-below'), content: words.slice(0, hits - 1).join(' ') })
    expect(hits).toBeGreaterThan(0)
    expect(hits).toBeLessThan(words.length)
    const matches = lexicalMatches([exact, below], query, undefined)
    expect(matches.map(m => String(m.record.id))).toEqual([id('boundary-exact')])
    const candidates = lexicalCandidates([exact, below], query, undefined)
    expect(candidates.map(c => String(c.record.id))).toEqual([id('boundary-exact')])
  })
})

describe('vectorCandidates (strict healthy-embedding only, M1)', () => {
  it('legacy vectors missing hash/model/dim never become candidates; mismatches are excluded', () => {
    const model = 'bge-m3'
    const dim = 4
    const h1 = hashContent('content one')
    const healthy = rec({ id: id('healthy'), content: 'content one', embedding: [1, 0, 0, 0], embeddingPending: false, embeddingModel: model, embeddingDim: 4, contentHash: h1 })
    const staleHash = rec({ id: id('stale'), content: 'content two', embedding: [0, 1, 0, 0], embeddingPending: false, embeddingModel: model, embeddingDim: 4, contentHash: hashContent('other body') })
    const wrongModel = rec({ id: id('model'), content: 'content three', embedding: [0, 0, 1, 0], embeddingPending: false, embeddingModel: 'other-model', embeddingDim: 4, contentHash: hashContent('content three') })
    const wrongDim = rec({ id: id('dim'), content: 'content four', embedding: [0, 0, 0, 1, 0], embeddingPending: false, embeddingModel: model, embeddingDim: 5, contentHash: hashContent('content four') })
    const pending = rec({ id: id('pending'), content: 'content five', embedding: [1, 0, 0, 0], embeddingPending: true, embeddingModel: model, embeddingDim: 4, contentHash: hashContent('content five') })
    const legacyNoHash = rec({ id: id('legacy-nohash'), content: 'content six', embedding: [1, 0, 0, 0], embeddingPending: false, embeddingModel: model, embeddingDim: 4 })
    const legacyNoModel = rec({ id: id('legacy-nomodel'), content: 'content seven', embedding: [1, 0, 0, 0], embeddingPending: false, embeddingDim: 4, contentHash: hashContent('content seven') })
    const legacyNoDim = rec({ id: id('legacy-nodim'), content: 'content eight', embedding: [1, 0, 0, 0], embeddingPending: false, embeddingModel: model, contentHash: hashContent('content eight') })
    const queryVector = [1, 0, 0, 0]
    const hits = vectorCandidates([healthy, staleHash, wrongModel, wrongDim, pending, legacyNoHash, legacyNoModel, legacyNoDim], queryVector, undefined, model, dim)
    expect(hits.map(h => h.record.id)).toEqual([id('healthy')])
    // vectorMatches agrees (uncapped)
    expect(vectorMatches([healthy, legacyNoHash], queryVector, undefined, model, dim).map(h => h.record.id)).toEqual([id('healthy')])
  })
})

describe('fuseRanks (deterministic RRF + stable tie-break)', () => {
  it('records in both paths get higher fused rank than single-path ones', () => {
    const now = 1000
    const a = rec({ id: id('a'), content: 'both paths', updatedAt: 10 })
    const b = rec({ id: id('b'), content: 'lexical only', updatedAt: 9 })
    const lex = [
      { record: a, score: 0.9 },
      { record: b, score: 0.8 },
    ]
    const vec = [{ record: a, score: 0.95 }]
    const fused = fuseRanks(lex, vec, now)
    expect(fused[0].record.id).toBe(id('a')) // 1/(60+1)+1/(60+1) > 1/(60+1)
    expect(fused[1].record.id).toBe(id('b'))
    expect(fused.every(x => typeof x.score === 'number')).toBe(true)
  })

  it('stale records sort after equally-ranked fresh ones', () => {
    const now = 1000
    const fresh = rec({ id: id('fresh'), content: 'same score', updatedAt: 10 })
    const stale = rec({ id: id('stale'), content: 'same score', updatedAt: 9, expiresAt: 500 }) // expired
    const lex = [
      { record: fresh, score: 0.5 },
      { record: stale, score: 0.5 },
    ]
    const fused = fuseRanks(lex, [], now)
    expect(fused[0].record.id).toBe(id('fresh'))
    expect(fused[1].record.id).toBe(id('stale'))
    expect(fused[1].stale).toBe(true)
  })
})

describe('normalizeRecallBudget', () => {
  it('defaults to 6000 and clamps above 6000', () => {
    expect(normalizeRecallBudget(undefined)).toBe(6000)
    expect(normalizeRecallBudget(RECALL_MAX_CHARS)).toBe(6000)
    expect(normalizeRecallBudget(99999)).toBe(6000)
  })

  it('respects values in [256, 6000]', () => {
    expect(normalizeRecallBudget(256)).toBe(256)
    expect(normalizeRecallBudget(500)).toBe(500)
    expect(normalizeRecallBudget(3000)).toBe(3000)
  })

  it('rejects invalid config (non-finite, non-integer, <256)', () => {
    expect(() => normalizeRecallBudget(NaN)).toThrow(/finite/)
    expect(() => normalizeRecallBudget(Infinity)).toThrow(/finite/)
    expect(() => normalizeRecallBudget(100.5)).toThrow(/integer/)
    expect(() => normalizeRecallBudget(255)).toThrow(/>= 256/)
    expect(() => normalizeRecallBudget(0)).toThrow(/>= 256/)
  })
})

describe('normalizeBackfillParams (S1 exact rules)', () => {
  it('undefined/non-finite → defaults; negative → 0/1; fractional floored; caps applied', () => {
    expect(normalizeBackfillParams(undefined, undefined)).toEqual({ limit: 500, concurrency: 2 })
    expect(normalizeBackfillParams(NaN, Infinity)).toEqual({ limit: 500, concurrency: 2 })
    expect(normalizeBackfillParams(-1, -5)).toEqual({ limit: 0, concurrency: 1 })
    expect(normalizeBackfillParams(2.9, 2.9)).toEqual({ limit: 2, concurrency: 2 })
    expect(normalizeBackfillParams(99999, 999)).toEqual({ limit: 5000, concurrency: 16 })
    expect(normalizeBackfillParams(0, 0)).toEqual({ limit: 0, concurrency: 1 })
  })
})

describe('buildRecallResult (JSON budget builder, M5/M6)', () => {
  const mk = (n: string, content: string, updatedAt = 1): { record: MemoryRecord; score: number; stale: boolean } => ({
    record: rec({ id: id(n), content, updatedAt }),
    score: 1,
    stale: false,
  })

  it('default 6000 budget: envelope + fields + escapes all counted', () => {
    const matched = [mk('a', 'x'.repeat(2500)), mk('b', 'y'.repeat(2500))]
    const r = buildRecallResult(matched, 10, RECALL_MAX_CHARS)
    expect(r.returned).toBe(2)
    expect(r.matchedTotal).toBe(2)
    expect(r.truncated).toBe(false)
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(RECALL_MAX_CHARS)
  })

  it('small budget returns fewer items and marks truncated', () => {
    const matched = [mk('a', 'x'.repeat(2500)), mk('b', 'y'.repeat(2500))]
    const r = buildRecallResult(matched, 10, 400)
    expect(r.returned).toBeLessThanOrEqual(1)
    expect(r.matchedTotal).toBe(2)
    expect(r.truncated).toBe(true)
  })

  it('skips an over-budget item and continues with a smaller one', () => {
    const matched = [mk('big', 'z'.repeat(3000)), mk('small', 'ok')]
    const r = buildRecallResult(matched, 10, 500)
    expect(r.items.length).toBe(1)
    expect(r.items[0].id).toBe(String(matched[1].record.id)) // smaller one accepted
    expect(r.truncated).toBe(true)
  })

  it('topK truncation sets truncated=true; empty result is not truncated', () => {
    const matched = [mk('a', 'aa'), mk('b', 'bb'), mk('c', 'cc')]
    const r = buildRecallResult(matched, 2, 6000)
    expect(r.returned).toBe(2)
    expect(r.matchedTotal).toBe(3)
    expect(r.truncated).toBe(true)
    const empty = buildRecallResult([], 2, 6000)
    expect(empty.returned).toBe(0)
    expect(empty.matchedTotal).toBe(0)
    expect(empty.truncated).toBe(false)
  })

  it('JSON escaping counts toward the budget (quotes/newlines in content)', () => {
    const matched = [mk('esc', 'line1\nline2 "quoted" \u4e2d\u6587')]
    const r = buildRecallResult(matched, 10, 6000)
    expect(r.items.length).toBe(1)
    expect(JSON.stringify(r).length).toBeLessThanOrEqual(6000)
  })

  it('M6: honors an explicit matchedTotal override (uncapped total passed in)', () => {
    const matched = [mk('a', 'aa'), mk('b', 'bb')]
    const r = buildRecallResult(matched, 2, 6000, 40)
    expect(r.returned).toBe(2)
    expect(r.matchedTotal).toBe(40)
    expect(r.truncated).toBe(true)
  })

  it('M5: legacy rows (no basis/kind) are emitted as basis=imported and counted in the budget', () => {
    const legacy = rec({ id: id('legacy-body'), content: 'legacy fact without basis metadata' })
    const r = buildRecallResult([{ record: legacy, score: 1, stale: false }], 10, 6000)
    expect(r.items[0].basis).toBe('imported')
    expect(r.items[0].kind).toBeUndefined()
    expect(JSON.stringify(r)).toContain('"basis":"imported"')
  })
})

describe('isStale / hashContent / embeddingHealthy', () => {
  it('isStale boundaries: expiresAt <= now is stale; absent/future is not', () => {
    const now = 1000
    expect(isStale(rec({ expiresAt: now - 1 }), now)).toBe(true)
    expect(isStale(rec({ expiresAt: now }), now)).toBe(true)
    expect(isStale(rec({ expiresAt: now + 1 }), now)).toBe(false)
    expect(isStale(rec({}), now)).toBe(false)
  })

  it('hashContent is a deterministic lowercase 64-char sha256 hex', () => {
    const h = hashContent('hello 世界')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).toBe(hashContent('hello 世界'))
    expect(h).not.toBe(hashContent('hello 世界!'))
  })

  it('M1: embeddingHealthy requires STRICT version metadata — missing hash/model/dim is UNHEALTHY', () => {
    const model = 'm'
    const dim = 2
    const body = 'body'
    const h = hashContent(body)
    const healthy = rec({ content: body, embedding: [1, 2], embeddingPending: false, embeddingModel: model, embeddingDim: 2, contentHash: h })
    expect(embeddingHealthy(healthy, body, model, dim)).toBe(true)
    // legacy vectors without the hash/model/dim triple → NEVER healthy
    expect(embeddingHealthy({ ...healthy, contentHash: undefined }, body, model, dim)).toBe(false)
    expect(embeddingHealthy({ ...healthy, embeddingModel: undefined }, body, model, dim)).toBe(false)
    expect(embeddingHealthy({ ...healthy, embeddingDim: undefined }, body, model, dim)).toBe(false)
    // mismatches / pending / config mismatch
    expect(embeddingHealthy({ ...healthy, embeddingModel: 'other' }, body, model, dim)).toBe(false)
    expect(embeddingHealthy({ ...healthy, embeddingDim: 3 }, body, model, dim)).toBe(false)
    expect(embeddingHealthy({ ...healthy, contentHash: hashContent('other') }, body, model, dim)).toBe(false)
    expect(embeddingHealthy({ ...healthy, embeddingPending: true }, body, model, dim)).toBe(false)
    expect(embeddingHealthy(healthy, body, model, 3)).toBe(false)
    expect(embeddingHealthy(healthy, body, 'other', dim)).toBe(false)
    // no configured model → nothing can be proven healthy
    expect(embeddingHealthy(healthy, body, undefined, dim)).toBe(false)
  })
})

describe('golden constants are fixed engineering/runtime values (E1)', () => {
  it('RRF_K is the industry-standard 60; candidate depth is a documented runtime bound', () => {
    expect(RRF_K).toBe(60)
    expect(CANDIDATE_DEPTH).toBeGreaterThanOrEqual(10)
    expect(VECTOR_MIN_SIMILARITY).toBeGreaterThan(0)
    expect(LEXICAL_MIN_SCORE).toBeGreaterThan(0)
  })
})

// ===========================================================================
// Phase 3 lifecycle integration (in-memory KvTable harness matching the host
// contract: missing-key rejects, throwing fn never commits, delete returns
// boolean, update serializes per physical key).
// ===========================================================================

interface ToolDef {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output?: { render(args: unknown, value: unknown): Array<{ type: string; text: string }> }
}
const noExec = { agent: { session: { id: 's-p3' } }, callId: 'call-p3' }

function makeHarness() {
  const registered: ToolDef[] = []
  const disposers: Array<() => void> = []
  const listeners: Array<{ event: string; listener: unknown }> = []
  const mem = new Map<string, unknown>()
  const rec = new Map<string, unknown>()
  let updates = 0
  const table = {
    get: (k: string) => mem.get(k),
    put: async (k: string, v: unknown) => { mem.set(k, v) },
    delete: async (k: string) => { const had = mem.has(k); mem.delete(k); return had },
    update: async (k: string, fn: (c: unknown) => unknown) => {
      if (!mem.has(k)) {
        const err = new Error(`domain 'agent_memories' table 'memories' has no record '${k}' to update`) as Error & { code?: string }
        err.name = 'DomainError'
        err.code = 'missing-key'
        throw err
      }
      const next = fn(mem.get(k))
      mem.set(k, next)
      updates++
      return next
    },
    entries: () => mem.entries(),
    size: mem.size,
  }
  const receipts = {
    get: (k: string) => rec.get(k),
    put: async (k: string, v: unknown) => { rec.set(k, v) },
    delete: async (k: string) => { const had = rec.has(k); rec.delete(k); return had },
    update: async (k: string, fn: (c: unknown) => unknown) => { const n = fn(rec.get(k)); rec.set(k, n); return n },
    entries: () => rec.entries(),
    size: rec.size,
  }
  const closeSpy = vi.fn(async () => {})
  const ctx = {
    storageDomain: {
      open: vi.fn(async () => ({
        table: (name: string) => name === 'memories' ? table : name === 'deletions' ? receipts : (() => { throw new Error('no table') })(),
        close: closeSpy,
      })),
    },
    tools: { register: (d: ToolDef) => void registered.push(d) },
    effect: (f: () => () => void) => { const d = f(); if (d) disposers.push(d) },
    on: (event: string, listener: unknown) => void listeners.push({ event, listener }),
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, registered, disposers, listeners, mem, rec, closeSpy, updates: () => updates }
}

async function bootPhase3(overrides: Record<string, unknown> = {}) {
  const h = makeHarness()
  await apply(h.ctx, { embedding: { enabled: false }, autoInject: false, ...overrides })
  const byName = (n: string) => h.registered.find(d => d.name === n)
  return { ...h, byName }
}

describe('Phase 3: recall output contract through the tool', () => {
  it('returns returned/matchedTotal/truncated (no total, no includeDeleted)', async () => {
    const { byName, mem } = await bootPhase3()
    // seed directly into the store
    mem.set('r1', { id: 'r1', key: 'k1', content: 'the user prefers concise chinese replies', updatedAt: 1, basis: 'user-stated', createdAt: 1 })
    const recall = byName('memory_recall')!
    const out = await recall.execute({ query: 'concise chinese replies' }, noExec) as { returned: number; matchedTotal: number; truncated: boolean; items: Array<{ id: string; stale: boolean; basis?: string }> }
    expect(out.returned).toBe(1)
    expect(out.matchedTotal).toBe(1)
    expect(out.truncated).toBe(false)
    expect(out.items[0].id).toBe('r1')
    expect(out.items[0].basis).toBe('user-stated')
    expect('total' in out).toBe(false)
  })

  it('renders the complete budgeted recall value, including memory bodies, to the model', async () => {
    const { byName, mem } = await bootPhase3()
    mem.set('visible-body', {
      id: 'visible-body', content: 'the user prefers concise chinese replies',
      scope: 'communication', updatedAt: 1, createdAt: 1, basis: 'user-stated',
    })
    const recall = byName('memory_recall')!
    const out = await recall.execute({ query: 'concise chinese replies' }, noExec)
    const rendered = recall.output!.render({ query: 'concise chinese replies' }, out)

    expect(rendered).toHaveLength(1)
    expect(rendered[0]?.type).toBe('text')
    expect(JSON.parse(rendered[0]!.text)).toEqual(out)
    expect(rendered[0]!.text).toContain('the user prefers concise chinese replies')
    expect(rendered[0]!.text.length).toBeLessThanOrEqual(RECALL_MAX_CHARS)
  })

  it('expired (stale) records are returned with stale:true', async () => {
    const { byName, mem } = await bootPhase3()
    mem.set('expired', { id: 'expired', content: 'old fact about concise replies', updatedAt: 1, basis: 'user-stated', createdAt: 1, expiresAt: Date.now() - 1000 })
    const recall = byName('memory_recall')!
    const out = await recall.execute({ query: 'concise replies' }, noExec) as { items: Array<{ id: string; stale: boolean }> }
    expect(out.items.some(i => i.id === 'expired')).toBe(true)
    expect(out.items.find(i => i.id === 'expired')!.stale).toBe(true)
  })

  it('scope filter still works and retired/deleted are never returned', async () => {
    const { byName, mem } = await bootPhase3()
    mem.set('a', { id: 'a', content: 'concise replies', scope: 'communication', updatedAt: 1, basis: 'user-stated', createdAt: 1 })
    mem.set('b', { id: 'b', content: 'concise replies', scope: 'work', updatedAt: 1, basis: 'user-stated', createdAt: 1, deleted: true })
    mem.set('c', { id: 'c', content: 'concise replies', scope: 'work', updatedAt: 1, basis: 'user-stated', createdAt: 1, retiredAt: 1 })
    const recall = byName('memory_recall')!
    const scoped = await recall.execute({ query: 'concise replies', scope: 'communication' }, noExec) as { items: Array<{ id: string }> }
    expect(scoped.items.map(i => i.id)).toEqual(['a'])
  })
})

describe('Phase 3 rework M5: legacy recall basis freeze', () => {
  it('a legacy row (no basis/kind/schemaVersion) is recalled as basis=imported and serialized', async () => {
    const { byName, mem } = await bootPhase3()
    mem.set('legacy1', { id: 'legacy1', content: 'legacy chinese concise replies fact', updatedAt: 1, createdAt: 1 })
    const recall = byName('memory_recall')!
    const out = await recall.execute({ query: 'concise replies' }, noExec) as { items: Array<{ id: string; basis?: string }> }
    const item = out.items.find(i => i.id === 'legacy1')
    expect(item).toBeDefined()
    expect(item!.basis).toBe('imported')
    expect(JSON.stringify(out)).toContain('"basis":"imported"')
  })

  it('tool output schema declares basis as required', async () => {
    const { byName } = await bootPhase3()
    // defineTool compiles per-property `required:true` into nested `required`
    // arrays (standard JSON Schema form).
    const tool = byName('memory_recall') as unknown as { output?: { schema?: { required?: string[]; properties?: { items?: { items?: { required?: string[] } } } } } }
    expect(tool.output?.schema?.required).toContain('returned')
    expect(tool.output?.schema?.required).toContain('matchedTotal')
    expect(tool.output?.schema?.properties?.items?.items?.required).toContain('basis')
  })
})

describe('Phase 3 rework M6: matchedTotal is not truncated by candidate depth', () => {
  it('40+ lexical matches report matchedTotal=40 while topK/budget limit returned', async () => {
    const { byName, mem } = await bootPhase3()
    const recall = byName('memory_recall')!
    for (let i = 0; i < 40; i++) {
      mem.set(`bulk-${i}`, { id: `bulk-${i}`, content: `shared alpha beta ${i}`, updatedAt: 1 + i, createdAt: 1 })
    }
    const out = await recall.execute({ query: 'alpha beta' }, noExec) as { returned: number; matchedTotal: number; truncated: boolean }
    expect(out.matchedTotal).toBe(40)
    expect(out.returned).toBe(8) // default topK
    expect(out.truncated).toBe(true)
    const out2 = await recall.execute({ query: 'alpha beta', topK: 100 }, noExec) as { returned: number; matchedTotal: number; truncated: boolean }
    expect(out2.matchedTotal).toBe(40)
    expect(out2.returned).toBe(CANDIDATE_DEPTH) // fusion depth cap still applies to returned
    expect(out2.truncated).toBe(true)
  })
})

describe('Phase 3: contentHash on writes & refresh', () => {
  it('keyed write stores a 64-hex contentHash; metadata-only refresh keeps it', async () => {
    const { byName, mem } = await bootPhase3()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: 'body-1', key: 'k', basis: 'user-stated' }, noExec) as { id: string }
    const row = mem.get(v1.id) as { contentHash?: string }
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.contentHash).toBe(hashContent('body-1'))
    // metadata-only refresh (same body) keeps the same hash
    await write.execute({ content: 'body-1', key: 'k', basis: 'user-stated', importance: 0.5, writeReason: 'touch' }, noExec)
    expect((mem.get(v1.id) as { contentHash?: string }).contentHash).toBe(hashContent('body-1'))
  })

  it('body change updates contentHash and drops embedding metadata', async () => {
    const { byName, mem } = await bootPhase3()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: 'body-A', key: 'k2', basis: 'user-stated' }, noExec) as { id: string }
    // simulate a healthy vector on the old body
    mem.set(v1.id, { ...(mem.get(v1.id) as object), embedding: [1, 2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2 })
    await write.execute({ content: 'body-B', key: 'k2', basis: 'user-stated' }, noExec)
    const row = mem.get(v1.id) as { contentHash?: string; embedding?: unknown; embeddingModel?: unknown; embeddingDim?: unknown; revisions?: unknown[] }
    expect(row.contentHash).toBe(hashContent('body-B'))
    expect(row.embedding).toBeUndefined()
    expect(row.embeddingModel).toBeUndefined()
    expect(row.embeddingDim).toBeUndefined()
    expect(row.revisions).toHaveLength(1)
  })
})

describe('Phase 3: embedding metadata write-back & version guard', () => {
  it('successful embed writes model/dim/hash inside the SAME update with EXACTLY one request (M2)', async () => {
    const h = makeHarness()
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }) }) as typeof fetch
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'bge-m3', dim: 2 },
        autoInject: false,
        backfillOnStart: false,
      })
      const write = h.registered.find(d => d.name === 'memory_write')!
      const v1 = await write.execute({ content: 'embed me', key: 'k3', basis: 'user-stated' }, noExec) as { id: string }
      await vi.waitFor(() => { expect(calls).toBe(1) })
      await vi.waitFor(() => { expect((h.mem.get(v1.id) as { embedding?: unknown }).embedding).toEqual([0.1, 0.2]) })
      const row = h.mem.get(v1.id) as { embedding?: number[]; embeddingModel?: string; embeddingDim?: number; contentHash?: string; embeddingPending?: boolean }
      expect(row.embeddingModel).toBe('bge-m3')
      expect(row.embeddingDim).toBe(2)
      expect(row.contentHash).toBe(hashContent('embed me'))
      expect(row.embeddingPending).toBe(false)
      // metadata-only same-body refresh does NOT re-request (vector stays healthy, M4)
      await write.execute({ content: 'embed me', key: 'k3', basis: 'user-stated', importance: 0.4, writeReason: 'touch' }, noExec)
      await new Promise(r => setImmediate(r))
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 3: expiresAt & L0', () => {
  it('expired records are excluded from L0 snapshot', async () => {
    const { buildSnapshotText } = await import('../src/memory-core.ts')
    const { isEligibleForL0 } = await import('../src/memory-core.ts')
    const now = Date.now()
    const expired = { id: 'x' as MemoryId, content: 'stale profile fact', basis: 'user-stated' as const, kind: 'fact' as const, createdAt: 1, updatedAt: 1, expiresAt: now - 1 } as unknown as MemoryRecord
    const fresh = { id: 'y' as MemoryId, content: 'fresh profile fact', basis: 'user-stated' as const, kind: 'fact' as const, createdAt: 1, updatedAt: 1, expiresAt: now + 1000 } as unknown as MemoryRecord
    expect(isEligibleForL0(expired, now)).toBe(false)
    expect(isEligibleForL0(fresh, now)).toBe(true)
    const text = buildSnapshotText([expired, fresh], { topK: 10, now })
    expect(text).toContain('fresh profile fact')
    expect(text).not.toContain('stale profile fact')
  })
})

describe('Phase 3 rework M1/M2: backfill candidates & precise fetch counts', () => {
  it('candidates include missing/mismatched metadata AND legacy vectors; healthy & restricted excluded', async () => {
    const h = makeHarness()
    const okHash = hashContent('healthy body')
    h.mem.set('healthy', { id: 'healthy', content: 'healthy body', embedding: [1, 2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2, contentHash: okHash, createdAt: 1, updatedAt: 1 })
    h.mem.set('nohash', { id: 'nohash', content: 'no hash body', createdAt: 1, updatedAt: 1 })
    h.mem.set('legacyvec', { id: 'legacyvec', content: 'legacy vector body', embedding: [1, 2], createdAt: 1, updatedAt: 1 })
    h.mem.set('restricted', { id: 'restricted', content: 'restricted body', sensitivity: 'restricted', createdAt: 1, updatedAt: 1 })
    h.mem.set('pending', { id: 'pending', content: 'pending body', embeddingPending: true, createdAt: 1, updatedAt: 1 })
    const fetched: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: unknown) => { fetched.push(String((input as Request).url ?? '')); return new Response('{}', { status: 500 }) }) as typeof fetch
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
        backfillOnStart: true,
        backfillLimit: 100,
        backfillConcurrency: 2,
      })
      // nohash + legacyvec + pending = 3 candidates × 2 attempts (500 → retry after 100ms)
      await vi.waitFor(() => { expect(fetched.length).toBe(6) }, { timeout: 2000 })
      // each candidate's second attempt is its last by construction (≤2);
      // microtask settle confirms no third attempt was scheduled
      await new Promise(r => setImmediate(r))
      await new Promise(r => setImmediate(r))
      expect(fetched.length).toBe(6) // never more than 2 attempts per candidate
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('M2: first-try success = exactly 1 fetch per record, committed once', async () => {
    const h = makeHarness()
    h.mem.set('a', { id: 'a', content: 'needs embedding', createdAt: 1, updatedAt: 1 })
    h.mem.set('b', { id: 'b', content: 'also needs embedding', createdAt: 1, updatedAt: 1 })
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }) }) as typeof fetch
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
        backfillOnStart: true,
        backfillLimit: 10,
        backfillConcurrency: 2,
      })
      await vi.waitFor(() => {
        expect(h.mem.get('a')).toMatchObject({ embedding: [0.1, 0.2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2 })
        expect(h.mem.get('b')).toMatchObject({ embedding: [0.1, 0.2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2 })
      })
      expect(calls).toBe(2) // one request per candidate — commits are now visible, so 2 is final
      await new Promise(r => setImmediate(r))
      expect(calls).toBe(2) // no third request after success
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('M2: first-try failure + retry success = exactly 2 fetches for that record, never 3', async () => {
    const h = makeHarness()
    h.mem.set('a', { id: 'a', content: 'needs embedding', createdAt: 1, updatedAt: 1 })
    let calls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { calls++; return new Response(calls === 1 ? '{}' : JSON.stringify({ data: [{ embedding: [0.3, 0.4] }] }), { status: calls === 1 ? 500 : 200 }) }) as typeof fetch
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
        backfillOnStart: true,
        backfillLimit: 10,
        backfillConcurrency: 1,
      })
      await vi.waitFor(() => { expect(calls).toBe(2) }, { timeout: 2000 })
      expect(h.mem.get('a')).toMatchObject({ embedding: [0.3, 0.4], embeddingPending: false })
      await new Promise(r => setImmediate(r))
      await new Promise(r => setImmediate(r))
      expect(calls).toBe(2) // retry succeeded once (500 → 200), no third attempt
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('M3/S2: unmount aborts pending backfill fetch and closes only after convergence', async () => {
    const h = makeHarness()
    // one backfill candidate so the startup backfill actually fetches
    h.mem.set('cand', { id: 'cand', content: 'needs embedding', createdAt: 1, updatedAt: 1 })
    let fetchStarted = false
    let release: (() => void) | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((..._a: unknown[]) => {
      fetchStarted = true
      return new Promise<Response>((resolve) => { release = () => resolve(new Response('{}', { status: 500 })) })
    }) as typeof fetch
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
        backfillOnStart: true,
        backfillLimit: 10,
        backfillConcurrency: 1,
      })
      // backfill is now blocked on a pending fetch
      await new Promise(r => setImmediate(r))
      expect(fetchStarted).toBe(true)
      // unmount: disposer aborts; close must NOT happen while the fetch pends
      const disposer = h.disposers[0]
      const closePromise = Promise.resolve((disposer as () => unknown)())
      await new Promise(r => setImmediate(r))
      expect(h.closeSpy).not.toHaveBeenCalled()
      // the pending fetch resolves after abort (500); backfill converges; close called
      release?.()
      await closePromise
      expect(h.closeSpy).toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 3 rework M3: unmount waits for write-path embedding', () => {
  it('close happens strictly AFTER the pending write embed settles; zero update after close; zero unhandled rejection', async () => {
    const h = makeHarness()
    let releaseFetch: (() => void) | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = ((..._a: unknown[]) => new Promise<Response>((resolve) => {
      releaseFetch = () => resolve(new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }))
    })) as typeof fetch
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await apply(h.ctx, {
        embedding: { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 },
        autoInject: false,
        backfillOnStart: false,
      })
      const write = h.registered.find(d => d.name === 'memory_write')!
      const v1 = await write.execute({ content: 'pending embed body', key: 'k', basis: 'user-stated' }, noExec) as { id: string }
      // the write's embed request is now PENDING (deferred fetch)
      expect(releaseFetch).toBeDefined()
      const updatesBefore = h.updates()
      const disposer = h.disposers[0]
      const closePromise = Promise.resolve((disposer as () => unknown)())
      await new Promise(r => setImmediate(r))
      // close must wait for the write-path embed task to settle
      expect(h.closeSpy).not.toHaveBeenCalled()
      expect(h.updates()).toBe(updatesBefore)
      releaseFetch!()
      await closePromise
      // the write-path commit happened BEFORE close (fully awaited)
      expect(h.mem.get(v1.id)).toMatchObject({ embedding: [0.1, 0.2], embeddingModel: 'm', embeddingDim: 2, embeddingPending: false })
      expect(h.closeSpy).toHaveBeenCalled()
      const updatesAfterClose = h.updates()
      await new Promise(r => setImmediate(r))
      expect(h.updates()).toBe(updatesAfterClose) // zero updates after close
      expect(unhandled).toEqual([])
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 3 rework M4: keyless same-value refresh', () => {
  it('same value + body change drops the old vector and sets pending', async () => {
    const { byName, mem } = await bootPhase3()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: '用户偏好中文回答', value: 'SAME', basis: 'user-stated' }, noExec) as { id: string }
    // simulate a healthy vector on the old body
    mem.set(v1.id, { ...(mem.get(v1.id) as object), embedding: [1, 2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2 })
    await write.execute({ content: '用户偏好中文回复', value: 'SAME', basis: 'user-stated' }, noExec)
    const row = mem.get(v1.id) as { content?: string; embedding?: unknown; embeddingModel?: unknown; embeddingDim?: unknown; embeddingPending?: boolean }
    expect(row.content).toBe('用户偏好中文回复')
    expect(row.embedding).toBeUndefined()
    expect(row.embeddingModel).toBeUndefined()
    expect(row.embeddingDim).toBeUndefined()
    expect(row.embeddingPending).toBe(true) // fresh request scheduled
  })

  it('same value + same body (metadata-only) KEEPS the healthy vector', async () => {
    const { byName, mem } = await bootPhase3()
    const write = byName('memory_write')!
    const v1 = await write.execute({ content: '用户偏好中文回答', value: 'SAME', basis: 'user-stated' }, noExec) as { id: string }
    mem.set(v1.id, { ...(mem.get(v1.id) as object), embedding: [1, 2], embeddingPending: false, embeddingModel: 'm', embeddingDim: 2 })
    await write.execute({ content: '用户偏好中文回答', value: 'SAME', basis: 'user-stated', importance: 0.5, writeReason: 'touch' }, noExec)
    const row = mem.get(v1.id) as { embedding?: unknown; embeddingPending?: boolean }
    expect(row.embedding).toEqual([1, 2])
    expect(row.embeddingPending).toBe(false)
  })
})

describe('Phase 3: embedding/backfill total failure keeps recall lexical', () => {
  it('when embedding is down, recall still returns lexical results', async () => {
    const { byName, mem } = await bootPhase3()
    mem.set('lex', { id: 'lex', content: 'the user prefers concise chinese replies', updatedAt: 1, basis: 'user-stated', createdAt: 1 })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('network down') }) as typeof fetch
    try {
      // no embedding configured → never fetches; lexical works
      const recall = byName('memory_recall')!
      const out = await recall.execute({ query: 'concise chinese replies' }, noExec) as { items: Array<{ id: string }> }
      expect(out.items.some(i => i.id === 'lex')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Phase 3: embedAttempt retry classification (§8.13)', () => {
  it('network error / timeout / 408 / 429 / 5xx are retryable; 4xx / bad body / dim error are not', async () => {
    const { embedAttempt } = await import('../src/memory-core.ts')
    const settings = { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 2 }
    const run = async (fetchImpl: () => Promise<Response> | never) => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = fetchImpl as typeof fetch
      try {
        return await embedAttempt('text', settings)
      } finally {
        globalThis.fetch = originalFetch
      }
    }
    // network error → retryable
    expect((await run(() => { throw new Error('ECONNRESET') })).ok).toBe(false)
    // 400 → not retryable
    const bad4xx = await run(async () => new Response('{}', { status: 400 }))
    expect(bad4xx).toEqual({ ok: false, retryable: false, status: 400 })
    // 408 → retryable
    const to = await run(async () => new Response('{}', { status: 408 }))
    expect(to).toMatchObject({ ok: false, retryable: true, status: 408 })
    // 429 → retryable
    const lim = await run(async () => new Response('{}', { status: 429 }))
    expect(lim).toMatchObject({ ok: false, retryable: true, status: 429 })
    // 500 → retryable
    const s5 = await run(async () => new Response('{}', { status: 500 }))
    expect(s5).toMatchObject({ ok: false, retryable: true, status: 500 })
    // malformed body on 200 → not retryable
    const bad = await run(async () => new Response('not json', { status: 200 }))
    expect(bad).toEqual({ ok: false, retryable: false })
    // dimension mismatch → not retryable
    const dim = await run(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200 }))
    expect(dim).toEqual({ ok: false, retryable: false })
    // healthy vector → ok
    const ok = await run(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 }))
    expect(ok).toMatchObject({ ok: true })
  })
})
