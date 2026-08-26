/**
 * Deterministic golden-set vector fixture (Phase 3 rework, E3).
 *
 * Vectors derive ONLY from (cluster seed, stable item id / case name) — NEVER
 * from record content or query text. The "semantic" overlap between a query
 * and the records it should hit is thus a property of the CLUSTER ASSIGNMENT
 * in `recall-golden.json`, not of any synonym phrase pasted into the query.
 * This removes the answer leakage that the Phase 3 review flagged (E3):
 * a hybrid case passes because query and target share a cluster, with the
 * query's own text lexically disjoint from the target body.
 *
 * Pure math only (node:crypto for hashing) so the golden calibration runner
 * can import this file directly with Node's type stripping.
 */

import { createHash } from 'node:crypto'

/** Model name stamped on every golden record's vector metadata. */
export const GOLDEN_MODEL = 'golden-stub'

/** Per-item tilt magnitude: keeps same-cluster cosines below 1.0 and above 0.90. */
export const GOLDEN_TILT = 0.12

export interface GoldenClusterPart {
  cluster: string
  weight: number
}

export interface GoldenRecordLike {
  id: string
  cluster?: string
  vectorMix?: GoldenClusterPart[]
}

export interface GoldenCaseLike {
  name: string
  cluster?: string
  mix?: GoldenClusterPart[]
}

/** Deterministic pseudo-random unit vector from a stable seed string. */
export function seededUnitVector(seed: string, dim: number): number[] {
  const digest = createHash('sha256').update(seed, 'utf8').digest()
  const raw = new Array<number>(dim).fill(0)
  for (let i = 0; i < 8; i++) {
    const index = digest[i] % dim
    raw[index] += 1 + (digest[8 + i] % 3)
  }
  const norm = Math.sqrt(raw.reduce((sum, x) => sum + x * x, 0))
  return norm === 0 ? raw : raw.map(x => x / norm)
}

/** One cluster's canonical vector (weighted sum over parts when `mix` present). */
export function clusterVector(cluster: string, dim: number): number[] {
  return seededUnitVector(`cluster:${cluster}`, dim)
}

function weightedSum(parts: GoldenClusterPart[], dim: number): number[] {
  const acc = new Array<number>(dim).fill(0)
  for (const { cluster, weight } of parts) {
    const v = clusterVector(cluster, dim)
    for (let i = 0; i < dim; i++) acc[i] += weight * v[i]
  }
  const norm = Math.sqrt(acc.reduce((sum, x) => sum + x * x, 0))
  return acc.map(x => x / norm)
}

/**
 * A record's vector: its cluster (or explicit `vectorMix`), plus a small
 * per-id tilt (0.12 of an id-seeded unit vector). The tilt is content-free —
 * it only breaks exact ties between records of the same cluster.
 * Records with NO cluster and NO vectorMix get `undefined` (vector path
 * unavailable; such a record is only reachable lexically).
 */
export function recordVector(record: GoldenRecordLike, dim: number): number[] | undefined {
  if (!record.cluster && !record.vectorMix) return undefined
  const base = record.vectorMix ? weightedSum(record.vectorMix, dim) : clusterVector(record.cluster!, dim)
  const tilt = seededUnitVector(`item:${record.id}`, dim)
  const combined = base.map((x, i) => x + GOLDEN_TILT * (tilt[i] ?? 0))
  const norm = Math.sqrt(combined.reduce((sum, x) => sum + x * x, 0))
  return combined.map(x => x / norm)
}

/**
 * A case's QUERY vector: its cluster, or an explicit `mix` (used by the
 * near-threshold positive to land just above VECTOR_MIN_SIMILARITY against a
 * single-record cluster while keeping every cross-cluster cosine well below).
 * `undefined` when the case has neither → the vector path is skipped and only
 * the lexical path executes (mode `lexical`).
 */
export function queryVector(caseLike: GoldenCaseLike, dim: number): number[] | undefined {
  if (!caseLike.cluster && !caseLike.mix) return undefined
  const base = caseLike.mix ? weightedSum(caseLike.mix, dim) : clusterVector(caseLike.cluster!, dim)
  const tilt = seededUnitVector(`query:${caseLike.name}`, dim)
  const combined = base.map((x, i) => x + GOLDEN_TILT * (tilt[i] ?? 0))
  const norm = Math.sqrt(combined.reduce((sum, x) => sum + x * x, 0))
  return combined.map(x => x / norm)
}

/** Cosine similarity (mirrors src/memory-core.ts; kept here for the fixture probe). */
export function cosine(left: readonly number[] | undefined, right: readonly number[] | undefined): number {
  if (!left || !right || left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i++) {
    const a = left[i] ?? 0
    const b = right[i] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  return leftNorm === 0 || rightNorm === 0 ? 0 : dot / Math.sqrt(leftNorm * rightNorm)
}