// Terrain intelligence for the route-aware conductor (design doc
// docs/designs/route-story-invisible.md, Approach A — the replay lab).
// Pure functions: an elevation profile in, terrain cues and arrival
// predictions out. Reuses GradeTracker so pre-run cues and the live
// reactive crest rules agree by construction.
import { GradeTracker } from './rules'

export interface ProfilePoint {
  distanceM: number
  altitudeM: number
}

export interface TerrainCue {
  type: 'climbStart' | 'crest'
  distanceM: number
  /** Total climb gain behind this cue, meters. */
  gainM: number
  /** 0..1 — v1: from climb size only (bigger hills = surer cues; a 60m+
   *  climb saturates). The design doc assigns the full three-input
   *  formula (pace residual, elevation quality, point density) to
   *  calibration by this backtest. GUESS until then. */
  confidence: number
}

/** Distance-windowed median smoothing. Per-sample altimeter jitter (±1m)
 *  summed to ~900m of fake ascent over an hour in the flat corpus — kill
 *  it before any grade math. ±50m: residual fake ascent drops to ~9% of an
 *  80m synthetic hill (30m left 38%); real 30m+ climbs (MIN_CLIMB_GAIN
 *  doctrine) survive untouched. */
export function smoothProfile(profile: ProfilePoint[], windowM = 50): ProfilePoint[] {
  const out: ProfilePoint[] = []
  let lo = 0
  let hi = 0
  for (let i = 0; i < profile.length; i++) {
    const d = profile[i].distanceM
    while (profile[lo].distanceM < d - windowM) lo++
    while (hi < profile.length - 1 && profile[hi + 1].distanceM <= d + windowM) hi++
    const win = profile.slice(lo, hi + 1).map((p) => p.altitudeM).sort((a, b) => a - b)
    out.push({ distanceM: d, altitudeM: win[Math.floor(win.length / 2)] })
  }
  return out
}

/** Walk the (smoothed) profile through the SAME GradeTracker the live
 *  rules use; emit cues at climb starts and crests. */
export function extractTerrainCues(profile: ProfilePoint[]): TerrainCue[] {
  const sm = smoothProfile(profile)
  const tracker = new GradeTracker()
  const cues: TerrainCue[] = []
  let wasClimbing = false
  let climbStartAlt = 0
  let maxAlt = -Infinity
  for (const p of sm) {
    const st = tracker.update(p.distanceM, p.altitudeM)
    if (st.climbing && !wasClimbing) {
      climbStartAlt = p.altitudeM
      maxAlt = p.altitudeM
      cues.push({ type: 'climbStart', distanceM: p.distanceM, gainM: 0, confidence: 0.5 })
    }
    if (st.climbing) maxAlt = Math.max(maxAlt, p.altitudeM)
    if (st.crest) {
      const gain = maxAlt - climbStartAlt
      cues.push({
        type: 'crest',
        distanceM: p.distanceM,
        gainM: gain,
        confidence: Math.min(1, gain / 60),
      })
    }
    wasClimbing = st.climbing
  }
  return cues
}

/** Grade-adjusted pace multiplier. Literature-informed prior (Minetti
 *  energy cost shaped to practical running GAP: uphill costs ~6% pace per
 *  1% grade; downhill returns little and floors at 0.9 — descent skill,
 *  not physics, limits it). PERSONAL calibration was attempted from the
 *  structured corpus 2026-09-02 and honestly failed: Tel Aviv flatness +
 *  altimeter jitter + hill-repeat effort confound. Refine from trail runs
 *  as they accumulate. GUESS per rule 8. */
export function gapMultiplier(grade: number): number {
  if (grade > 0) return 1 + 6.0 * grade
  return Math.max(0.9, 1 + 1.5 * grade)
}

/** Pre-run arrival prediction: time to reach targetDistanceM over the
 *  profile at the athlete's flat pace, grade-adjusted per segment. */
export function predictArrivalMs(
  profile: ProfilePoint[],
  targetDistanceM: number,
  flatSecPerKm: number,
): number {
  const sm = smoothProfile(profile)
  let t = 0
  for (let i = 1; i < sm.length; i++) {
    const dd = sm[i].distanceM - sm[i - 1].distanceM
    if (dd <= 0) continue
    const end = Math.min(sm[i].distanceM, targetDistanceM)
    const seg = end - sm[i - 1].distanceM
    if (seg <= 0) break
    const grade = (sm[i].altitudeM - sm[i - 1].altitudeM) / dd
    t += (seg / 1000) * flatSecPerKm * gapMultiplier(grade) * 1000
    if (sm[i].distanceM >= targetDistanceM) break
  }
  return t
}
