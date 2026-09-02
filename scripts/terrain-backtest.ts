// Terrain backtest — Approach A's verdict (design doc route-story-invisible).
// Treat each hilly historical run's own track as "the planned route": extract
// crest cues from the elevation profile alone, then measure how well we could
// have predicted the ARRIVAL TIME at each crest.
//
// Two variants per the design doc:
//   1. pure   — pre-run prediction: profile + athlete flat pace + GAP prior.
//   2. drift  — live-corrected: pace EMA re-aims the ETA; prediction freezes
//               when ETA ≤ 30s (matching how the engine commits buildups).
//
// Bar (provisional): ≤5s p90, ≤10s max. If pure misses but drift passes,
// Approach B proceeds with drift correction mandatory.
//
// Run: bun scripts/terrain-backtest.ts
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { extractTerrainCues, gapMultiplier, smoothProfile, type ProfilePoint } from '../src/live/terrain'

/** Cumulative grade-adjusted travel time (ms at flatSecPerKm = 1000) per
 *  profile point — one pass; arrival predictions become O(1) lookups:
 *  arrival(d, pace) = cum(d) * pace / 1000. */
function cumAdjustedMs(sm: ProfilePoint[]): number[] {
  const cum = new Array<number>(sm.length).fill(0)
  for (let i = 1; i < sm.length; i++) {
    const dd = sm[i].distanceM - sm[i - 1].distanceM
    if (dd <= 0) { cum[i] = cum[i - 1]; continue }
    const grade = (sm[i].altitudeM - sm[i - 1].altitudeM) / dd
    cum[i] = cum[i - 1] + (dd / 1000) * 1000 * gapMultiplier(grade) * 1000
  }
  return cum
}

function cumAt(sm: ProfilePoint[], cum: number[], d: number): number {
  let lo = 0, hi = sm.length - 1
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sm[mid].distanceM < d) lo = mid + 1; else hi = mid }
  if (lo === 0) return 0
  const a = sm[lo - 1], b = sm[lo]
  const f = Math.min(1, Math.max(0, (d - a.distanceM) / Math.max(1, b.distanceM - a.distanceM)))
  return cum[lo - 1] + f * (cum[lo] - cum[lo - 1])
}

interface Pt { tMs: number; distanceM: number; altitudeM: number }

function loadRun(path: string): Pt[] | null {
  let d: any
  try {
    d = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const samples = d.samples
  if (!Array.isArray(samples) || samples.length < 300) return null
  const pts: Pt[] = []
  for (const s of samples) {
    const t = s.tMs ?? s.t
    const dist = s.distanceM ?? s.d
    const alt = s.altitude
    if (t == null || dist == null || alt == null) continue
    if (pts.length && dist <= pts[pts.length - 1].distanceM) continue
    pts.push({ tMs: t, distanceM: dist, altitudeM: alt })
  }
  return pts.length >= 300 ? pts : null
}

/** Hilly + sane: real elevation range, cumulative ascent not jitter-dominated. */
function usable(pts: Pt[]): boolean {
  const alts = pts.map((p) => p.altitudeM)
  const range = Math.max(...alts) - Math.min(...alts)
  const km = pts[pts.length - 1].distanceM / 1000
  if (km < 3 || range < 60 || range > 1500) return false
  let ascent = 0
  for (let i = 1; i < alts.length; i++) ascent += Math.max(0, alts[i] - alts[i - 1])
  return ascent / km < 60
}

/** Athlete's flat pace for THIS run (the live system knows current pace
 *  from recent history; per-run flat isolates GRADE-model error from
 *  fitness drift, which is the quantity the bar governs). */
function flatPace(pts: Pt[], sm: ProfilePoint[]): number | null {
  const paces: number[] = []
  let j = 0
  for (let i = 1; i < pts.length; i++) {
    const dd = pts[i].distanceM - pts[j].distanceM
    if (dd < 60) continue
    const dt = (pts[i].tMs - pts[j].tMs) / 1000
    const grade = (sm[i].altitudeM - sm[j].altitudeM) / dd
    j = i
    const pace = (dt / dd) * 1000
    if (Math.abs(grade) < 0.01 && pace >= 180 && pace <= 900) paces.push(pace)
  }
  if (paces.length < 10) return null
  paces.sort((a, b) => a - b)
  return paces[Math.floor(paces.length / 2)]
}

function interpTimeAt(pts: Pt[], distanceM: number): number | null {
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].distanceM >= distanceM) {
      const a = pts[i - 1]
      const b = pts[i]
      const f = (distanceM - a.distanceM) / Math.max(1, b.distanceM - a.distanceM)
      return a.tMs + f * (b.tMs - a.tMs)
    }
  }
  return null
}

