import { describe, expect, test } from 'bun:test'
import { LOCK_MIN_TRACK_M, RouteMatcher, type Fix, type Route, type RoutePoint } from './route-match'

const LAT0 = 32.06
const LON0 = 34.77
const KY = 110_540
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180)

/** A route built from (x, y) meter offsets, 20m spacing, with an altitude fn. */
function route(id: string, legs: { dx: number; dy: number }[], alt: (d: number) => number, runs = 1): Route {
  const pts: RoutePoint[] = []
  let x = 0
  let y = 0
  let d = 0
  pts.push({ lat: LAT0, lon: LON0, distM: 0, altM: alt(0) })
  for (const leg of legs) {
    const len = Math.hypot(leg.dx, leg.dy)
    const steps = Math.floor(len / 20)
    for (let i = 1; i <= steps; i++) {
      x += leg.dx / steps
      y += leg.dy / steps
      d += len / steps
      pts.push({ lat: LAT0 + y / KY, lon: LON0 + x / KX, distM: Math.round(d * 10) / 10, altM: alt(d) })
    }
  }
  return { id, km: d / 1000, runs, points: pts }
}

/** Fixes every 5m along the same legs, with an optional lateral offset. */
function fixes(legs: { dx: number; dy: number }[], offsetM = 0, startD = 0): Fix[] {
  const out: Fix[] = []
  let x = 0
  let y = 0
  let d = startD
  for (const leg of legs) {
    const len = Math.hypot(leg.dx, leg.dy)
    const steps = Math.floor(len / 5)
    const nx = -leg.dy / len
    const ny = leg.dx / len
    for (let i = 1; i <= steps; i++) {
      x += leg.dx / steps
      y += leg.dy / steps
      d += len / steps
      out.push({ lat: LAT0 + (y + ny * offsetM) / KY, lon: LON0 + (x + nx * offsetM) / KX, distM: d })
    }
  }
  return out
}

const flat = () => 10
const north2k = [{ dx: 0, dy: 2000 }]

