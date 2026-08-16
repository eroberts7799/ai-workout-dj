// Decision-engine backtest — grades the REAL LiveEngine against real bodies.
//
// Every structured run in data/garmin-history-structured/ carries the
// prescriptive plan (what Runna asked for), the executed truth (the exact
// timer-ms of every step boundary, from FIT lap messages), and the 1Hz body
// stream. We feed the engine the plan + the stream — exactly what it gets
// live — and score its decisions against what actually happened:
//
//   DROP LANDING  drop moment vs the true hard-step start. The product
//                 metric: "the drop hits as the rep begins."
//   RELEASE       first post-rep transition vs the true hard-step end.
//   MISSED        a hard start the engine never dropped for at all.
//
// Run: bun scripts/backtest.ts [--json out.json]
// (Evaluators before optimizers — this baseline exists BEFORE engine changes.)

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LiveEngine } from '../src/live/live-engine'
import type { WorkoutPlan, WorkoutStep, SongTags } from '../src/conductor/types'

const RUNS_DIR = join(import.meta.dir, '..', 'data', 'garmin-history-structured')
const CRATE = join(import.meta.dir, '..', 'ios', 'Resources', 'demo-bundle.json')

// Landing within one 4-beat bar at ~125bpm reads as "on the moment".
const ON_TIME_MS = 1_920

interface StructuredRun {
  name: string
  wktName: string | null
  activityId: string
  planSteps: (WorkoutStep & { open?: boolean; targetSpeedLow?: number; notes?: string })[]
  boundaries: { tMs: number; stepIdx: number; intensity?: string; end?: boolean }[]
  samples: { tMs: number; distanceM?: number; hr?: number; altitude?: number }[]
}

interface RunReport {
  file: string
  wktName: string | null
  hardStarts: number
  landings: { boundaryTMs: number; dropTMs: number | null; errorMs: number | null; truncated: boolean }[]
  releases: { boundaryTMs: number; releaseTMs: number | null; delayMs: number | null }[]
  missed: number
  openSteps: number
  warnings: string[]
}

const songs: SongTags[] = JSON.parse(readFileSync(CRATE, 'utf8')).tags

