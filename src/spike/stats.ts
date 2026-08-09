import type { Quantiles, SpikeSummary, StalenessSample, Trial, SpikePath } from './types'

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function quantiles(values: number[]): Quantiles | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return {
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  }
}

export function summarize(path: SpikePath, trials: Trial[], staleness: StalenessSample[]): SpikeSummary {
  const mine = trials.filter((t) => t.path === path)
  const ok = mine.filter((t) => t.latencyMs !== null)
  return {
    path,
    trials: mine.length,
    failures: mine.length - ok.length,
    rateLimited429s: mine.filter((t) => t.rateLimited).length,
    latency: quantiles(ok.map((t) => t.latencyMs as number)),
    landedErrorAbs: quantiles(ok.map((t) => Math.abs(t.landedErrorMs as number))),
    stalenessDriftAbs: quantiles(
      staleness.filter((s) => s.path === path).map((s) => Math.abs(s.driftMs)),
    ),
  }
}

/** Design-doc decision gate: <300ms feels intentional, >2000ms needs buffer strategies first. */
export function verdict(s: SpikeSummary): 'green' | 'yellow' | 'red' | 'unknown' {
  if (!s.latency || !s.landedErrorAbs) return 'unknown'
  const worst = Math.max(s.latency.p95, s.landedErrorAbs.p95)
  if (worst < 300) return 'green'
  if (worst > 2000) return 'red'
  return 'yellow'
}
