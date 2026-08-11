// Replay simulator — run the LiveEngine against a synthetic runner or a
// recorded session log, without a watch, a run, or real time. This is the
// test bench for LIVE mode: try a plan + pace scenario at your desk, watch
// where the drops would land, then go run it for real.
import { LiveEngine, type LandingReport, type PlayCommand } from '../live/live-engine'
import type { WorkoutPlan, WorkoutStep, SongTags } from '../conductor/types'

/** A watch sample as fed to the engine, plus telemetry we carry for display. */
export interface SimSample {
  tMs: number
  distanceM?: number
  hr?: number
  altitude?: number
}

export interface ScenarioOpts {
  /** Pace during warmup/easy/rest/cooldown steps, sec per km. */
  easyPaceSecPerKm: number
  /** Pace during hard steps, sec per km. */
  hardPaceSecPerKm: number
  /** Linear slowdown across the run: pace is this % slower by the planned end. */
  fatiguePct?: number
  /** Deterministic pace wobble amplitude, % (two overlaid sine waves). */
  noisePct?: number
}

export interface TracePoint {
  tMs: number
  distanceM?: number
  hr?: number
  stepIdx: number
  mode: string | null
  paceSecPerKm: number
  etaToHardMs: number | null
}

export interface StepSpan {
  step: WorkoutStep
  stepIdx: number
  startMs: number
  endMs: number
}

export interface SimResult {
  trace: TracePoint[]
  commands: PlayCommand[]
  landings: LandingReport[]
  warnings: string[]
  stepSpans: StepSpan[]
  durationMs: number
}

/** Planned duration if the runner holds the scenario paces exactly. */
export function nominalDurationMs(plan: WorkoutPlan, o: ScenarioOpts): number {
  let ms = 0
  for (const s of plan.steps) {
    if (s.seconds != null) ms += s.seconds * 1000
    else if (s.meters != null)
      ms += (s.meters / 1000) * (s.kind === 'hard' ? o.hardPaceSecPerKm : o.easyPaceSecPerKm) * 1000
  }
  return ms
}

/**
 * Generate a 1Hz sample stream for a runner executing the plan: easy pace on
 * easy-family steps, hard pace on hard steps, optional fatigue drift and a
 * deterministic wobble. Steps complete exactly like the engine measures them —
 * time steps by elapsed time, distance steps by real meters covered.
 */
export function syntheticSamples(plan: WorkoutPlan, o: ScenarioOpts): SimSample[] {
  const out: SimSample[] = []
  const nominal = Math.max(1, nominalDurationMs(plan, o))
  const maxMs = 3 * 3_600_000 // runaway backstop
  let t = 0
  let d = 0
  let stepIdx = 0
  let stepStartT = 0
  let stepStartD = 0

  while (stepIdx < plan.steps.length && t < maxMs) {
    const step = plan.steps[stepIdx]
    const basePace = step.kind === 'hard' ? o.hardPaceSecPerKm : o.easyPaceSecPerKm
    const fatigue = 1 + ((o.fatiguePct ?? 0) / 100) * Math.min(1.5, t / nominal)
    const ts = t / 1000
    const wobble = Math.sin((2 * Math.PI * ts) / 45) * 0.6 + Math.sin((2 * Math.PI * ts) / 13) * 0.4
    const pace = basePace * fatigue * (1 + ((o.noisePct ?? 0) / 100) * wobble)
    t += 1000
    d += 1000 / pace // meters covered this second
    out.push({ tMs: t, distanceM: round1(d) })
    const done =
      step.seconds != null ? t - stepStartT >= step.seconds * 1000 : step.meters != null && d - stepStartD >= step.meters
    if (done) {
      stepIdx++
      stepStartT = t
      stepStartD = d
    }
  }

  // Short easy-pace tail past the plan end so the final transition is visible.
  for (let i = 0; i < 20; i++) {
    t += 1000
    d += 1000 / o.easyPaceSecPerKm
    out.push({ tMs: t, distanceM: round1(d) })
  }
  return out
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

/** Feed samples through a fresh LiveEngine, tracing its mind at every tick. */
export function simulate(
  plan: WorkoutPlan,
  songs: SongTags[],
  samples: SimSample[],
  opts: { paceSecPerKm?: number } = {},
): SimResult {
  const engine = new LiveEngine(plan, songs, opts)
  const trace: TracePoint[] = []
  for (const s of samples) {
    engine.advance({ tMs: s.tMs, distanceM: s.distanceM })
    const st = engine.state
    trace.push({
      tMs: s.tMs,
      distanceM: s.distanceM,
      hr: s.hr,
      stepIdx: st.stepIdx,
      mode: st.mode,
      paceSecPerKm: st.paceSecPerKm,
      etaToHardMs: st.etaToHardMs,
    })
  }
  return {
    trace,
    commands: [...engine.commands],
    landings: [...engine.landings],
    warnings: [...engine.warnings],
    stepSpans: stepSpansFromTrace(plan, trace),
    durationMs: trace.length > 0 ? trace[trace.length - 1].tMs : 0,
  }
}

/** Actual step boundaries as the engine crossed them (not the planned guesses). */
function stepSpansFromTrace(plan: WorkoutPlan, trace: TracePoint[]): StepSpan[] {
  const spans: StepSpan[] = []
  let start = 0
  let idx = 0
  for (const p of trace) {
    while (idx < p.stepIdx) {
      const step = plan.steps[idx]
      if (step) spans.push({ step, stepIdx: idx, startMs: start, endMs: p.tMs })
      start = p.tMs
      idx++
    }
  }
  const last = plan.steps[idx]
  if (last && trace.length > 0) spans.push({ step: last, stepIdx: idx, startMs: start, endMs: trace[trace.length - 1].tMs })
  return spans
}

/** Parsed contents of an uploaded session log. */
export interface LoadedLog {
  name: string
  plan: WorkoutPlan | null
  samples: SimSample[]
}

/**
 * Read a downloaded session log. New logs carry the raw watch stream in
 * `samples`; older ones only logged HR, which still replays time-only plans.
 */
export function loadSessionLog(json: unknown): LoadedLog {
  const log = json as {
    plan?: WorkoutPlan
    samples?: { tMs: number; distanceM?: number; hr?: number; altitude?: number }[]
    hr?: { atMs: number; hr: number }[]
  }
  const plan = log.plan && Array.isArray(log.plan.steps) ? log.plan : null
  let samples: SimSample[] = []
  if (Array.isArray(log.samples) && log.samples.length > 0) {
    samples = log.samples
      .filter((s) => typeof s.tMs === 'number')
      .map((s) => ({ tMs: s.tMs, distanceM: s.distanceM, hr: s.hr, altitude: s.altitude }))
  } else if (Array.isArray(log.hr)) {
    samples = log.hr.filter((s) => typeof s.atMs === 'number').map((s) => ({ tMs: s.atMs, hr: s.hr }))
  }
  samples.sort((a, b) => a.tMs - b.tMs)
  return { name: plan?.name ?? 'recorded session', plan, samples }
}
