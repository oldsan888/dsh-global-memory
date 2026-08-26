import { describe, expect, it, vi } from 'vitest'
import {
  PROFILE_KEY, SELF_KEY, RECORD_SCHEMA_VERSION, resolveMemory,
  DEFAULT_AUTO_MAX_CHARS, features, similarity, keywordScore, cosine,
  embeddingEnabled, embed, injectedRecords, active,
} from '../src/memory-core.ts'
import type { MemoryId } from '../src/spec.ts'

const id = (n: string) => n as MemoryId

function rec(overrides: Partial<Parameters<typeof resolveMemory>[0]> = {}): Parameters<typeof resolveMemory>[0] {
  return {
    id: id('m-test'), content: 'c', createdAt: 1, updatedAt: 1,
    ...overrides,
  }
}

describe('CJK/English feature extraction', () => {
  it('emits lowercase word tokens for latin text', () => {
    const f = features('Memory Plugin Beta 2')
    expect(f.has('memory')).toBe(true)
    expect(f.has('plugin')).toBe(true)
    expect(f.has('beta')).toBe(true)
    expect(f.has('be')).toBe(false) // short tokens dropped
  })

  it('emits han bigrams for chinese text', () => {
    const f = features('中文记忆')
    expect(f.has('han:中文')).toBe(true)
    expect(f.has('han:文记')).toBe(true)
    expect(f.has('han:记忆')).toBe(true)
  })

  it('mixes latin and han features for mixed content', () => {
    const f = features('bge-m3 语义召回')
    expect(f.has('bge')).toBe(true)
    expect(f.has('han:语义')).toBe(true)
    expect(f.has('han:召回')).toBe(true)
  })
})

describe('similarity (Jaccard over features)', () => {
  it('is 1 for identical text', () => {
    expect(similarity('identical phrase here', 'identical phrase here')).toBe(1)
  })

  it('is 0 when either side is empty', () => {
    expect(similarity('', 'anything')).toBe(0)
    expect(similarity('anything', '')).toBe(0)
  })

  it('is higher for overlapping han text than disjoint text', () => {
    const near = similarity('用户偏好中文回复', '用户偏好中文回答')
    const far = similarity('用户偏好中文回复', '今天天气很好')
    expect(near).toBeGreaterThan(far)
  })
})

describe('keywordScore', () => {
  it('scores a record by query-term presence across content+scope+key', () => {
    const r = rec({ content: '示例用户喜欢简洁中文回复', scope: 'communication', key: 'comm-style' })
    expect(keywordScore('示例', r)).toBe(1)
    expect(keywordScore('communication 示例', r)).toBe(1) // scope hits too
    expect(keywordScore('运营商套餐', r)).toBe(0)
  })
})

describe('cosine', () => {
  it('returns 1 for identical, 0 for orthogonal', () => {
    expect(cosine([1, 0], [1, 0])).toBe(1)
    expect(cosine([1, 0], [0, 1])).toBe(0)
  })

  it('returns 0 on absent or dimension-mismatched vectors', () => {
    expect(cosine(undefined, [1])).toBe(0)
    expect(cosine([1, 2], [1, 2, 3])).toBe(0)
  })
})