describe('RouteMatcher', () => {
  test('locks onto the route after the minimum on-route travel, progress tracks the odometer', () => {
    const m = new RouteMatcher([route('r', north2k, flat)])
    let lockedAt: number | null = null
    for (const f of fixes(north2k, 8)) {
      m.update(f)
      if (m.lock && lockedAt == null) lockedAt = f.distM
    }
    expect(lockedAt).not.toBeNull()
    // Same front door as the route: the start prior (1.5×) locks earlier.
    expect(lockedAt!).toBeGreaterThanOrEqual(LOCK_MIN_TRACK_M / 1.5 - 5)
    expect(lockedAt!).toBeLessThan(LOCK_MIN_TRACK_M + 40)
    expect(m.lock!.routeId).toBe('r')
    expect(m.lock!.reversed).toBe(false)
    expect(Math.abs(m.lock!.progressM - 2000)).toBeLessThan(25)
  })

  test('the same route run backwards locks reversed', () => {
    const r = route('r', north2k, flat)
    const m = new RouteMatcher([r])
    // Start at the far end, run south.
    for (const f of fixes([{ dx: 0, dy: -2000 }], 0).map((f) => ({ ...f, lat: f.lat + 2000 / KY }))) m.update(f)
    expect(m.lock).not.toBeNull()
    expect(m.lock!.reversed).toBe(true)
    expect(Math.abs(m.lock!.progressM - 2000)).toBeLessThan(25)
  })

  test('leaving the route drops the lock within ~100m', () => {
    const m = new RouteMatcher([route('r', north2k, flat)])
    for (const f of fixes([{ dx: 0, dy: 1000 }])) m.update(f)
    expect(m.lock).not.toBeNull()
    // Turn east, away from the route.
    let dropAt: number | null = null
    for (const f of fixes([{ dx: 400, dy: 0 }], 0, 1000).map((f) => ({ ...f, lat: f.lat + 1000 / KY }))) {
      m.update(f)
      if (!m.lock && dropAt == null) dropAt = f.distM
    }
    expect(dropAt).not.toBeNull()
    expect(dropAt! - 1000).toBeLessThan(200)
  })

  test('two routes sharing a prefix: the branch decides, no false future', () => {
    // A: north 1km then east 1km. B: north 1km then west 1km. B is the habit.
    const A = route('A', [{ dx: 0, dy: 1000 }, { dx: 1000, dy: 0 }], flat, 2)
    const B = route('B', [{ dx: 0, dy: 1000 }, { dx: -1000, dy: 0 }], flat, 9)
    const m = new RouteMatcher([A, B])
    for (const f of fixes([{ dx: 0, dy: 1000 }])) m.update(f)
    // On the shared prefix the habit wins the tie…
    expect(m.lock!.routeId).toBe('B')
    // …then the runner goes east: B is lost, A carries on.
    for (const f of fixes([{ dx: 600, dy: 0 }], 0, 1000).map((f) => ({ ...f, lat: f.lat + 1000 / KY }))) m.update(f)
    expect(m.lock!.routeId).toBe('A')
    expect(Math.abs(m.lock!.progressM - 1600)).toBeLessThan(30)
  })

  test('ahead cues: the crest of a hill on the locked route lands on the live odometer', () => {
    // 3km north: flat 1km, +80m over the next 1km, flat 1km.
    const alt = (d: number) => (d <= 1000 ? 10 : d <= 2000 ? 10 + (d - 1000) * 0.08 : 90)
    const m = new RouteMatcher([route('hill', [{ dx: 0, dy: 3000 }], alt)])
    // Live odometer starts at 300m already run elsewhere — the projection must respect it.
    for (const f of fixes([{ dx: 0, dy: 800 }], 0, 300)) m.update(f)
    expect(m.lock).not.toBeNull()
    const crest = m.aheadCues().find((c) => c.type === 'crest')!
    expect(crest).toBeDefined()
    // Route crest near 2000m (smoothed lag allowed) → live ≈ 300 + 2000.
    expect(crest.liveDistanceM).toBeGreaterThan(2250)
    expect(crest.liveDistanceM).toBeLessThan(2550)
    expect(crest.confidence).toBeGreaterThan(0.9)
    // Uphill flat-equivalent exceeds raw distance (GAP prior).
    expect(crest.flatEquivRemainingM).toBeGreaterThan(crest.liveDistanceM - 1100)
    const profile = m.aheadProfile(2500)
    expect(profile[0].distanceM).toBeGreaterThanOrEqual(1090)
    expect(profile[profile.length - 1].altitudeM).toBeGreaterThan(80)
  })

  test('self-route: an out-and-back with NO history locks the return leg onto the outbound track, hill included', () => {
    const m = new RouteMatcher([])
    // Out: 2km north over a hill (crest at 1km), then straight back.
    const alt = (d: number) => (d <= 1000 ? 10 + d * 0.06 : 70 - (d - 1000) * 0.06)
    const out = fixes([{ dx: 0, dy: 2000 }]).map((f) => ({ ...f, altM: alt(f.distM) }))
    for (const f of out) m.update(f)
    expect(m.lock).toBeNull() // nothing to match on the way out
    const back = fixes([{ dx: 0, dy: -2000 }], 0, 2000).map((f) => ({ ...f, lat: f.lat + 2000 / KY, altM: alt(4000 - f.distM) }))
    let lockedAt: number | null = null
    let crestSeen: number | null = null
    for (const f of back) {
      m.update(f)
      if (m.lock && lockedAt == null) lockedAt = f.distM
      if (m.lock && crestSeen == null) {
        const c = m.aheadCues().find((x) => x.type === 'crest')
        if (c) crestSeen = c.liveDistanceM
      }
    }
    expect(lockedAt).not.toBeNull()
    expect(lockedAt! - 2000).toBeLessThan(LOCK_MIN_TRACK_M + 250)
    expect(m.lock!.routeId).toBe('self')
    expect(m.lock!.reversed).toBe(true)
    // The hill crossed on the way out is predicted for the return: live ≈ 3000.
    expect(crestSeen).not.toBeNull()
    expect(Math.abs(crestSeen! - 3000)).toBeLessThan(150)
  })

  test('self-route: laps — lap two locks onto lap one', () => {
    const m = new RouteMatcher([])
    const lap = [{ dx: 0, dy: 600 }, { dx: 600, dy: 0 }, { dx: 0, dy: -600 }, { dx: -600, dy: 0 }]
    for (const f of fixes(lap)) m.update(f)
    expect(m.lock).toBeNull()
    let lockedAt: number | null = null
    for (const f of fixes(lap, 0, 2400)) {
      m.update(f)
      if (m.lock && lockedAt == null) lockedAt = f.distM
    }
    expect(lockedAt).not.toBeNull()
    expect(lockedAt! - 2400).toBeLessThan(LOCK_MIN_TRACK_M + 100)
    expect(m.lock!.routeId).toBe('self')
    expect(m.lock!.reversed).toBe(false)
  })

  test('self-route never steals a lock from a real history route', () => {
    const m = new RouteMatcher([route('r', north2k, flat, 3)])
    for (const f of fixes(north2k)) m.update(f)
    expect(m.lock!.routeId).toBe('r')
  })

  test('branch probabilities from history: pAhead and cue confidence fall across a fork', () => {
    const r = route('r', [{ dx: 0, dy: 3000 }], (d) => (d <= 1500 ? 10 : d <= 2500 ? 10 + (d - 1500) * 0.08 : 90))
    // History: everyone continues for the first km; at ~1.2km half turn off.
    r.branch = r.points.map((p) => (p.distM >= 1200 && p.distM < 1300 ? 0.5 : 1))
    const m = new RouteMatcher([r])
    for (const f of fixes([{ dx: 0, dy: 700 }])) m.update(f)
    expect(m.lock).not.toBeNull()
    expect(m.pAhead(400)).toBeCloseTo(1, 2)
    expect(m.pAhead(1000)).toBeLessThan(0.6)
    const crest = m.aheadCues().find((c) => c.type === 'crest')!
    expect(crest.pReach).toBeLessThan(0.6)
    expect(crest.confidence).toBeLessThan(0.6)
  })
})
