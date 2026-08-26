/**
 * Phase 4 governance: deterministic, idempotent RE-CLASSIFICATION only.
 *
 * Frozen scope (final decisions 2026-08-21 §2.2):
 * - never compresses, deletes or rewrites record bodies;
 * - only moves a record's `kind` between `project-summary` and `reference`;
 * - content / embedding / revisions / source / id / key / scope are untouched;
 * - the manifest stores NO content — only id, expected contentHash, expected
 *   updatedAt, fromKind, toKind and action;
 * - BEFORE any write the whole manifest is validated (missing row, content
 *   hash drift, updatedAt drift, kind drift). Any PRE-FLIGHT drift rejects the
 *   entire batch with zero writes.
 * - idempotent: re-running an applied manifest yields zero changes.
 * - real-database application is a post-Phase-4 deployment gate: this module
 *   runs dry-run by default and only writes with an explicit apply flag while
 *   DSH is stopped. rc.5 KvTable has no multi-record transaction, so a live
 *   concurrent writer is outside this runner's contract.
 *
 * Body-agnostic: this module never reads or outputs `content`.
 */

import { hashContent } from './memory-core.ts'
import type { MemoryKind } from './memory-core.ts'
import type { MemoryRecord } from './spec.ts'

export type GovernanceAction = 'reclassify'

/** Target kinds allowed by the frozen long-record decision (§2.2). */
export type ReclassifyTargetKind = 'project-summary' | 'reference'

export interface ReclassifyEntry {
  id: string
  /** SHA-256 of the EXACT current body at manifest time. */
  expectedContentHash: string
  /** Server updatedAt at manifest time. */
  expectedUpdatedAt: number
  /** Stored kind expected at apply time; null = legacy row without stored kind. */
  fromKind: MemoryKind | null
  toKind: ReclassifyTargetKind
  action: GovernanceAction
}

export type GovernanceStatus = 'planned' | 'changed' | 'skipped' | 'conflict'
export type GovernanceConflictReason =
  | 'missing'
  | 'hash-drift'
  | 'updatedAt-drift'
  | 'kind-drift'
  | 'update-rejected'
  | 'batch-aborted'

export interface GovernanceEntryResult {
  id: string
  status: GovernanceStatus
  conflict?: GovernanceConflictReason
}

export interface GovernanceRunResult {
  mode: 'dry-run' | 'apply'
  /** True when ANY drift was found: the batch was rejected with zero writes. */
  aborted: boolean
  planned: number
  changed: number
  skipped: number
  conflicts: number
  entries: GovernanceEntryResult[]
}

/** Minimal table surface: the real rc.5 storage-domain contract subset. */
export interface GovernanceTable {
  get(id: string): MemoryRecord | undefined
  update(id: string, fn: (current: MemoryRecord) => MemoryRecord): Promise<MemoryRecord>
}

/** Internal guard: in-callback re-validation failed (concurrent writer). */
export class GovernanceUpdateRejected extends Error {
  constructor(id: string) {
    super(`governance apply stopped: concurrent drift on record ${String(id)}`)
  }
}

const MEMORY_KINDS = new Set<MemoryKind>(['profile', 'preference', 'fact', 'project-summary', 'agent-self', 'reference'])
const TARGET_KINDS = new Set<ReclassifyTargetKind>(['project-summary', 'reference'])
const SHA256_HEX = /^[0-9a-f]{64}$/

/**
 * JSON manifests enter at runtime, where TypeScript unions provide no safety.
 * Validate the complete manifest before reading/updating any record so an
 * invalid target/action/hash, malformed timestamp or duplicate id is a
 * deterministic zero-write configuration error.
 */
function validateManifest(manifest: readonly ReclassifyEntry[]): void {
  if (!Array.isArray(manifest)) throw new TypeError('governance manifest must be an array')
  const ids = new Set<string>()
  for (const [index, raw] of manifest.entries()) {
    const entry = raw as Partial<ReclassifyEntry> | null
    if (!entry || typeof entry !== 'object') throw new TypeError(`governance manifest[${index}] must be an object`)
    if (typeof entry.id !== 'string' || entry.id.trim().length === 0) throw new TypeError(`governance manifest[${index}].id must be non-blank`)
    if (ids.has(entry.id)) throw new TypeError(`governance manifest contains duplicate id: ${entry.id}`)
    ids.add(entry.id)
    if (entry.action !== 'reclassify') throw new TypeError(`governance manifest[${index}].action must be reclassify`)
    if (!TARGET_KINDS.has(entry.toKind as ReclassifyTargetKind)) throw new TypeError(`governance manifest[${index}].toKind must be project-summary or reference`)
    if (entry.fromKind !== null && !MEMORY_KINDS.has(entry.fromKind as MemoryKind)) throw new TypeError(`governance manifest[${index}].fromKind is invalid`)
    if (typeof entry.expectedContentHash !== 'string' || !SHA256_HEX.test(entry.expectedContentHash)) throw new TypeError(`governance manifest[${index}].expectedContentHash must be lowercase SHA-256`)
    if (!Number.isInteger(entry.expectedUpdatedAt) || (entry.expectedUpdatedAt as number) < 0) throw new TypeError(`governance manifest[${index}].expectedUpdatedAt must be a non-negative integer`)
  }
}

