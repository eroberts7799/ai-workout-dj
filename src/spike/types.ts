export type SpikePath = 'sdk' | 'webapi'

export interface Trial {
  path: SpikePath
  index: number
  /** Seek destination requested, ms into the track. */
  targetMs: number
  /** performance.now() when the seek command was issued. */
  issuedAt: number
  /** Wall-clock ms from issue until the position jump was observed (null = timeout/error). */
  latencyMs: number | null
  /**
   * Landed-position error: (observed position − elapsed since issue) − target.
   * Approximates where the playhead actually landed relative to the request.
   */
  landedErrorMs: number | null
  rateLimited: boolean
  error?: string
}

export interface StalenessSample {
  path: SpikePath
  /** Position delta reported by the player between two reads. */
  reportedDeltaMs: number
  /** Wall-clock delta between the two reads. */
  wallDeltaMs: number
  /** reportedDelta − wallDelta; large |drift| = stale position reads. */
  driftMs: number
}

export interface SpikeSummary {
  path: SpikePath
  trials: number
  failures: number
  rateLimited429s: number
  latency: Quantiles | null
  landedErrorAbs: Quantiles | null
  stalenessDriftAbs: Quantiles | null
}

export interface Quantiles {
  median: number
  p95: number
  min: number
  max: number
}