function backtestRun(file: string): RunReport | null {
  const run: StructuredRun = JSON.parse(readFileSync(join(RUNS_DIR, file), 'utf8'))
  if (run.samples.length === 0 || run.boundaries.length < 2) return null

  // Open (press-lap) steps have no predictable amount; substitute the actual
  // duration so the plan is runnable. Counted per run — wkStep ground truth
  // is the real fix for these.
  let openSteps = 0
  const steps: WorkoutStep[] = run.planSteps.map((s, i) => {
    if (s.seconds != null || s.meters != null) return { kind: s.kind, seconds: s.seconds, meters: s.meters }
    openSteps++
    const start = run.boundaries[i]?.tMs
    const end = run.boundaries[i + 1]?.tMs
    return { kind: s.kind, seconds: start != null && end != null ? (end - start) / 1000 : 60 }
  })
  const plan: WorkoutPlan = { name: run.wktName ?? file, steps }

  // The watch streamed a step-change event at every boundary; synthesize the
  // wkStepSeq counter it would have sent (--no-wkstep grades the estimation
  // path instead — what the engine does on old logs / missing CIQ data).
  const withWkStep = !process.argv.includes('--no-wkstep')
  const stepBoundaries = run.boundaries.filter((b) => !b.end)
  const engine = new LiveEngine(plan, songs, { hrMax: 197 }) // ethan's calibrated max
  for (const s of run.samples) {
    let wkStepSeq: number | undefined
    if (withWkStep) {
      wkStepSeq = 0
      for (const b of stepBoundaries) if (b.tMs <= s.tMs) wkStepSeq++
    }
    engine.advance({ tMs: s.tMs, distanceM: s.distanceM, hr: s.hr, altitudeM: s.altitude, wkStepSeq })
  }

  // Ground truth: hard-step starts and ends from executed boundaries.
  const hardStarts: number[] = []
  const hardEnds: number[] = []
  for (let i = 0; i < run.boundaries.length; i++) {
    const b = run.boundaries[i]
    if (b.end) continue
    if (run.planSteps[b.stepIdx]?.kind === 'hard') {
      hardStarts.push(b.tMs)
      const next = run.boundaries[i + 1]
      if (next && run.planSteps[next.stepIdx]?.kind !== 'hard') hardEnds.push(next.tMs)
    }
  }

  // Drop moments the engine produced: committed builds land at buildTarget
  // (engine.landings.targetTMs); truncated drops fire at believed arrival.
  const dropMoments = engine.landings.map((l) => ({ tMs: l.targetTMs, truncated: l.errorMs === 0 && l.targetTMs === l.actualTMs }))
  // Crest rewards also emit drops but never target a step boundary — exclude
  // them from step-landing accuracy by matching within a window instead.

  const landings: RunReport['landings'] = []
  let missed = 0
  const used = new Set<number>()
  for (const bt of hardStarts) {
    let best: { i: number; err: number } | null = null
    for (let i = 0; i < dropMoments.length; i++) {
      if (used.has(i)) continue
      const err = dropMoments[i].tMs - bt
      if (Math.abs(err) <= 60_000 && (!best || Math.abs(err) < Math.abs(best.err))) best = { i, err }
    }
    if (best) {
      used.add(best.i)
      landings.push({ boundaryTMs: bt, dropTMs: dropMoments[best.i].tMs, errorMs: best.err, truncated: dropMoments[best.i].truncated })
    } else {
      missed++
      landings.push({ boundaryTMs: bt, dropTMs: null, errorMs: null, truncated: false })
    }
  }

  // Release: first command emitted at/after the true hard end (within 30s).
  const releases: RunReport['releases'] = hardEnds.map((bt) => {
    const cmd = engine.commands.find((c) => c.tMs >= bt - 2000 && c.tMs <= bt + 30_000 && c.reason.startsWith('groove fill'))
    return { boundaryTMs: bt, releaseTMs: cmd?.tMs ?? null, delayMs: cmd ? cmd.tMs - bt : null }
  })

  return { file, wktName: run.wktName, hardStarts: hardStarts.length, landings, releases, missed, openSteps, warnings: engine.warnings }
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

const files = readdirSync(RUNS_DIR).filter((f) => f.endsWith('.json')).sort()
const reports: RunReport[] = []
for (const f of files) {
  const r = backtestRun(f)
  if (r) reports.push(r)
}

const allErrors = reports.flatMap((r) => r.landings.filter((l) => l.errorMs != null).map((l) => Math.abs(l.errorMs!)))
const signed = reports.flatMap((r) => r.landings.filter((l) => l.errorMs != null).map((l) => l.errorMs!))
const sortedAbs = [...allErrors].sort((a, b) => a - b)
const truncated = reports.flatMap((r) => r.landings).filter((l) => l.truncated).length
const missed = reports.reduce((n, r) => n + r.missed, 0)
const totalHard = reports.reduce((n, r) => n + r.hardStarts, 0)
const onTime = allErrors.filter((e) => e <= ON_TIME_MS).length
const releaseDelays = reports.flatMap((r) => r.releases.filter((x) => x.delayMs != null).map((x) => x.delayMs!))
const sortedRel = [...releaseDelays].sort((a, b) => a - b)
const missedReleases = reports.flatMap((r) => r.releases).filter((x) => x.delayMs == null).length

console.log(`\n=== DECISION-ENGINE BACKTEST — ${reports.length} real structured runs, ${totalHard} hard-step starts ===\n`)
console.log(`DROP LANDINGS (vs true boundary):`)
console.log(`  on-time (≤${ON_TIME_MS / 1000}s): ${onTime}/${allErrors.length} (${((100 * onTime) / Math.max(1, allErrors.length)).toFixed(0)}%)`)
console.log(`  |error| p50 ${pct(sortedAbs, 50)}ms · p90 ${pct(sortedAbs, 90)}ms · max ${sortedAbs.at(-1)}ms`)
console.log(`  signed mean ${(signed.reduce((a, b) => a + b, 0) / Math.max(1, signed.length)).toFixed(0)}ms (negative = drop early)`)
console.log(`  truncated (no buildup, cut at arrival): ${truncated} · MISSED entirely: ${missed}`)
console.log(`\nRELEASES (first groove transition after rep end):`)
console.log(`  delay p50 ${pct(sortedRel, 50)}ms · p90 ${pct(sortedRel, 90)}ms · none within 30s: ${missedReleases}/${releaseDelays.length + missedReleases}`)

console.log(`\nWorst runs by p90 landing error:`)
const byWorst = [...reports].sort((a, b) => {
  const w = (r: RunReport) => Math.max(0, ...r.landings.filter((l) => l.errorMs != null).map((l) => Math.abs(l.errorMs!)))
  return w(b) - w(a)
})
for (const r of byWorst.slice(0, 8)) {
  const errs = r.landings.filter((l) => l.errorMs != null).map((l) => Math.abs(l.errorMs!))
  console.log(`  ${r.file} (${r.wktName ?? '?'}): worst ${Math.max(0, ...errs)}ms, missed ${r.missed}/${r.hardStarts}, open steps ${r.openSteps}`)
}

const jsonIdx = process.argv.indexOf('--json')
if (jsonIdx > -1 && process.argv[jsonIdx + 1]) {
  writeFileSync(process.argv[jsonIdx + 1], JSON.stringify({ reports }, null, 1))
  console.log(`\nwrote ${process.argv[jsonIdx + 1]}`)
}
