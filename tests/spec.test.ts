import { describe, expect, it } from 'vitest'
import { memoryRecordSchema, deletionReceiptSchema, memoryDomainSpec } from '../src/spec.ts'

describe('global memory durable record', () => {
  it('accepts a bounded active memory record', () => {
    expect(memoryRecordSchema.parse({
      id: 'm-1',
      content: 'The user prefers concise Chinese responses.',
      scope: 'preference',
      key: 'response-style',
      importance: 0.9,
      createdAt: 1,
      updatedAt: 1,
      embedding: [0.1, 0.2],
    })).toMatchObject({ id: 'm-1', scope: 'preference' })
  })

  it('rejects oversized content and non-finite vectors before persistence', () => {
    expect(() => memoryRecordSchema.parse({
      id: 'm-2', content: 'x'.repeat(2_001), createdAt: 1, updatedAt: 1,
    })).toThrow()
    expect(() => memoryRecordSchema.parse({
      id: 'm-3', content: 'valid', createdAt: 1, updatedAt: 1, embedding: [Number.NaN],
    })).toThrow()
  })
})

describe('Phase 0 legacy compatibility (M1: version stays 0, v0 rows keep parsing)', () => {
  it('parses a legacy row with content > 800 chars (future per-kind cap)', () => {
    const over800 = 'x'.repeat(801)
    expect(memoryRecordSchema.parse({
      id: 'm-legacy-800', content: over800, createdAt: 1, updatedAt: 1,
    }).content).toHaveLength(801)
  })

  it('parses a legacy row with content > 1000 chars (current hot-pool longs)', () => {
    const over1000 = '工程状态'.repeat(300) // 1200 chars
    const parsed = memoryRecordSchema.parse({
      id: 'm-legacy-1000', content: over1000, scope: 'work', createdAt: 1, updatedAt: 1,
    })
    expect(parsed.content.length).toBeGreaterThan(1000)
  })

  it('parses a row carrying URL-escaped windows paths and CJK (real row shape)', () => {
    const parsed = memoryRecordSchema.parse({
      id: 'm-windows', content: '【DSH 宿主现状】DSH_HOME 已迁移到 E:\\huimou\\AI-Model-Test\\Deepseek-ui\\dsh-home，profiles/sessions/storages 全部就位',
      scope: 'work', createdAt: 1, updatedAt: 1,
    })
    expect(parsed.scope).toBe('work')
  })

  it('accepts v0.3 optional metadata without breaking legacy reads', () => {
    expect(memoryRecordSchema.parse({
      id: 'm-v03',
      content: 'v0.3 fact',
      createdAt: 1, updatedAt: 1,
      schemaVersion: 1,
      kind: 'fact',
      basis: 'user-stated',
      sensitivity: 'normal',
      source: { sessionId: 's1', toolCallId: 'c1' },
      expiresAt: 1_000,
    }).kind).toBe('fact')
  })

  it('narrows schemaVersion to the frozen literal 1 (M4)', () => {
    // Runtime: version 1 is accepted.
    const parsed = memoryRecordSchema.parse({
      id: 'm-ver1', content: 'v1', createdAt: 1, updatedAt: 1, schemaVersion: 1,
    })
    expect(parsed.schemaVersion).toBe(1)
    // Runtime: any other version is rejected by the zod literal.
    expect(() => memoryRecordSchema.parse({
      id: 'm-ver2', content: 'v2', createdAt: 1, updatedAt: 1, schemaVersion: 2,
    })).toThrow()
    expect(() => memoryRecordSchema.parse({
      id: 'm-ver0', content: 'v0', createdAt: 1, updatedAt: 1, schemaVersion: 0,
    })).toThrow()
  })

  it('forbids constructing a non-1 schemaVersion at compile time (M4)', () => {
    // @ts-expect-error schemaVersion is typed as the frozen literal 1, not number
    const invalid: { schemaVersion: typeof import('../src/spec.ts').RECORD_SCHEMA_VERSION } = { schemaVersion: 2 }
    void invalid
  })
})

describe('Phase 2: revisions on the memory record', () => {
  it('parses a legacy memory with a bounded revisions array', () => {
    const parsed = memoryRecordSchema.parse({
      id: 'm-rev', content: 'current body', createdAt: 1, updatedAt: 2, schemaVersion: 1,
      revisions: [
        { content: 'old body 1', updatedAt: 1, reason: 'replaced' },
        { content: 'old body 0', updatedAt: 0 },
      ],
    })
    expect(parsed.revisions).toHaveLength(2)
    expect(parsed.revisions![1].reason).toBeUndefined()
  })

  it('rejects malformed revision entries (missing content/updatedAt, bad reason length)', () => {
    expect(() => memoryRecordSchema.parse({
      id: 'm-bad', content: 'c', createdAt: 1, updatedAt: 1,
      revisions: [{ updatedAt: 1 }],
    })).toThrow()
    expect(() => memoryRecordSchema.parse({
      id: 'm-bad2', content: 'c', createdAt: 1, updatedAt: 1,
      revisions: [{ content: 'x', updatedAt: 1, reason: 'r'.repeat(501) }],
    })).toThrow()
  })
})

describe('Phase 2: deletion receipts (whitelist schema)', () => {
  it('accepts a minimal receipt without any body/embedding/revision fields', () => {
    const parsed = deletionReceiptSchema.parse({
      id: 'mem-1', deletedAt: 100, deletedBy: 'session:s1/tool:c1',
    })
    expect(parsed).toEqual({ id: 'mem-1', deletedAt: 100, deletedBy: 'session:s1/tool:c1' })
  })

  it('accepts optional key/scope/reason', () => {
    const parsed = deletionReceiptSchema.parse({
      id: 'mem-2', key: 'k1', scope: 'work', deletedAt: 100, deletedBy: 'tool:c1', reason: 'cleanup',
    })
    expect(parsed.key).toBe('k1')
    expect(parsed.reason).toBe('cleanup')
  })

  it('strips any body-like smuggled fields at the durable boundary (whitelist)', () => {
    const base = { id: 'm', deletedAt: 1, deletedBy: 'tool:c1' }
    // z.object strips unknown keys: whatever extra shape arrives, the stored
    // receipt can never contain content/embedding/revisions/summary.
    const parsed = deletionReceiptSchema.parse({ ...base, content: 'secret body', embedding: [0.1], revisions: [], summary: 'snippet' } as never) as unknown as Record<string, unknown>
    expect(parsed).not.toHaveProperty('content')
    expect(parsed).not.toHaveProperty('embedding')
    expect(parsed).not.toHaveProperty('revisions')
    expect(parsed).not.toHaveProperty('summary')
  })

  it('rejects a blank deletedBy', () => {
    expect(() => deletionReceiptSchema.parse({
      id: 'm', deletedAt: 1, deletedBy: '   ',
    })).toThrow()
  })
})

describe('Phase 2: domain keeps version 0 with both tables', () => {
  it('declares version 0 and exposes memories + deletions', () => {
    expect(memoryDomainSpec.version).toBe(0)
    expect(Object.keys(memoryDomainSpec.tables).sort()).toEqual(['deletions', 'memories'])
  })
})
