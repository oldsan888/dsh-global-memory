import { describe, expect, it } from 'vitest'
import {
  PROFILE_KEY, SELF_KEY, RECORD_SCHEMA_VERSION, resolveMemory,
  classifyWrite, isEligibleForL0, buildSnapshotText,
  KIND_CONTENT_LIMITS, SNAPSHOT_HARD_MAX_CHARS,
} from '../src/memory-core.ts'
import type { MemoryId, MemoryRecord } from '../src/spec.ts'

const id = (n: string) => n as MemoryId

let seq = 0
function rec(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: id(`m-${(seq++).toString(36)}`), content: 'c', createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

describe('classifyWrite (Phase 1 §3.1)', () => {
  it('defaults kind=fact, basis=agent-inferred, sensitivity=normal', () => {
    const c = classifyWrite({})
    expect(c).toMatchObject({ kind: 'fact', basis: 'agent-inferred', sensitivity: 'normal' })
  })

  it('forces profile for agent-memory-profile key', () => {
    const c = classifyWrite({ key: PROFILE_KEY })
    expect(c.kind).toBe('profile')
  })

  it('forces agent-self for agent-memory-self key', () => {
    const c = classifyWrite({ key: SELF_KEY })
    expect(c.kind).toBe('agent-self')
  })

  it('rejects reserved key + conflicting explicit kind', () => {
    expect(() => classifyWrite({ key: PROFILE_KEY, kind: 'fact' })).toThrow(/requires kind=profile/)
    expect(() => classifyWrite({ key: SELF_KEY, kind: 'fact' })).toThrow(/requires kind=agent-self/)
  })

  it('never defaults basis to user-stated', () => {
    expect(classifyWrite({ key: PROFILE_KEY }).basis).not.toBe('user-stated')
    expect(classifyWrite({}).basis).toBe('agent-inferred')
  })

  it('structurally rejects sensitivity=restricted', () => {
    expect(() => classifyWrite({ sensitivity: 'restricted' })).toThrow(/restricted/)
  })

  it('requires writeReason when importance >= 0.8', () => {
    expect(() => classifyWrite({ importance: 0.9 })).toThrow(/writeReason/)
    expect(() => classifyWrite({ importance: 0.79 })).not.toThrow()
    expect(() => classifyWrite({ importance: 0.95, writeReason: 'because' })).not.toThrow()
  })

  it('caps writeReason at 500 chars', () => {
    expect(() => classifyWrite({ importance: 0.9, writeReason: 'r'.repeat(501) })).toThrow(/writeReason exceeds/)
    expect(classifyWrite({ importance: 0.9, writeReason: 'r'.repeat(500) }).writeReason).toHaveLength(500)
  })

  it('trims blank writeReason away', () => {
    expect(classifyWrite({ writeReason: '   ' })).not.toHaveProperty('writeReason')
  })
})

describe('KIND_CONTENT_LIMITS', () => {
  it('matches the frozen per-kind caps', () => {
    expect(KIND_CONTENT_LIMITS).toEqual({
      profile: 900, 'agent-self': 700, preference: 800, fact: 800,
      'project-summary': 1200, reference: 800,
    })
  })
})

describe('isEligibleForL0 (Phase 1 §3.3)', () => {
  const now = 1_000_000
  const mk = (over: Partial<MemoryRecord>) => rec(over)

  it('accepts user-stated profile/preference/fact/agent-self', () => {
    for (const kind of ['profile', 'preference', 'fact', 'agent-self'] as const) {
      expect(isEligibleForL0(mk({ kind, basis: 'user-stated' }), now)).toBe(true)
    }
  })

  it('accepts a verified review pair when basis is not user-stated', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'agent-inferred', reviewedAt: 100, reviewedBy: 'ops' }), now)).toBe(true)
  })

  it('rejects imported / agent-inferred / external-unverified without review', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'imported' }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'agent-inferred' }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'external-unverified' }), now)).toBe(false)
  })

  it('rejects project-summary and reference even when user-stated', () => {
    expect(isEligibleForL0(mk({ kind: 'project-summary', basis: 'user-stated' }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'reference', basis: 'user-stated' }), now)).toBe(false)
  })

  it('rejects restricted', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', sensitivity: 'restricted' }), now)).toBe(false)
  })

  it('rejects deleted / superseded / retired', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', deleted: true }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', supersededBy: id('x') }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', retiredAt: 10 }), now)).toBe(false)
  })

  it('rejects expired; accepts future or absent expiry (server clock)', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', expiresAt: now - 1 }), now)).toBe(false)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', expiresAt: now + 1 }), now)).toBe(true)
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated' }), now)).toBe(true)
  })

  it('allows a scope=work fact when otherwise eligible; importance cannot raise an ineligible record', () => {
    expect(isEligibleForL0(mk({ kind: 'fact', basis: 'user-stated', scope: 'work' }), now)).toBe(true)
    expect(isEligibleForL0(mk({ kind: 'project-summary', basis: 'user-stated', importance: 1 }), now)).toBe(false)
  })
})

