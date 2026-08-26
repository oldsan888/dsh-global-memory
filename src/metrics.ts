/**
 * Phase 4 runtime anonymous metrics (host-agnostic, pure, tests with an
 * injectable clock).
 *
 * Contract:
 * - In-memory ONLY: nothing is persisted, no table is touched, and a fresh
 *   plugin instance starts at zero ("since plugin start" semantics).
 * - Never records query, content, scope, key, id, URL token/header or
 *   exception response bodies — only counters.
 * - recall latency keeps a FIXED 256-sample ring of the most recent COMPLETED
 *   calls (successes and failures alike); P50/P95 use the deterministic
 *   nearest-rank method over the current ring contents (0 when empty).
 * - embedding counters: every real HTTP attempt goes through the same single
 *   entry point; success/failure/timeout/cancelled are mutually exclusive and
 *   sum exactly to `attempts`. `cancelled` is an external AbortSignal abort and
 *   is NOT counted as a failure.
 */

import type { EmbeddingOutcome } from './memory-core.ts'

/** Fixed ring-window of completed recall latencies (most recent N samples). */
export const LATENCY_WINDOW_SIZE = 256
/** Fixed top-N bounds shared by the status tool (scope/model-dim/long tops). */
export const STATUS_TOP_N = 20

export interface RecallSnapshot {
  calls: number
  zeroResults: number
  returnedItems: number
  failures: number
  latencySamples: number
  p50Ms: number
  p95Ms: number
}

export interface EmbeddingSnapshot {
  attempts: number
  successes: number
  failures: number
  timeouts: number
  cancelled: number
}

export interface RuntimeMetrics {
  readonly since: number
  recall(): RecallSnapshot
  embedding(): EmbeddingSnapshot
  /**
   * Record ONE completed recall call. Latency enters the recent-256 ring
   * regardless of failure (the call did complete); a failed call increments
   * `failures` and contributes no `returnedItems`.
   */
  recordRecallCall(input: { latencyMs: number; failed: boolean; zeroResults: boolean; returnedItems: number }): void
  /** Record ONE real HTTP embedding attempt with a mutually exclusive outcome. */
  recordEmbeddingOutcome(outcome: EmbeddingOutcome): void
}

/** Deterministic nearest-rank percentile over a SORTED sample array; 0 when empty. */
export function percentileMs(sortedAsc: readonly number[], quantile: number): number {
  if (sortedAsc.length === 0) return 0
  const q = Math.max(0, Math.min(1, quantile))
  const index = Math.max(0, Math.ceil(sortedAsc.length * q) - 1)
  return Math.round(sortedAsc[index] ?? 0)
}

export function createRuntimeMetrics(clock: () => number = Date.now): RuntimeMetrics {
  const since = clock()
  let recallCalls = 0
  let recallZero = 0
  let recallReturned = 0
  let recallFailures = 0
  const latencyRing: number[] = []
  let embedAttempts = 0
  let embedSuccesses = 0
  let embedFailures = 0
  let embedTimeouts = 0
  let embedCancelled = 0

  const pushLatency = (latencyMs: number): void => {
    latencyRing.push(latencyMs)
    if (latencyRing.length > LATENCY_WINDOW_SIZE) latencyRing.splice(0, latencyRing.length - LATENCY_WINDOW_SIZE)
  }

  const recall = (): RecallSnapshot => {
    const sorted = [...latencyRing].sort((a, b) => a - b)
    return {
      calls: recallCalls,
      zeroResults: recallZero,
      returnedItems: recallReturned,
      failures: recallFailures,
      latencySamples: sorted.length,
      p50Ms: percentileMs(sorted, 0.5),
      p95Ms: percentileMs(sorted, 0.95),
    }
  }

  return {
    since,
    recall,
    embedding: () => ({
      attempts: embedAttempts,
      successes: embedSuccesses,
      failures: embedFailures,
      timeouts: embedTimeouts,
      cancelled: embedCancelled,
    }),
    recordRecallCall(input) {
      recallCalls++
      if (input.failed) recallFailures++
      else {
        if (input.zeroResults) recallZero++
        recallReturned += input.returnedItems
      }
      pushLatency(input.latencyMs)
    },
    recordEmbeddingOutcome(outcome) {
      embedAttempts++
      if (outcome === 'success') embedSuccesses++
      else if (outcome === 'failure') embedFailures++
      else if (outcome === 'timeout') embedTimeouts++
      else embedCancelled++
    },
  }
}
