// Route-match backtest — does "your history is your route" actually work?
// Chronological leave-one-out over data/routes/history: for each GPS run,
// the library is every run BEFORE it. Stream the run's fixes through the
// matcher and score:
//   coverage   — share of live distance with a lock (a route was known)
//   wrongAhead — share of locked moments whose route was WRONG 300m later
//                (the runner was >40m from where the route said he'd be) —
//                the failure that matters: a confident, wrong future
//   crest err  — for predicted crests ≥30m gain on a correct lock, |arrival
//                prediction − truth| frozen at ETA ≤5s (the fresh-cut regime
//                the terrain lab GO'd at p90 3.1s), pace from the live EMA
// Run: bun scripts/route-backtest.ts
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { RouteMatcher, type Fix, type Route } from '../src/live/route-match'

const DIR = 'data/routes/history'
interface Run { id: string; date: string; km: number; points: number[][] }

const runs: Run[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf-8')) as Run)
  .sort((a, b) => a.date.localeCompare(b.date))

function toRoute(r: Run): Route {
  return { id: r.id, km: r.km, runs: 1, points: r.points.map((p) => ({ lat: p[0], lon: p[1], distM: p[2], altM: p[3] })) }
}

const KY = 110_540
function meters(a: number[], b: number[], kx: number): number {
  return Math.hypot((a[1] - b[1]) * kx, (a[0] - b[0]) * KY)
}

let totalM = 0
let lockedM = 0
let lockedChecks = 0
let wrongAhead = 0
let sureChecks = 0
let sureWrong = 0
let runsWithLock = 0
let headChecks300 = 0, headOk300 = 0, headChecks150 = 0, headOk150 = 0
let crestsAvailable = 0
const crestErrs: number[] = []
const lockAtM: number[] = []

for (let n = 1; n < runs.length; n++) {
  const run = runs[n]
  const lib = runs.slice(0, n).map(toRoute)
  const m = new RouteMatcher(lib)
  const pts = run.points
  const kx = 111_320 * Math.cos((pts[0][0] * Math.PI) / 180)
  // Truth lookup: live position at a given live distance.
  const posAt = (d: number): number[] | null => {
    for (let i = 1; i < pts.length; i++) if (pts[i][2] >= d) return pts[i]
    return null
  }
  let firstLock: number | null = null
  let prevD = 0
  // Pace: history tracks carry no time — assume 5:30/km flat and let the
  // GAP prior shape the ETA; the crest error then isolates ROUTE error
  // (wrong future / wrong profile), not pace error (the terrain lab owns that).
  const paceSecPerKm = 330
  const predicted = new Map<string, number>() // cue key → predicted arrival live distance
  for (const p of pts) {
    const fix: Fix = { lat: p[0], lon: p[1], distM: p[2] }
    m.update(fix)
    const dLive = p[2] - prevD
    prevD = p[2]
    totalM += dLive
    // Straight-ahead assumption (the no-history elevation look-ahead): is the
    // point `h` meters along the current heading within 40m of where he
    // actually went? Heading from the last 40m of track.
    const back = posAt(Math.max(0, p[2] - 40))
    if (back && back !== p) {
      const hx = (p[1] - back[1]) * kx
      const hy = (p[0] - back[0]) * KY
      const hl = Math.hypot(hx, hy)
      if (hl >= 20) {
        for (const [h, isFar] of [[300, true], [150, false]] as const) {
          const truthH = posAt(p[2] + h)
          if (!truthH) continue
          const ahead = [p[0] + (hy / hl) * h / KY, p[1] + (hx / hl) * h / kx]
          const ok = meters(ahead, truthH, kx) <= 40
          if (isFar) { headChecks300++; if (ok) headOk300++ } else { headChecks150++; if (ok) headOk150++ }
        }
      }
    }
    const lock = m.lock
    if (!lock) continue
    lockedM += dLive
    if (firstLock == null) { firstLock = p[2]; runsWithLock++; lockAtM.push(p[2]) }
    // Wrong-future check: where the route says he'll be 300m ahead vs truth.
    const ahead = m.aheadProfile(300)
    const truth = posAt(p[2] + 300)
    if (ahead.length > 0 && truth) {
      lockedChecks++
      // Find the locked candidate's point at progress+300 via aheadCues' host: use the
      // route library point closest to that route distance.
      const r = lib.find((x) => x.id === lock.routeId)!
      const total = r.points[r.points.length - 1].distM
      const targetRouteD = lock.reversed ? total - (lock.progressM + 300) : lock.progressM + 300
      let best: number[] | null = null
      let bestGap = Infinity
      for (const q of r.points) {
        const gap = Math.abs(q.distM - targetRouteD)
        if (gap < bestGap) { bestGap = gap; best = [q.lat, q.lon] }
      }
      const wrong = best != null && meters(best, truth, kx) > 40
      if (wrong) wrongAhead++
      if (lock.agreement >= 1) {
        sureChecks++
        if (wrong) sureWrong++
      }
    }
    // Crest predictions: freeze at ETA ≤ 5s (fresh-cut lead + slack).
    for (const cue of m.aheadCues()) {
      if (cue.type !== 'crest' || cue.gainM < 30 || predicted.has(cue.key)) continue
      // Fixes are 20m apart (~4s): freeze at the last fix before the cue.
      if (cue.confidence < 0.5) continue
      if (cue.liveDistanceM - p[2] <= 25) predicted.set(cue.key, cue.liveDistanceM)
    }
  }
  // Score crest predictions against the run's OWN crests (GradeTracker on its altitude).
  // Truth = live distance where the run actually crested nearest the prediction.
  if (predicted.size > 0) {
    const { extractTerrainCues } = await import('../src/live/terrain')
    const truthCrests = extractTerrainCues(pts.map((p) => ({ distanceM: p[2], altitudeM: p[3] })))
      .filter((c) => c.type === 'crest' && c.gainM >= 30)
      .map((c) => c.distanceM)
    crestsAvailable += truthCrests.length
    for (const [, predD] of predicted) {
      let bestErr = Infinity
      for (const td of truthCrests) bestErr = Math.min(bestErr, Math.abs(td - predD))
      if (bestErr < 400) crestErrs.push(((bestErr / 1000) * paceSecPerKm))
    }
  }
}

function pct(a: number, b: number) { return b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a' }
function stats(xs: number[]) {
  if (!xs.length) return 'n=0'
  const s = [...xs].sort((a, b) => a - b)
  return `n=${s.length} p50=${s[Math.floor(s.length * 0.5)].toFixed(1)} p90=${s[Math.floor(s.length * 0.9)].toFixed(1)} max=${s[s.length - 1].toFixed(1)}`
}
console.log(`runs scored: ${runs.length - 1} · runs that ever locked: ${runsWithLock} (${pct(runsWithLock, runs.length - 1)})`)
console.log(`coverage: ${pct(lockedM, totalM)} of live distance had a known route`)
console.log(`wrong future @300m: ${pct(wrongAhead, lockedChecks)} of locked moments (${wrongAhead}/${lockedChecks})`)
console.log(`wrong future @300m when candidates AGREE: ${pct(sureWrong, sureChecks)} (${sureWrong}/${sureChecks}) — ${pct(sureChecks, lockedChecks)} of locked moments are agreed`)
console.log(`first lock distance (m): ${stats(lockAtM)}`)
console.log(`straight-ahead holds: ${pct(headOk150, headChecks150)} @150m · ${pct(headOk300, headChecks300)} @300m (no-history look-ahead ceiling)`)
console.log(`crest arrival error vs the run's own summit (s @5:30/km, distance error really): ${stats(crestErrs)} · summits ≥30m on locked runs: ${crestsAvailable}`)
