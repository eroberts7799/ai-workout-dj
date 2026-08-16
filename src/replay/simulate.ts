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
  cadence?: number
  /** Watch step-sequence counter (recorded in LIVE logs from 2026-08-16 on). */
  wkStepSeq?: number
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
  /** Two 4%-grade hills along the route (tests the crest-reward rule). */
  hilly?: boolean
  /** Synthesize a lagging heart rate that chases each step's effort. */
  withHr?: boolean
  hrMax?: number
}

export interface TracePoint {
  tMs: number
  distanceM?: number
  hr?: number
  altitude?: number
  stepIdx: number
  mode: string | null
  paceSecPerKm: number
  etaToHardMs: number | null
  gradePct: number
  climbing: boolean
  hrZone: number
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
/** Estimated total route distance for laying out synthetic hills. */
function nominalDistanceM(plan: WorkoutPlan, o: ScenarioOpts): number {
  return plan.steps.reduce((m, s) => {
    if (s.meters != null) return m + s.meters
    if (s.seconds != null) return m + (s.seconds / (s.kind === 'hard' ? o.hardPaceSecPerKm : o.easyPaceSecPerKm)) * 1000
    return m
  }, 0)
}

export function syntheticSamples(plan: WorkoutPlan, o: ScenarioOpts): SimSample[] {
  const out: SimSample[] = []
  const nominal = Math.max(1, nominalDurationMs(plan, o))
  const totalM = Math.max(1, nominalDistanceM(plan, o))
  const hrMax = o.hrMax ?? 190
  const maxMs = 3 * 3_600_000 // runaway backstop
  let t = 0
  let d = 0
  let alt = 40
  let hr = 90
  let stepIdx = 0
  let stepStartT = 0
  let stepStartD = 0

  // Two 5% climbs (~33m gain each — clears the data-tuned 30m earned-crest
  // bar) with matching descents. Crest fractions (0.32, 0.56) top out early
  // in the EASY stretches of a classic interval plan — inside a hard step
  // the engine (correctly) lets the planned drop own the moment.
  const gradeAt = (dist: number): number => {
    const f = dist / totalM
    if ((f >= 0.2 && f < 0.32) || (f >= 0.44 && f < 0.56)) return 0.05
    if ((f >= 0.32 && f < 0.44) || (f >= 0.56 && f < 0.68)) return -0.05
    return 0
  }

  const push = (kind: WorkoutStep['kind'], dM: number) => {
    if (o.hilly) alt += gradeAt(d) * dM
    if (o.withHr) {
      // HR chases the step's effort with a lag; climbing costs extra.
      const target = (kind === 'hard' ? 0.88 : kind === 'cooldown' ? 0.62 : 0.72) * hrMax + (o.hilly && gradeAt(d) > 0 ? 8 : 0)
      hr += (target - hr) * 0.04
    }
    out.push({
      tMs: t,
      distanceM: round1(d),
      ...(o.hilly ? { altitude: round1(alt) } : {}),
      ...(o.withHr ? { hr: Math.round(hr) } : {}),
    })
  }

  while (stepIdx < plan.steps.length && t < maxMs) {
    const step = plan.steps[stepIdx]
    const basePace = step.kind === 'hard' ? o.hardPaceSecPerKm : o.easyPaceSecPerKm
    const fatigue = 1 + ((o.fatiguePct ?? 0) / 100) * Math.min(1.5, t / nominal)
    const ts = t / 1000
    const wobble = Math.sin((2 * Math.PI * ts) / 45) * 0.6 + Math.sin((2 * Math.PI * ts) / 13) * 0.4
    const pace = basePace * fatigue * (1 + ((o.noisePct ?? 0) / 100) * wobble)
    t += 1000
    const dM = 1000 / pace // meters covered this second
    d += dM
    push(step.kind, dM)
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
    const dM = 1000 / o.easyPaceSecPerKm
    d += dM
    push('cooldown', dM)
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
  opts: { paceSecPerKm?: number; hrMax?: number } = {},
): SimResult {
  const engine = new LiveEngine(plan, songs, opts)
  const trace: TracePoint[] = []
  for (const s of samples) {
    engine.advance({ tMs: s.tMs, distanceM: s.distanceM, hr: s.hr, altitudeM: s.altitude, wkStepSeq: s.wkStepSeq })
    const st = engine.state
    trace.push({
      tMs: s.tMs,
      distanceM: s.distanceM,
      hr: s.hr,
      altitude: s.altitude,
      stepIdx: st.stepIdx,
      mode: st.mode,
      paceSecPerKm: st.paceSecPerKm,
      etaToHardMs: st.etaToHardMs,
      gradePct: st.gradePct,
      climbing: st.climbing,
      hrZone: st.hrZone,
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
  /** Zone anchor the session actually ran with (logs from 2026-08-16 on). */
  hrMax?: number
  /** Ground-truth step boundaries (structured-run corpus) — what actually
   *  happened on the watch, for scoring the engine against reality. */
  boundaries?: { tMs: number; stepIdx: number; end?: boolean }[]
}

/**
 * Load one extracted structured run (data/garmin-history-structured/, via the
 * dev server's /api/corpus): the prescriptive plan, the 1Hz body stream, and
 * the true boundaries. Samples get the wkStepSeq the watch would have
 * streamed, so replays exercise the watch-driven engine path.
 */
export function loadStructuredRun(json: unknown): LoadedLog {
  const run = json as {
    name?: string
    wktName?: string
    planSteps?: { kind: WorkoutPlan['steps'][number]['kind']; seconds?: number; meters?: number; open?: boolean }[]
    boundaries?: { tMs: number; stepIdx: number; end?: boolean }[]
    samples?: SimSample[]
    hrMax?: number
  }
  const boundaries = run.boundaries ?? []
  const stepBounds = boundaries.filter((b) => !b.end)
  const steps = (run.planSteps ?? []).map((s, i) => {
    if (s.seconds != null || s.meters != null) return { kind: s.kind, seconds: s.seconds, meters: s.meters }
    // Open (press-lap) step: substitute the executed duration — only the
    // watch's step stream can end these live.
    const start = boundaries[i]?.tMs
    const end = boundaries[i + 1]?.tMs
    return { kind: s.kind, seconds: start != null && end != null ? (end - start) / 1000 : 60 }
  })
  const name = run.wktName ?? run.name ?? 'structured run'
  const samples = (run.samples ?? []).map((s) => ({
    ...s,
    wkStepSeq: stepBounds.filter((b) => b.tMs <= s.tMs).length,
  }))
  return { name, plan: { name, steps }, samples, boundaries, hrMax: run.hrMax }
}

/**
 * Import a Garmin Connect TCX export. The watch records every activity
 * natively (HR, distance, altitude, cadence at 1Hz), so ANY workout ever
 * synced to Garmin — tonight's or years of history — becomes flywheel data,
 * even when our own recorder never saw it.
 */
export function importTcx(xml: string): LoadedLog {
  const samples: SimSample[] = []
  let t0: number | null = null
  let lastT = -1
  for (const [, body] of xml.matchAll(/<Trackpoint>([\s\S]*?)<\/Trackpoint>/g)) {
    const time = body.match(/<Time>([^<]+)<\/Time>/)?.[1]
    if (!time) continue
    const wall = Date.parse(time)
    if (Number.isNaN(wall)) continue
    t0 ??= wall
    const tMs = wall - t0
    if (tMs <= lastT) continue // lap boundaries duplicate trackpoints
    lastT = tMs
    const num = (re: RegExp) => {
      const m = body.match(re)?.[1]
      const v = m != null ? Number(m) : NaN
      return Number.isFinite(v) ? v : undefined
    }
    samples.push({
      tMs,
      distanceM: num(/<DistanceMeters>([^<]+)<\/DistanceMeters>/),
      altitude: num(/<AltitudeMeters>([^<]+)<\/AltitudeMeters>/),
      hr: num(/<HeartRateBpm[^>]*>\s*<Value>([^<]+)<\/Value>/),
      cadence: num(/<Cadence>([^<]+)<\/Cadence>/) ?? num(/<ns\d*:RunCadence>([^<]+)<\/ns\d*:RunCadence>/),
    })
  }
  const sport = xml.match(/<Activity Sport="([^"]+)"/)?.[1] ?? 'activity'
  const id = xml.match(/<Id>([^<]+)<\/Id>/)?.[1]?.slice(0, 10) ?? ''
  return { name: `${sport.toLowerCase()} ${id}`.trim(), plan: null, samples }
}

/**
 * Read a downloaded session log. New logs carry the raw watch stream in
 * `samples`; older ones only logged HR, which still replays time-only plans.
 */
export function loadSessionLog(json: unknown): LoadedLog {
  const log = json as {
    plan?: WorkoutPlan
    samples?: { tMs: number; distanceM?: number; hr?: number; altitude?: number; cadence?: number; wkStepSeq?: number }[]
    hr?: { atMs: number; hr: number }[]
    hrMax?: number
  }
  const plan = log.plan && Array.isArray(log.plan.steps) ? log.plan : null
  let samples: SimSample[] = []
  if (Array.isArray(log.samples) && log.samples.length > 0) {
    samples = log.samples
      .filter((s) => typeof s.tMs === 'number')
      .map((s) => ({ tMs: s.tMs, distanceM: s.distanceM, hr: s.hr, altitude: s.altitude, cadence: s.cadence, wkStepSeq: s.wkStepSeq }))
  } else if (Array.isArray(log.hr)) {
    samples = log.hr.filter((s) => typeof s.atMs === 'number').map((s) => ({ tMs: s.atMs, hr: s.hr }))
  }
  samples.sort((a, b) => a.tMs - b.tMs)
  const hrMax = typeof log.hrMax === 'number' && log.hrMax >= 120 && log.hrMax <= 230 ? log.hrMax : undefined
  return { name: plan?.name ?? 'recorded session', plan, samples, hrMax }
}
