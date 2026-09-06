// Route matching — "your history is your route" (design doc
// route-story-invisible, Approach B, live wiring 2026-09-06).
//
// The runner never downloads a route. The phone carries every past GPS
// track; the live run's first few hundred meters identify which one he is
// on (in either direction), and from then on the route AHEAD is known:
// its elevation profile feeds the terrain cues the replay lab proved
// (crest arrival p90 3.1s, drift-corrected). Diverge from the route and
// the lock drops within ~100m; another candidate may take over seamlessly.
//
// Pure module, ported to Swift same-session (parity law). No network.
import { extractTerrainCues, gapMultiplier, smoothProfile, type ProfilePoint, type TerrainCue } from './terrain'

export interface RoutePoint {
  lat: number
  lon: number
  /** Distance along the route, meters. */
  distM: number
  altM: number
}

export interface Route {
  id: string
  km: number
  /** How many times this route was run — the habit prior for ties. */
  runs: number
  points: RoutePoint[]
  /** Per point: share of all runs through here that were still on this
   *  route 100m later (history as a Markov chain, precomputed by the
   *  library builder). Absent = unknown = 1. */
  branch?: number[]
}

export interface Fix {
  lat: number
  lon: number
  /** Live odometer, meters (watch distance — authoritative). */
  distM: number
  /** Live altitude (barometric preferred) — lets the live track itself
   *  become a route with a profile (self-route). */
  altM?: number
}

/** A terrain cue projected onto the LIVE run. */
export interface AheadCue extends TerrainCue {
  /** Where the cue falls on the live odometer, meters. */
  liveDistanceM: number
  /** Flat-equivalent meters from the runner to the cue (GAP-weighted) —
   *  multiply by flat pace for the ETA. */
  flatEquivRemainingM: number
  /** Stable identity: route + direction + route distance. */
  key: string
  /** Probability (from history) the runner follows the route to this cue. */
  pReach: number
}

/** Live meters on-route before a candidate may be declared locked. Route
 *  backtest 2026-09-06 (300 runs, chronological leave-one-out): 500m →
 *  coverage 68.9% / wrong-future@50m 18.2%; 300m → 73.9% / 19.1%. 400m
 *  splits the difference; the same-front-door prior (1.5×) locks a
 *  familiar start in ~270m. */
export const LOCK_MIN_TRACK_M = 400
/** Residual (meters to the nearest route point) that counts as on-route.
 *  Phone GPS in a pocket is ~10m; opposite sidewalks are ~15-25m. */
export const NEAR_M = 30
/** Residual beyond which the candidate is being left... */
const LOST_M = 60
/** ...if it persists for this much live travel. */
const LOST_TRAVEL_M = 100
/** Forward search window for the progress pointer, meters. */
const FORWARD_WINDOW_M = 150
const BACK_WINDOW_M = 40

interface Candidate {
  route: Route
  reversed: boolean
  key: string
  /** Precomputed per route×direction. */
  sm: ProfilePoint[]
  cumFlatEquivM: number[]
  cues: TerrainCue[]
  grid: Map<string, number[]>
  /** Meters per degree of longitude at THIS route's latitude (the library
   *  spans Nantucket, New York and Tel Aviv — one global scale is 12% off). */
  kx: number
  // live state
  started: boolean
  idx: number
  progressM: number
  onRouteM: number
  offRouteM: number
  lastLiveDistM: number | null
  /** Started at the route's start while the run was starting — the "same
   *  front door" prior: such a candidate needs less track to lock. */
  startAligned: boolean
}

const GRID_CELL_M = 60
/** SELF-ROUTE: the live track becomes a candidate of its own once this
 *  long — on an out-and-back the outbound leg IS the route for the return
 *  (every trip hill gets crossed twice), on laps lap one is the route for
 *  lap two. No history needed. GUESS — the backtest calibrates. */
export const SELF_ROUTE_MIN_M = 800
/** The newest stretch of the live track is never part of the forward self
 *  candidate — the runner is always "on" his own last meters. */