describe('embeddingEnabled / embed', () => {
  it('is disabled unless fully configured', () => {
    expect(embeddingEnabled(undefined)).toBe(false)
    expect(embeddingEnabled({ enabled: true })).toBe(false)
    expect(embeddingEnabled({ enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' })).toBe(true)
  })

  it('fail-opens on non-2xx responses', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch
    try {
      const v = await embed('text', { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' })
      expect(v).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('fail-opens on malformed body', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch
    try {
      const v = await embed('text', { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' })
      expect(v).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('fail-opens on dimension mismatch', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 })) as typeof fetch
    try {
      const v = await embed('text', { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm', dim: 1024 })
      expect(v).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not crash on thrown/rejected fetches (timeout, network)', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => { throw new Error('aborted') }) as typeof fetch
    try {
      const v = await embed('text', { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' })
      expect(v).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('fail-opens on HTTP 200 with genuinely unparseable JSON body', async () => {
    const original = globalThis.fetch
    // 200 OK but `response.json()` throws on the body text.
    globalThis.fetch = (async () => new Response('{ this is not json', { status: 200 })) as typeof fetch
    try {
      const v = await embed('text', { enabled: true, baseUrl: 'http://x', apiKey: 'k', model: 'm' })
      expect(v).toBeUndefined()
    } finally {
      globalThis.fetch = original
    }
  })

  it('never calls fetch when embedding is disabled (fail-open entry behaviour)', async () => {
    const original = globalThis.fetch
    const spy = vi.fn(async () => new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), { status: 200 }))
    globalThis.fetch = spy as unknown as typeof fetch
    try {
      const v = await embed('text', undefined)
      expect(v).toBeUndefined()
      const v2 = await embed('text', { enabled: false, baseUrl: 'http://x', apiKey: 'k', model: 'm' })
      expect(v2).toBeUndefined()
      expect(spy).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('active', () => {
  it('excludes soft-deleted and superseded records', () => {
    expect(active(rec())).toBe(true)
    expect(active(rec({ deleted: true }))).toBe(false)
    expect(active(rec({ supersededBy: id('other') }))).toBe(false)
  })
})

describe('injectedRecords (pre-upgrade ordering + budget)', () => {
  const mk = (over: Partial<Parameters<typeof resolveMemory>[0]>): Parameters<typeof resolveMemory>[0] =>
    rec({ importance: 0.2, updatedAt: 1, ...over })

  it('ranks profile, then self, then importance, then recency', () => {
    const profile = mk({ id: id('p'), key: PROFILE_KEY, importance: 0.1 })
    const self = mk({ id: id('s'), key: SELF_KEY, importance: 0.1 })
    const high = mk({ id: id('h'), importance: 0.9 })
    const low = mk({ id: id('l'), importance: 0.1, updatedAt: 999 })
    const chosen = injectedRecords([self, low, high, profile], 10, 9999)
    expect(chosen.map(r => r.id)).toEqual([id('p'), id('s'), id('h'), id('l')])
  })

  it('skips over-length records instead of truncating, keeping smaller ones', () => {
    const big = mk({ id: id('big'), content: 'x'.repeat(500), importance: 0.9 })
    const small = mk({ id: id('small'), content: 'yyy', importance: 0.1 })
    // budget: big rendered ~500+32 > 300 -> skipped; small fits
    const chosen = injectedRecords([big, small], 10, 300)
    expect(chosen.length).toBe(1)
    expect(chosen[0].id).toBe(id('small'))
  })

  it('respects top-K when everything fits', () => {
    const rows = Array.from({ length: 10 }, (_, i) => mk({ id: id(`r${i}`), importance: 0.9 - i * 0.01 }))
    const chosen = injectedRecords(rows, 4, 9999)
    expect(chosen.length).toBe(4)
  })

  it('fits a record exactly at the default 3600-char budget boundary', () => {
    // rendered = content.length + (scope.length ?? 0) + 32; budget 3600.
    // content 3567 + scope 1 + 32 = 3600 -> exactly fits.
    const exactly = mk({ id: id('fit'), content: 'x'.repeat(3567), scope: 'w', importance: 0.5 })
    const chosen = injectedRecords([exactly], 10, DEFAULT_AUTO_MAX_CHARS)
    expect(chosen.length).toBe(1)
    expect(chosen[0].id).toBe(id('fit'))
  })

  it('skips a record over the default 3600 budget by 1 char and continues with a smaller one', () => {
    // rendered of `over` = 3568 + 1 + 32 = 3601 (>3600) -> skipped.
    const over = mk({ id: id('over'), content: 'x'.repeat(3568), scope: 'w', importance: 0.9 })
    const small = mk({ id: id('after'), content: 'yyy', importance: 0.1 })
    const chosen = injectedRecords([over, small], 10, DEFAULT_AUTO_MAX_CHARS)
    expect(chosen.length).toBe(1)
    expect(chosen[0].id).toBe(id('after'))
  })

  it('uses DEFAULT_AUTO_MAX_CHARS (3600) as the default when no budget is configured', () => {
    expect(DEFAULT_AUTO_MAX_CHARS).toBe(3600)
  })
})

describe('resolveMemory (legacy compatibility, M1)', () => {
  it('marks legacy rows as schemaVersion 0 and retired false', () => {
    const resolved = resolveMemory(rec({ content: 'legacy row' }))
    expect(resolved.schemaVersion).toBe(0)
    expect(resolved.retired).toBe(false)
    expect(resolved.sensitivity).toBe('normal')
  })

  it('interprets legacy deleted:true as retired without mutating the record', () => {
    const row = rec({ deleted: true, content: 'old' })
    const resolved = resolveMemory(row)
    expect(resolved.retired).toBe(true)
    expect(resolved.deleted).toBe(true) // stored flag untouched
  })

  it('labels profile/self keys with their kind when kind is absent', () => {
    expect(resolveMemory(rec({ key: PROFILE_KEY })).kind).toBe('profile')
    expect(resolveMemory(rec({ key: SELF_KEY })).kind).toBe('agent-self')
  })

  it('preserves a stored schemaVersion:1 and v0.3 metadata', () => {
    const resolved = resolveMemory(rec({
      schemaVersion: RECORD_SCHEMA_VERSION,
      kind: 'fact', basis: 'user-stated', sensitivity: 'restricted',
    }))
    expect(resolved.schemaVersion).toBe(1)
    expect(resolved.kind).toBe('fact')
    expect(resolved.basis).toBe('user-stated')
    expect(resolved.sensitivity).toBe('restricted')
  })

  it('never auto-promotes a legacy profile/self row to user-stated (basis=imported, M3)', () => {
    const profile = resolveMemory(rec({ key: PROFILE_KEY }))
    const self = resolveMemory(rec({ key: SELF_KEY }))
    expect(profile.kind).toBe('profile')
    expect(profile.basis).toBe('imported')
    expect(self.kind).toBe('agent-self')
    expect(self.basis).toBe('imported')
  })
})
