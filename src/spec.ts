import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** v0.3 record-level schema version marker (distinct from domain version 0). */
export const RECORD_SCHEMA_VERSION = 1

export type MemoryId = string & { readonly __memoryId: unique symbol }
export type MemoryValue = string | number | boolean

/** One past body of a keyed current record; the array is kept oldest → newest, capped at MAX_REVISIONS. */
export interface MemoryRevision {
  readonly content: string
  readonly updatedAt: number
  readonly replacedBy?: MemoryId
  readonly reason?: string
}

/**
 * Deletion receipt: minimal, non-reconstructable audit row stored in the
 * `deletions` table. Deliberately carries NO content/embedding/revisions/
 * summary/evidence that could rebuild the deleted body.
 */
export interface DeletionReceipt {
  readonly id: string
  readonly key?: string
  readonly scope?: string
  readonly deletedAt: number
  readonly deletedBy: string
  readonly reason?: string
}

/** Opaque physical row id of a deletion receipt (branded like MemoryId). */
export type ReceiptId = string & { readonly __receiptId: unique symbol }

/**
 * One durable, globally visible memory. Global scope is a deliberate product
 * policy. The persisted schema stays `version: 0` (M1): v0.3 fields are ALL
 * optional so existing v0 rows keep parsing and the medium keeps opening.
 */
export interface MemoryRecord {
  readonly id: MemoryId
  readonly content: string
  readonly scope?: string
  readonly key?: string
  readonly importance?: number
  readonly value?: MemoryValue
  readonly createdAt: number
  readonly updatedAt: number
  readonly deleted?: boolean
  readonly supersededBy?: MemoryId
  readonly evidenceIds?: MemoryId[]
  readonly embedding?: number[]
  readonly embeddingPending?: boolean
  /** Phase 2: bounded past bodies of a keyed current (oldest → newest, ≤ MAX_REVISIONS). */
  readonly revisions?: MemoryRevision[]

  // ===== v0.3 optional metadata (NOT yet exposed as tool parameters in Phase 0) =====
  /** Record-level layout marker; distinct from domain version (see M1). Only `1` is a valid v0.3 value; absent = legacy v0 row (M4). */
  readonly schemaVersion?: typeof RECORD_SCHEMA_VERSION
  readonly kind?: 'profile' | 'preference' | 'fact' | 'project-summary' | 'agent-self' | 'reference'
  readonly basis?: 'user-stated' | 'agent-inferred' | 'external-unverified' | 'imported'
  readonly sensitivity?: 'normal' | 'restricted'
  readonly writeReason?: string
  readonly source?: { readonly sessionId?: string; readonly toolCallId?: string; readonly entrypoint?: string }
  readonly evidenceEventSeqs?: number[]
  readonly reviewedAt?: number
  readonly reviewedBy?: string
  readonly retiredAt?: number
  readonly retiredReason?: string
  readonly expiresAt?: number
  readonly embeddingModel?: string
  readonly embeddingDim?: number
  readonly contentHash?: string
}

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  content: z.string().trim().min(1).max(2_000),
  scope: z.string().trim().min(1).max(80).optional(),
  key: z.string().trim().min(1).max(160).optional(),
  importance: z.number().min(0).max(1).optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  deleted: z.boolean().optional(),
  supersededBy: z.string().min(1).optional(),
  evidenceIds: z.array(z.string().min(1)).optional(),
  embedding: z.array(z.number().finite()).optional(),
  embeddingPending: z.boolean().optional(),
  revisions: z.array(z.object({
    content: z.string().trim().min(1).max(2_000),
    updatedAt: z.number().int().nonnegative(),
    replacedBy: z.string().min(1).optional(),
    reason: z.string().min(1).max(500).optional(),
  })).max(10).optional(),

  // Optional v0.3 metadata (Phase 0: parse-preserving, not yet written by tools).
  schemaVersion: z.literal(RECORD_SCHEMA_VERSION).optional(),
  kind: z.enum(['profile', 'preference', 'fact', 'project-summary', 'agent-self', 'reference']).optional(),
  basis: z.enum(['user-stated', 'agent-inferred', 'external-unverified', 'imported']).optional(),
  sensitivity: z.enum(['normal', 'restricted']).optional(),
  writeReason: z.string().min(1).max(500).optional(),
  source: z.object({
    sessionId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
    entrypoint: z.string().min(1).optional(),
  }).optional(),
  evidenceEventSeqs: z.array(z.number().int().nonnegative()).optional(),
  reviewedAt: z.number().int().nonnegative().optional(),
  // M4: reviewer must be a non-blank server-side identifier — reject
  // whitespace-only values at the durable boundary too.
  reviewedBy: z.string().trim().min(1).optional(),
  retiredAt: z.number().int().nonnegative().optional(),
  retiredReason: z.string().min(1).max(500).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
  embeddingModel: z.string().min(1).optional(),
  embeddingDim: z.number().int().nonnegative().optional(),
  // Phase 3: server-generated SHA-256 of the exact UTF-8 content; fixed
  // lowercase 64-char hex. Still optional so legacy v0 rows keep opening.
  contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}) as unknown as z.ZodType<MemoryRecord>

/** Durable schema for a deletion receipt: whitelist only, no reconstructable body. */
export const deletionReceiptSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  deletedAt: z.number().int().nonnegative(),
  // Server-generated (tool:.../session:...), always present.
  deletedBy: z.string().trim().min(1),
  reason: z.string().min(1).max(500).optional(),
}) as unknown as z.ZodType<DeletionReceipt>

export const memoryDomainSpec = defineDomain({
  name: 'agent_memories',
  version: 0,
  tables: {
    memories: domainTable<MemoryId, MemoryRecord>(memoryRecordSchema),
    // Phase 2: minimal audit receipts; version stays 0 (the sqlite backend
    // materializes new tables with CREATE TABLE IF NOT EXISTS without bumping
    // the unit version — see M1/§3.2).
    deletions: domainTable<ReceiptId, DeletionReceipt>(deletionReceiptSchema),
  },
})

// The zod object's inferred output is `string`-keyed; the domain record type is
// branded as `MemoryId`; the cast is intentional at the storage-domain boundary.