const SELF_ROUTE_TAIL_M = 200
const SELF_ROUTE_STEP_M = 20
const SELF_ROUTE_REBUILD_M = 100

export class RouteMatcher {
  private readonly cands: Candidate[] = []
  private readonly ky = 110_540
  private current: Candidate | null = null
  private lastFix: Fix | null = null
  private readonly selfRoute: boolean
  private readonly lockMinM: number
  private readonly startPrior: boolean
  /** Downsampled live track (every ~20m) with altitude. */
  private readonly liveTrack: RoutePoint[] = []
  private selfForward: Candidate | null = null
  private selfReversed: Candidate | null = null
  private selfBuiltAtM = 0

  constructor(routes: Route[], opts: { selfRoute?: boolean; lockMinM?: number; startPrior?: boolean } = {}) {
    this.selfRoute = opts.selfRoute ?? true
    this.lockMinM = opts.lockMinM ?? LOCK_MIN_TRACK_M
    this.startPrior = opts.startPrior ?? true
    for (const r of routes) {
      if (r.points.length < 10) continue
      this.cands.push(this.candidate(r, false))
      this.cands.push(this.candidate(r, true))
    }
  }

  /** Grow the live track and (re)build the self candidates. The FORWARD
   *  candidate (laps) keeps its state — its points only ever append. The
   *  REVERSED candidate (out-and-back) is rebuilt only while not started:
   *  once the runner is retracing it, its distances must stay put. */
  private growSelf(fix: Fix): void {
    if (!this.selfRoute) return
    const last = this.liveTrack[this.liveTrack.length - 1]
    if (last && fix.distM - last.distM < SELF_ROUTE_STEP_M) return
    this.liveTrack.push({ lat: fix.lat, lon: fix.lon, distM: fix.distM, altM: fix.altM ?? last?.altM ?? 0 })
    const total = fix.distM
    if (total < SELF_ROUTE_MIN_M + SELF_ROUTE_TAIL_M || total - this.selfBuiltAtM < SELF_ROUTE_REBUILD_M) return
    this.selfBuiltAtM = total
    const body = this.liveTrack.filter((p) => p.distM <= total - SELF_ROUTE_TAIL_M)
    if (body.length < 10) return
    const route: Route = { id: 'self', km: body[body.length - 1].distM / 1000, runs: 0, points: body }
    // Forward: rebuild but carry the live state across (points only grew).
    const fwd = this.candidate(route, false)
    if (this.selfForward) {
      fwd.started = this.selfForward.started
      fwd.idx = this.selfForward.idx
      fwd.progressM = this.selfForward.progressM
      fwd.onRouteM = this.selfForward.onRouteM
      fwd.offRouteM = this.selfForward.offRouteM
      const i = this.cands.indexOf(this.selfForward)
      if (i >= 0) this.cands[i] = fwd
      if (this.current === this.selfForward) this.current = fwd
    } else {
      this.cands.push(fwd)
    }
    this.selfForward = fwd
    // Reversed: frozen once the runner is on it.
    if (!this.selfReversed || !this.selfReversed.started) {
      const rev = this.candidate(route, true)
      if (this.selfReversed) {
        const i = this.cands.indexOf(this.selfReversed)
        if (i >= 0) this.cands[i] = rev
      } else {
        this.cands.push(rev)
      }
      this.selfReversed = rev
    }
  }

