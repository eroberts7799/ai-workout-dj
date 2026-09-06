// Does averaging recordings fix the summit? For every route cluster with
// ≥3 runs: the consensus profile's crests (≥30m gain) vs each member run's
// own crests, in route-distance space (member map-matched onto the
// representative). The spread is the per-recording noise the live
// predictor inherits — and what the consensus profile is meant to remove.
// Run: bun scripts/summit-spread.ts
import { readFileSync } from 'fs'
import { extractTerrainCues } from '../src/live/terrain'

const lib = JSON.parse(readFileSync('data/routes/library.json', 'utf-8'))
const KY = 110_540
const single: number[] = [] // member-vs-member (one recording as truth)
const cons: number[] = []   // member-vs-consensus
let clusters = 0
for (const r of lib.routes) {
  if (r.runs < 3) continue
  const kx = 111_320 * Math.cos((r.points[0][0] * Math.PI) / 180)
  const consCrests = extractTerrainCues(r.points.map((p: number[]) => ({ distanceM: p[2], altitudeM: p[3] })))
    .filter((c) => c.type === 'crest' && c.gainM >= 30).map((c) => c.distanceM)
  if (consCrests.length === 0) continue
  clusters++
  const memberCrests: number[][] = []
  for (const id of r.members) {
    let m: any
    try { m = JSON.parse(readFileSync(`data/routes/history/${id}.json`, 'utf-8')) } catch { continue }
    // Map each member point to the rep's distance: nearest rep point within 30m.
    const own = extractTerrainCues(m.points.map((p: number[]) => ({ distanceM: p[2], altitudeM: p[3] })))
      .filter((c) => c.type === 'crest' && c.gainM >= 30)
    const mapped: number[] = []
    for (const c of own) {
      const mp = m.points.find((p: number[]) => p[2] >= c.distanceM) ?? m.points[m.points.length - 1]
      let best = -1, bestD = 30
      for (const q of r.points) {
        const d = Math.hypot((q[1] - mp[1]) * kx, (q[0] - mp[0]) * KY)
        if (d < bestD) { bestD = d; best = q[2] }
      }
      if (best >= 0) mapped.push(best)
    }
    memberCrests.push(mapped)
  }
  for (const mc of memberCrests) {
    for (const d of mc) {
      const e = Math.min(...consCrests.map((c) => Math.abs(c - d)))
      if (e < 400) cons.push(e)
    }
  }
  for (let a = 0; a < memberCrests.length; a++) {
    for (let b = a + 1; b < memberCrests.length; b++) {
      for (const d of memberCrests[a]) {
        if (memberCrests[b].length === 0) continue
        const e = Math.min(...memberCrests[b].map((c) => Math.abs(c - d)))
        if (e < 400) single.push(e)
      }
    }
  }
}
const st = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? `n=${s.length} p50=${s[Math.floor(s.length / 2)].toFixed(0)}m p90=${s[Math.floor(s.length * 0.9)].toFixed(0)}m` : 'n=0' }
console.log(`clusters with ≥3 runs and a ≥30m crest: ${clusters}`)
console.log(`summit disagreement, one recording vs another: ${st(single)}`)
console.log(`summit disagreement, recording vs CONSENSUS profile: ${st(cons)}`)
