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

interface Metrics {
  runsWithLock: number; totalM: number; lockedM: number
  checks: Record<number, number>; wrong: Record<number, number>
  sureChecks: Record<number, number>; sureWrong: Record<number, number>
  lockAtM: number[]; crestErrs: number[]; crestsAvailable: number
  selfLockedM: number
}

const HORIZONS = [50, 100, 200, 300]

async function backtest(opts: { selfRoute: boolean; lockMinM: number; startPrior: boolean }): Promise<Metrics> {
  const { extractTerrainCues } = await import('../src/live/terrain')
  const M: Metrics = {
    runsWithLock: 0, totalM: 0, lockedM: 0, checks: {}, wrong: {}, sureChecks: {}, sureWrong: {},
    lockAtM: [], crestErrs: [], crestsAvailable: 0, selfLockedM: 0,
  }
  for (const h of HORIZONS) { M.checks[h] = 0; M.wrong[h] = 0; M.sureChecks[h] = 0; M.sureWrong[h] = 0 }
  for (let n = 1; n < runs.length; n++) {
    const run = runs[n]
    const lib = runs.slice(0, n).map(toRoute)
    const m = new RouteMatcher(lib, opts)
    const pts = run.points
    const kx = 111_320 * Math.cos((pts[0][0] * Math.PI) / 180)
    let ptr = 0
    // Interpolated truth: the run's position at live distance d. (Snapping
    // to the next 20m point added up to 20m of along-track error to every
    // check and inflated wrong-future at short horizons.)
    const posAt = (d: number): number[] | null => {
      while (ptr < pts.length && pts[ptr][2] < d) ptr++
      if (ptr >= pts.length) return null
      if (ptr === 0) return pts[0]
      const a = pts[ptr - 1], b = pts[ptr]
      const f = (d - a[2]) / Math.max(1, b[2] - a[2])
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])]
    }
    let firstLock: number | null = null
    let prevD = 0
    const paceSecPerKm = 330
    const predicted = new Map<string, number>()
    const libById = new Map(lib.map((r) => [r.id, r]))
    for (const p of pts) {
      m.update({ lat: p[0], lon: p[1], distM: p[2], altM: p[3] })
      const dLive = p[2] - prevD
      prevD = p[2]
      M.totalM += dLive
      const lock = m.lock
      if (!lock) continue
      M.lockedM += dLive
      if (lock.routeId === 'self') M.selfLockedM += dLive
      if (firstLock == null) { firstLock = p[2]; M.runsWithLock++; M.lockAtM.push(p[2]) }
      // Where the locked route says he will be h meters ahead vs where he went.
      const r = lock.routeId === 'self' ? null : libById.get(lock.routeId)!
      if (r) {
        const total = r.points[r.points.length - 1].distM
        for (const h of HORIZONS) {
          ptr = 0
          const truth = posAt(p[2] + h)
          if (!truth) continue
          const targetRouteD = lock.reversed ? total - (lock.progressM + h) : lock.progressM + h
          // Interpolated route position at targetRouteD.
          let best: number[] | null = null
          const rp = r.points
          for (let k = 1; k < rp.length; k++) {
            if (rp[k].distM >= targetRouteD) {
              const a = rp[k - 1], b2 = rp[k]
              const f = Math.min(1, Math.max(0, (targetRouteD - a.distM) / Math.max(1, b2.distM - a.distM)))
              best = [a.lat + f * (b2.lat - a.lat), a.lon + f * (b2.lon - a.lon)]
              break
            }
          }
          if (!best) continue
          const wrong = meters(best, truth, kx) > 40
          M.checks[h]++
          if (wrong) M.wrong[h]++
          if (lock.agreement >= 1) { M.sureChecks[h]++; if (wrong) M.sureWrong[h]++ }
        }
      }
      for (const cue of m.aheadCues()) {
        if (cue.type !== 'crest' || cue.gainM < 30 || predicted.has(cue.key) || cue.confidence < 0.5) continue
        if (cue.liveDistanceM - p[2] <= 25) predicted.set(cue.key, cue.liveDistanceM)
      }
    }
    if (predicted.size > 0) {
      const truthCrests = extractTerrainCues(pts.map((p) => ({ distanceM: p[2], altitudeM: p[3] })))
        .filter((c) => c.type === 'crest' && c.gainM >= 30)
        .map((c) => c.distanceM)
      M.crestsAvailable += truthCrests.length
      for (const [, predD] of predicted) {
        let bestErr = Infinity
        for (const td of truthCrests) bestErr = Math.min(bestErr, Math.abs(td - predD))
        if (bestErr < 400) M.crestErrs.push((bestErr / 1000) * paceSecPerKm)
      }
    }
  }
  return M
}

function pct(a: number, b: number) { return b ? ((100 * a) / b).toFixed(1) + '%' : 'n/a' }
function stats(xs: number[]) {
  if (!xs.length) return 'n=0'
  const s = [...xs].sort((a, b) => a - b)
  return `n=${s.length} p50=${s[Math.floor(s.length * 0.5)].toFixed(1)} p90=${s[Math.floor(s.length * 0.9)].toFixed(1)} max=${s[s.length - 1].toFixed(1)}`
}
const configs = [
  { name: 'history only, lock 500, no prior', selfRoute: false, lockMinM: 500, startPrior: false },
  { name: 'DEFAULT: self-route + prior, lock 400', selfRoute: true, lockMinM: 400, startPrior: true },
]
for (const c of configs) {
  const M = await backtest(c)
  const n = runs.length - 1
  console.log(`\n== ${c.name} ==`)
  console.log(`locked runs ${pct(M.runsWithLock, n)} · coverage ${pct(M.lockedM, M.totalM)} (self-route ${pct(M.selfLockedM, M.totalM)}) · first lock ${stats(M.lockAtM)}`)
  console.log('wrong future by horizon (all locks | agreed locks): ' + HORIZONS.map((h) =>
    `${h}m ${pct(M.wrong[h], M.checks[h])} | ${pct(M.sureWrong[h], M.sureChecks[h])}`).join(' · '))
  console.log(`crest error vs own summit: ${stats(M.crestErrs)} (summits on locked runs ${M.crestsAvailable})`)
}