  private candidate(route: Route, reversed: boolean): Candidate {
    const total = route.points[route.points.length - 1].distM
    const pts = reversed
      ? [...route.points].reverse().map((p) => ({ ...p, distM: total - p.distM }))
      : route.points
    // Branch probabilities are direction-blind; reversing the points
    // reverses the array. p[i] covers the 100m from point i onward.
    const branch = route.branch && route.branch.length === route.points.length
      ? (reversed ? [...route.branch].reverse() : route.branch)
      : undefined
    const r: Route = { ...route, points: pts, branch }
    const profile: ProfilePoint[] = pts.map((p) => ({ distanceM: p.distM, altitudeM: p.altM }))
    const sm = smoothProfile(profile)
    const cum = new Array<number>(sm.length).fill(0)
    for (let i = 1; i < sm.length; i++) {
      const dd = sm[i].distanceM - sm[i - 1].distanceM
      if (dd <= 0) { cum[i] = cum[i - 1]; continue }
      cum[i] = cum[i - 1] + dd * gapMultiplier((sm[i].altitudeM - sm[i - 1].altitudeM) / dd)
    }
    const kx = 111_320 * Math.cos((pts[0].lat * Math.PI) / 180)
    const grid = new Map<string, number[]>()
    pts.forEach((p, i) => {
      const k = this.cell(kx, p.lat, p.lon)
      const arr = grid.get(k)
      if (arr) arr.push(i)
      else grid.set(k, [i])
    })
    return {
      route: r, reversed, key: `${route.id}${reversed ? ':rev' : ''}`,
      sm, cumFlatEquivM: cum, cues: extractTerrainCues(profile), grid, kx,
      started: false, idx: 0, progressM: 0, onRouteM: 0, offRouteM: 0, lastLiveDistM: null, startAligned: false,
    }
  }

  private cell(kx: number, lat: number, lon: number): string {
    return `${Math.floor((lon * kx) / GRID_CELL_M)},${Math.floor((lat * this.ky) / GRID_CELL_M)}`
  }

  private metersBetween(kx: number, aLat: number, aLon: number, bLat: number, bLon: number): number {
    const dx = (aLon - bLon) * kx
    const dy = (aLat - bLat) * this.ky
    return Math.sqrt(dx * dx + dy * dy)
  }