describe('buildSnapshotText (Phase 1 §3.4)', () => {
  const now = 1_000_000
  const eligible = (over: Partial<MemoryRecord> = {}): MemoryRecord =>
    rec({ kind: 'fact', basis: 'user-stated', content: 'fact body', ...over })

  it('returns undefined when nothing is eligible', () => {
    expect(buildSnapshotText([rec({ kind: 'fact', basis: 'agent-inferred' })], { topK: 8, now })).toBeUndefined()
  })

  it('renders header + eligible lines, total hard cap 3600', () => {
    const rows = [
      eligible({ id: id('a'), content: 'x'.repeat(600), basis: 'user-stated' }),
      eligible({ id: id('b'), content: 'y'.repeat(700), basis: 'user-stated' }),
    ]
    const text = buildSnapshotText(rows, { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_HARD_MAX_CHARS)
    expect(text).toContain('低优先级长期记忆背景') // frozen header semantics
    expect(text).toContain('|user-stated|')
    expect(text).toContain('[a|')
  })

  it('clamps a config above 3600 back to 3600', () => {
    const rows = Array.from({ length: 30 }, (_, i) => eligible({ id: id(`r${i}`), content: 'z'.repeat(300) }))
    const text = buildSnapshotText(rows, { topK: 30, maxChars: 99_999, now })!
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_HARD_MAX_CHARS)
  })

  it('respects a smaller configured budget', () => {
    const rows = [
      eligible({ id: id('a'), content: 'x'.repeat(200) }),
      eligible({ id: id('b'), content: 'y'.repeat(200) }),
    ]
    // budget large enough for header + one short line but not both lines.
    const text = buildSnapshotText(rows, { topK: 8, maxChars: 400, now })!
    expect(text.length).toBeLessThanOrEqual(400)
    const bodies = (text.match(/\|user-stated\|/g) ?? []).length
    expect(bodies).toBe(1)
  })

  it('skips over-budget lines instead of truncating, and continues with smaller ones', () => {
    // A single line that alone exceeds the hard cap must be skipped, then a
    // smaller record still gets a chance.
    const big = eligible({ id: id('big'), content: 'z'.repeat(4_000), basis: 'user-stated' }) // line ~4k+ > 3600
    const small = eligible({ id: id('small'), content: 'short' })
    const text = buildSnapshotText([big, small], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    expect(text).toContain('[small|')
    expect(text).not.toContain('[big|')
  })

  it('ranks profile, then self, then importance desc', () => {
    const profile = eligible({ id: id('p'), kind: 'profile', content: 'profile body', basis: 'user-stated' })
    const self = eligible({ id: id('s'), kind: 'agent-self', content: 'self body', basis: 'user-stated' })
    const low = eligible({ id: id('low'), content: 'low importance', importance: 0.1 })
    const high = eligible({ id: id('high'), content: 'high importance', importance: 0.9 })
    const text = buildSnapshotText([low, high, self, profile], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    const pIdx = text.indexOf('[p|')
    const sIdx = text.indexOf('[s|')
    const hIdx = text.indexOf('[high|')
    const lIdx = text.indexOf('[low|')
    expect(pIdx).toBeGreaterThan(-1)
    expect(sIdx).toBeGreaterThan(pIdx)
    expect(hIdx).toBeGreaterThan(sIdx)
    expect(lIdx).toBeGreaterThan(hIdx)
  })

  it('caps profile/self lanes at their body caps when content is written by bootstrap/phase1', () => {
    // profile over lane cap is skipped entirely
    const bigProfile = eligible({ id: id('bp'), kind: 'profile', content: 'p'.repeat(901), basis: 'user-stated' })
    const smallProfile = eligible({ id: id('sp'), kind: 'profile', content: 'ok profile', basis: 'user-stated' })
    const text = buildSnapshotText([bigProfile, smallProfile], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    expect(text).not.toContain('[bp|')
    expect(text).toContain('[sp|')
  })

  it('respects topK', () => {
    const rows = Array.from({ length: 10 }, (_, i) => eligible({ id: id(`r${i}`), content: 'ab', basis: 'user-stated' }))
    const text = buildSnapshotText(rows, { topK: 3, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    expect(text.length).toBeGreaterThan(0)
    // 3 records => 3 `|` line markers after header
    const bodies = (text.match(/\|user-stated\|/g) ?? []).length
    expect(bodies).toBe(3)
  })

  it('aggregates the profile lane cap: two profiles totalling >900 leave only one (M2)', () => {
    const p1 = eligible({ id: id('p1'), kind: 'profile', content: 'p'.repeat(600), basis: 'user-stated' })
    const p2 = eligible({ id: id('p2'), kind: 'profile', content: 'q'.repeat(400), basis: 'user-stated' }) // 600+400=1000 > 900
    const text = buildSnapshotText([p2, p1], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    const one = text.includes('[p1|') !== text.includes('[p2|') // exactly one fits the lane
    expect(one).toBe(true)
  })

  it('aggregates the self lane cap: two selves totalling >700 leave only one (M2)', () => {
    const s1 = eligible({ id: id('s1'), kind: 'agent-self', content: 'r'.repeat(500), basis: 'user-stated' })
    const s2 = eligible({ id: id('s2'), kind: 'agent-self', content: 't'.repeat(500), basis: 'user-stated' }) // 500+500=1000>700
    const text = buildSnapshotText([s1, s2], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    const one = text.includes('[s1|') !== text.includes('[s2|') // exactly one of them
    expect(one).toBe(true)
  })

  it('aggregate lane caps allow multiple small profiles that fit the lane (M2)', () => {
    const p1 = eligible({ id: id('p1'), kind: 'profile', content: 'a'.repeat(300), basis: 'user-stated' })
    const p2 = eligible({ id: id('p2'), kind: 'profile', content: 'b'.repeat(300), basis: 'user-stated' })
    const p3 = eligible({ id: id('p3'), kind: 'profile', content: 'c'.repeat(300), basis: 'user-stated' }) // 900 total exactly
    const text = buildSnapshotText([p1, p2, p3], { topK: 8, maxChars: SNAPSHOT_HARD_MAX_CHARS, now })!
    expect(text).toContain('[p1|')
    expect(text).toContain('[p2|')
    expect(text).toContain('[p3|')
  })
})

describe('normalizeSnapshotBudget (M3)', () => {
  const now = 1_000_000
  const eligible = (over: Partial<MemoryRecord> = {}): MemoryRecord =>
    rec({ kind: 'fact', basis: 'user-stated', content: 'fact body', ...over })

  it('respects budgets below 256 (no silent enlargement)', () => {
    const rows = [eligible({ id: id('a'), content: 'tiny' })]
    // 100 chars fits header + tiny line? header ~57 + line ~90 -> ~150 > 100.
    // use 200 to prove <256 is respected (not forced to 256).
    const text = buildSnapshotText(rows, { topK: 8, maxChars: 200, now })!
    expect(text.length).toBeLessThanOrEqual(200)
  })

  it('an extremely small budget that fits nothing yields undefined', () => {
    const rows = [eligible({ id: id('a'), content: 'x'.repeat(300) })]
    expect(buildSnapshotText(rows, { topK: 8, maxChars: 50, now })).toBeUndefined()
  })

  it('clamps >3600 back to 3600', () => {
    const rows = Array.from({ length: 30 }, (_, i) => eligible({ id: id(`r${i}`), content: 'z'.repeat(300) }))
    const text = buildSnapshotText(rows, { topK: 30, maxChars: 99_999, now })!
    expect(text.length).toBeLessThanOrEqual(SNAPSHOT_HARD_MAX_CHARS)
  })

  it('treats maxChars=0 as "nothing fits" → returns undefined (R1, not raised)', () => {
    const rows = [eligible({ id: id('a'), content: 'stable fact', basis: 'user-stated' })]
    expect(buildSnapshotText(rows, { topK: 8, maxChars: 0, now })).toBeUndefined()
  })

  it('normalizes non-finite/negative/NaN budgets to the 3600 default (R1)', () => {
    const rows = [eligible({ id: id('a'), content: 'stable fact' })]
    for (const bad of [Number.NaN, Infinity, -10]) {
      const text = buildSnapshotText(rows, { topK: 8, maxChars: bad, now })!
      expect(text).toBeDefined()
      expect(text.length).toBeLessThanOrEqual(SNAPSHOT_HARD_MAX_CHARS)
    }
  })
})

describe('isEligibleForL0 reviewer validation (M4)', () => {
  const now = 1_000_000
  it('rejects a whitespace-only reviewedBy even with reviewedAt present', () => {
    const row = rec({ kind: 'fact', basis: 'agent-inferred', reviewedAt: 100, reviewedBy: '   ' })
    expect(isEligibleForL0(row, now)).toBe(false)
  })

  it('accepts a non-blank reviewedBy with reviewedAt (fallback trust path)', () => {
    const row = rec({ kind: 'fact', basis: 'agent-inferred', reviewedAt: 100, reviewedBy: 'ops' })
    expect(isEligibleForL0(row, now)).toBe(true)
  })
})

describe('resolveMemory interplay with L0 (legacy imported never enters L0)', () => {
  it('legacy rows (no schemaVersion, no basis) resolve to imported → not L0', () => {
    const legacy = rec({ content: 'x'.repeat(1200) })
    const resolved = resolveMemory(legacy)
    expect(resolved.basis).toBe('imported')
    expect(isEligibleForL0(legacy, 1_000_000)).toBe(false)
  })

  it('new schemaVersion-1 user-stated rows resolve schemaVersion 1 and can enter L0', () => {
    const row = rec({ schemaVersion: RECORD_SCHEMA_VERSION, kind: 'fact', basis: 'user-stated' })
    expect(resolveMemory(row).schemaVersion).toBe(1)
    expect(isEligibleForL0(row, 1_000_000)).toBe(true)
  })
})