function storedKind(row: MemoryRecord): MemoryKind | null {
  return row.kind ?? null
}

function validateEntry(
  row: MemoryRecord | undefined,
  entry: ReclassifyEntry,
): GovernanceConflictReason | undefined {
  if (row === undefined) return 'missing'
  if (hashContent(row.content) !== entry.expectedContentHash) return 'hash-drift'
  if (row.updatedAt !== entry.expectedUpdatedAt) return 'updatedAt-drift'
  const kind = storedKind(row)
  if (kind !== entry.fromKind && kind !== entry.toKind) return 'kind-drift'
  return undefined
}

/**
 * Run one governance manifest. Default mode is dry-run: every valid entry is
 * reported `planned` and NOTHING is written. With `apply: true`, valid entries
 * are reclassified (kind only) via the domain's atomic `table.update`; entries
 * already at `toKind` are `skipped` (idempotence). Any drift — even on a
 * single entry — rejects the whole batch BEFORE any write (zero partial
 * updates). The update callback re-validates hash/updatedAt/kind against the
 * manifest and throws `GovernanceUpdateRejected` on in-flight drift so the
 * changed row is never silently overwritten. Because rc.5 exposes no
 * multi-record transaction, apply requires a quiescent database (DSH stopped);
 * the Phase 4 acceptance runs it only on a copy.
 */
export async function runGovernance(
  table: GovernanceTable,
  manifest: readonly ReclassifyEntry[],
  options: { apply: boolean },
): Promise<GovernanceRunResult> {
  validateManifest(manifest)
  const entries: GovernanceEntryResult[] = []
  const conflicts: Array<{ id: string; reason: GovernanceConflictReason }> = []

  // Phase 1 — validate EVERYTHING, write NOTHING.
  for (const entry of manifest) {
    const reason = validateEntry(table.get(entry.id), entry)
    if (reason !== undefined) conflicts.push({ id: entry.id, reason })
  }
  if (conflicts.length > 0) {
    const conflictIds = new Set(conflicts.map(c => c.id))
    for (const entry of manifest) {
      const own = conflicts.find(c => c.id === entry.id)
      entries.push({
        id: entry.id,
        status: 'conflict',
        conflict: own?.reason ?? 'batch-aborted',
      })
    }
    return {
      mode: options.apply ? 'apply' : 'dry-run',
      aborted: true,
      planned: 0,
      changed: 0,
      skipped: 0,
      conflicts: conflicts.length,
      entries,
    }
  }

  // Phase 2 — every entry is valid; apply (kind only) or report planned.
  let planned = 0
  let changed = 0
  let skipped = 0
  for (const entry of manifest) {
    const row = table.get(entry.id)
    if (row === undefined) {
      // unreachable after phase 1 on a quiescent table (defensive)
      entries.push({ id: entry.id, status: 'conflict', conflict: 'missing' })
      conflicts.push({ id: entry.id, reason: 'missing' })
      continue
    }
    if (storedKind(row) === entry.toKind) {
      skipped++
      entries.push({ id: entry.id, status: 'skipped' })
      continue
    }
    if (!options.apply) {
      planned++
      entries.push({ id: entry.id, status: 'planned' })
      continue
    }
    // Atomic, in-place kind-only update through the REAL domain contract.
    await table.update(entry.id, (current) => {
      const drift = validateEntry(current, entry)
      if (drift !== undefined) throw new GovernanceUpdateRejected(entry.id)
      // Only the classification metadata field changes; body, embedding,
      // revisions, source, id/key/scope, updatedAt all stay identical.
      return { ...current, kind: entry.toKind }
    })
    changed++
    entries.push({ id: entry.id, status: 'changed' })
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    aborted: false,
    planned,
    changed,
    skipped,
    conflicts: conflicts.length,
    entries,
  }
}