  /** Nearest route point within the candidate's forward window (or the
   *  whole route via the grid when not started) and the runner's CONTINUOUS
   *  progress: the fix projected onto the segment through that point. Route
   *  points are 20m apart — a point-snapped progress moved in 20m jumps, and
   *  the fresh-cut window (4s ≈ 12m) fell between two jumps every time.
   *  Global search is DIRECTION-AWARE: on an out-and-back the outbound and
   *  return legs overlap within meters — the runner's own heading picks the
   *  leg (a leg-blind start put the pointer on the wrong leg, stalled it,
   *  and churned the lock at every turnaround).
   *  Returns [index, residualM, progressM]. */
  private nearest(c: Candidate, fix: Fix, heading: [number, number] | null): [number, number, number] {
    const pts = c.route.points
    let best = -1
    let bestD = Infinity
    if (c.started) {
      const from = c.progressM - BACK_WINDOW_M
      const to = c.progressM + FORWARD_WINDOW_M
      for (let i = Math.max(0, c.idx - 3); i < pts.length && pts[i].distM <= to; i++) {
        if (pts[i].distM < from) continue
        const d = this.metersBetween(c.kx, fix.lat, fix.lon, pts[i].lat, pts[i].lon)
        if (d < bestD) { bestD = d; best = i }
      }
    } else {
      const cx = Math.floor((fix.lon * c.kx) / GRID_CELL_M)
      const cy = Math.floor((fix.lat * this.ky) / GRID_CELL_M)
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = c.grid.get(`${cx + dx},${cy + dy}`)
          if (!arr) continue
          for (const i of arr) {
            const d = this.metersBetween(c.kx, fix.lat, fix.lon, pts[i].lat, pts[i].lon)
            if (d > NEAR_M || d >= bestD) continue
            if (heading && i + 1 < pts.length) {
              const rx = (pts[i + 1].lon - pts[i].lon) * c.kx
              const ry = (pts[i + 1].lat - pts[i].lat) * this.ky
              if (rx * heading[0] + ry * heading[1] <= 0) continue // wrong way along this leg
            }
            bestD = d
            best = i
          }
        }
      }
    }
    if (best < 0) return [-1, Infinity, c.progressM]
    // Project onto the better of the two segments touching the nearest point.
    let progress = pts[best].distM
    let residual = bestD
    for (const [a, b] of [[best - 1, best], [best, best + 1]] as const) {
      if (a < 0 || b >= pts.length) continue
      const ax = pts[a].lon * c.kx, ay = pts[a].lat * this.ky
      const bx = pts[b].lon * c.kx, by = pts[b].lat * this.ky
      const px = fix.lon * c.kx, py = fix.lat * this.ky
      const vx = bx - ax, vy = by - ay
      const len2 = vx * vx + vy * vy
      if (len2 <= 0) continue
      const tt = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
      const qx = ax + tt * vx, qy = ay + tt * vy
      const d = Math.hypot(px - qx, py - qy)
      if (d < residual) {
        residual = d
        progress = pts[a].distM + tt * (pts[b].distM - pts[a].distM)
      }
    }
    return [best, residual, progress]
  }

  /** Feed one GPS fix. Call at whatever rate fixes arrive (≈1Hz). */
  update(fix: Fix): void {
    const dLive = this.lastFix ? Math.max(0, fix.distM - this.lastFix.distM) : 0
    // Runner's heading from the last two fixes (meters), only once he has moved.
    let heading: [number, number] | null = null
    if (this.lastFix) {
      const kx = 111_320 * Math.cos((fix.lat * Math.PI) / 180)
      const hx = (fix.lon - this.lastFix.lon) * kx
      const hy = (fix.lat - this.lastFix.lat) * this.ky
      if (Math.hypot(hx, hy) >= 3) heading = [hx, hy]
    }
    this.lastFix = fix
    this.growSelf(fix)
    for (const c of this.cands) {
      const [i, res, prog] = this.nearest(c, fix, heading)
      if (!c.started) {
        if (i >= 0 && res <= NEAR_M) {
          c.started = true
          c.idx = i
          c.progressM = prog
          c.onRouteM = 0
          c.offRouteM = 0
          c.startAligned = this.startPrior && prog < 100 && fix.distM < 100 && c.route.id !== 'self'
        }
        continue
      }
      if (i >= 0 && res <= NEAR_M) {
        // Progress must move forward: a runner standing still or looping
        // back doesn't advance the pointer past where he is.
        if (prog >= c.progressM - BACK_WINDOW_M) {
          c.idx = i
          c.progressM = Math.max(c.progressM, prog)
        }
        c.onRouteM += dLive
        c.offRouteM = 0
      } else if (i < 0 || res > LOST_M) {
        c.offRouteM += dLive
        if (c.offRouteM >= LOST_TRAVEL_M) {
          c.started = false
          c.onRouteM = 0
          c.offRouteM = 0
          if (this.current === c) this.current = null
        }
      }
      // NEAR_M < res ≤ LOST_M: ambiguous (wide road, GPS wobble) — hold.
    }
    // Lock policy: the candidate with the most on-route travel past the
    // threshold wins; habit (runs) then length break ties. The current lock
    // is sticky — a rival must beat it clearly, not merely tie it.
    let best: Candidate | null = null
    for (const c of this.cands) {
      if (!this.lockEligible(c)) continue
      if (!best || this.better(c, best)) best = c
    }
    if (this.current && this.lockEligible(this.current)) {
      if (best && best !== this.current && best.onRouteM > this.current.onRouteM + this.lockMinM) this.current = best
    } else {
      this.current = best
    }
  }

  private lockEligible(c: Candidate): boolean {
    if (!c.started) return false
    return c.onRouteM * (c.startAligned ? 1.5 : 1) >= this.lockMinM
  }

  private better(a: Candidate, b: Candidate): boolean {
    if (a.onRouteM !== b.onRouteM) return a.onRouteM > b.onRouteM
    if (a.route.runs !== b.route.runs) return a.route.runs > b.route.runs
    return a.route.km > b.route.km
  }

  /** The locked route (id, direction, progress), or null. `agreement` is
   *  the share of lock-eligible candidates that put the runner at the same
   *  place 300m ahead — 1.0 means every plausible route agrees on the
   *  future; less means a fork is coming that history has taken both ways. */
  get lock(): { routeId: string; reversed: boolean; progressM: number; remainingM: number; agreement: number } | null {
    const c = this.current
    if (!c) return null
    const total = c.route.points[c.route.points.length - 1].distM
    return { routeId: c.route.id, reversed: c.reversed, progressM: c.progressM, remainingM: total - c.progressM, agreement: this.agreement() }
  }

  /** Probability (from history) that the runner is still on the locked
   *  route `aheadM` from here — the product of the per-100m continuation
   *  shares along the way. What a "final kilometer" claim should check. */
  pAhead(aheadM: number): number {
    const c = this.current
    if (!c) return 0
    return this.pReach(c, c.progressM + aheadM)
  }

  private pReach(c: Candidate, toRouteDistM: number): number {
    const b = c.route.branch
    if (!b) return 1
    const pts = c.route.points
    let p = 1
    for (let i = c.idx; i < pts.length && pts[i].distM < toRouteDistM; i += 5) p *= b[i] ?? 1
    return p
  }

  /** Where candidate c says the runner will be `aheadM` past its progress. */
  private pointAhead(c: Candidate, aheadM: number): RoutePoint | null {
    const target = c.progressM + aheadM
    const pts = c.route.points
    for (let i = c.idx; i < pts.length; i++) if (pts[i].distM >= target) return pts[i]
    return null
  }

  private agreement(aheadM = 300): number {
    const cur = this.current
    if (!cur) return 0
    const mine = this.pointAhead(cur, aheadM)
    if (!mine) return 1
    let eligible = 0
    let agree = 0
    for (const c of this.cands) {
      if (!this.lockEligible(c)) continue
      eligible++
      const p = this.pointAhead(c, aheadM)
      if (p && this.metersBetween(cur.kx, mine.lat, mine.lon, p.lat, p.lon) <= 40) agree++
    }
    return eligible ? agree / eligible : 1
  }

  /** Terrain cues AHEAD on the locked route, projected onto the live odometer. */
  aheadCues(): AheadCue[] {
    const c = this.current
    const fix = this.lastFix
    if (!c || !fix) return []
    const here = this.flatEquivAt(c, c.progressM)
    // A contested future halves the cue's confidence: below the 0.5 gate it
    // stays reactive-only (design doc's TerrainCue contract).
    const agreement = this.agreement()
    const out: AheadCue[] = []
    for (const cue of c.cues) {
      if (cue.distanceM <= c.progressM) continue
      const pReach = this.pReach(c, cue.distanceM)
      out.push({
        ...cue,
        pReach,
        confidence: cue.confidence * (agreement >= 1 ? 1 : 0.5) * pReach,
        liveDistanceM: fix.distM + (cue.distanceM - c.progressM),
        flatEquivRemainingM: this.flatEquivAt(c, cue.distanceM) - here,
        key: `${c.key}@${Math.round(cue.distanceM)}`,
      })
    }
    return out
  }

  /** The route's elevation ahead of the runner in LIVE-odometer space —
   *  what a "route ahead" panel or the coaching layer reads. */
  aheadProfile(maxM = 2000): ProfilePoint[] {
    const c = this.current
    const fix = this.lastFix
    if (!c || !fix) return []
    const out: ProfilePoint[] = []
    for (const p of c.sm) {
      if (p.distanceM < c.progressM) continue
      if (p.distanceM > c.progressM + maxM) break
      out.push({ distanceM: fix.distM + (p.distanceM - c.progressM), altitudeM: p.altitudeM })
    }
    return out
  }

  private flatEquivAt(c: Candidate, d: number): number {
    const sm = c.sm
    const cum = c.cumFlatEquivM
    let lo = 0
    let hi = sm.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (sm[mid].distanceM < d) lo = mid + 1
      else hi = mid
    }
    if (lo === 0) return 0
    const a = sm[lo - 1]
    const b = sm[lo]
    const f = Math.min(1, Math.max(0, (d - a.distanceM) / Math.max(1, b.distanceM - a.distanceM)))
    return cum[lo - 1] + f * (cum[lo] - cum[lo - 1])
  }
}