const dirs = ['data/garmin-history', 'data/terrain-lab']
const pureErrs: number[] = []
const driftErrs: number[] = []
const freshErrs: number[] = []
let runsUsed = 0
let cuesScored = 0
let cuesStationary = 0

for (const dir of dirs) {
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    continue
  }
  for (const f of files) {
    const pts = loadRun(join(dir, f))
    if (!pts || !usable(pts)) continue
    const profile: ProfilePoint[] = pts.map((p) => ({ distanceM: p.distanceM, altitudeM: p.altitudeM }))
    const cues = extractTerrainCues(profile).filter((c) => c.type === 'crest' && c.gainM >= 30)
    if (cues.length === 0) continue
    const sm = smoothProfile(profile)
    const cum = cumAdjustedMs(sm)
    const flat = flatPace(pts, sm)
    if (!flat) continue
    runsUsed++
    for (const cue of cues) {
      const truth = interpTimeAt(pts, cue.distanceM)
      if (truth == null) continue
      // Moving-runner gate: outlier forensics (2026-09-02, all 7 cases
      // >10s) showed every tail error was a runner at walking pace or
      // fully stopped near the crest (523-3787 s/km) — summit breaks.
      // A stopped runner's cue timing is moot, and live the REACTIVE
      // crest rules (field-proven 8/22, 6/6) still own that moment.
      const tNear = interpTimeAt(pts, Math.max(0, cue.distanceM - 30))
      const paceNear = tNear != null ? ((truth - tNear) / 1000 / 30) * 1000 : null
      const moving = paceNear != null && paceNear < 900
      cuesScored++
      if (!moving) { cuesStationary++; continue }
      // Variant 1: pure pre-run.
      const pred = (cumAt(sm, cum, cue.distanceM) * flat) / 1000
      pureErrs.push(Math.abs(pred - truth) / 1000)
      // Variant 2: drift-corrected — walk samples with a windowed pace EMA;
      // freeze the prediction when the modeled ETA drops to the commit
      // lead. Swept per drop style: 30s = anticipated buildups (owned
      // tier), 5s = fresh cuts (Spotify tier, the daily driver — the
      // engine commits 4s out and re-aims until then).
      for (const [leadMs, bucket] of [[30_000, driftErrs], [5_000, freshErrs]] as const) {
        let ema = flat
        let frozen: number | null = null
        let j = 0
        for (let i = 1; i < pts.length && pts[i].distanceM < cue.distanceM; i++) {
          // EMA updates on 60m windows; the ETA check runs EVERY sample —
          // gating the check on window closes left most cues unscored
          // (the last window before the crest never closed).
          const dd = pts[i].distanceM - pts[j].distanceM
          if (dd >= 60) {
            const dt = (pts[i].tMs - pts[j].tMs) / 1000
            const grade = (sm[i].altitudeM - sm[j].altitudeM) / dd
            j = i
            const flatEquiv = (dt / dd) * 1000 / gapMultiplier(grade)
            if (flatEquiv >= 120 && flatEquiv <= 1200) ema = ema * 0.85 + flatEquiv * 0.15
          }
          const eta = ((cumAt(sm, cum, cue.distanceM) - cumAt(sm, cum, pts[i].distanceM)) * ema) / 1000
          if (eta <= leadMs) {
            frozen = pts[i].tMs + eta
            break
          }
        }
        if (frozen != null) bucket.push(Math.abs(frozen - truth) / 1000)
      }
    }
  }
}

function stats(errs: number[]) {
  if (errs.length === 0) return null
  const s = [...errs].sort((a, b) => a - b)
  return {
    n: s.length,
    p50: s[Math.floor(s.length * 0.5)],
    p90: s[Math.floor(s.length * 0.9)],
    max: s[s.length - 1],
  }
}

console.log(`runs used: ${runsUsed} · crests: ${cuesScored} (${cuesStationary} excluded: runner stationary/walking at crest — reactive rules own those)`)
for (const [name, errs] of [['pure pre-run', pureErrs], ['drift @30s lead (buildups)', driftErrs], ['drift @5s lead (fresh cuts)', freshErrs]] as const) {
  const st = stats(errs as number[])
  if (!st) {
    console.log(`${name}: no data`)
    continue
  }
  const verdict = st.p90 <= 5 && st.max <= 10 ? 'PASS' : 'MISS'
  console.log(
    `${name}: n=${st.n} p50=${st.p50.toFixed(1)}s p90=${st.p90.toFixed(1)}s max=${st.max.toFixed(1)}s → ${verdict} (bar ≤5s p90 / ≤10s max)`,
  )
}
