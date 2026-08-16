// LiveEngine — the conductor that listens to your body instead of a clock.
//
// Feed it the watch's live stream (time + accumulated distance); it tracks
// where you are in the plan (distance steps measured by real meters, not pace
// guesses), keeps a rolling pace, predicts the ETA to the next hard-step
// start, and makes DJ decisions the way the design doc always wanted:
// hold the groove loop, watch the ETA firm up, exit into the buildup at the
// last loop boundary where it still fits, land the drop when you ARRIVE.
//
// Pure logic, no I/O: advance(sample) returns playback commands. The replay
// simulator and the app both drive it the same way.
import type { SongTags, WorkoutPlan, WorkoutStep } from '../conductor/types'
import { DEFAULT_PACE_SEC_PER_KM } from '../conductor/conductor'
import { mixScore, snapToBeat } from '../conductor/beat'
import { GradeTracker, HrTracker } from './rules'

export interface LiveSample {
  /** Session clock, ms (watch timer). */
  tMs: number
  /** Accumulated activity distance, meters (absent for time-only plans). */
  distanceM?: number
  /** Live heart rate, bpm. */
  hr?: number
  /** GPS/barometric altitude, meters. */
  altitudeM?: number
  /** Watch workout-step sequence counter (CIQ field v2, Runna workouts) —
   *  increments exactly when the watch advances to the next plan step. When
   *  the stream carries this, step boundaries come from HERE: the watch KNOWS
   *  where you are in the workout; estimating it from our own odometer is a
   *  guess that drifts (backtest 2026-08-16: compounding overshoot reached
   *  34.8s late by rep 4). Internal time/distance tracking then powers
   *  anticipation only — the trigger doctrine's deterministic skeleton. */
  wkStepSeq?: number
}

export interface PlayCommand {
  tMs: number
  trackId: string
  uri: string
  positionMs: number
  fadeSec: number
  reason: string
}

export interface LandingReport {
  targetTMs: number
  actualTMs: number
  errorMs: number
}

interface DropChoice {
  song: SongTags
  dropMs: number
  entryMs: number
}

interface LoopChoice {
  song: SongTags
  startMs: number
  endMs: number
}

type Mode = 'fill' | 'build' | 'ride'

const DEFAULT_LEAD_MS = 30_000
/** EMA smoothing for pace (per sample at ~1Hz). */
const PACE_ALPHA = 0.15
/** Crest rewards stay clear of an imminent hard step — its drop owns the moment. */
const CREST_MIN_ETA_MS = 45_000
/** How long a crest-reward drop rides before returning to the groove. */
const CREST_RIDE_MS = 25_000
/** Corpus-learned freshness: across 653 measured rides in 65 real DJ sets
 *  (Fred again.., Virji, Summit…) the median time-on-one-track is ~190s
 *  (Fred: 140s). Past this, a fill trades its loop for a fresh groove. */
const MAX_FILL_RIDE_MS = 180_000

export class LiveEngine {
  private steps: WorkoutStep[]
  private droppable: DropChoice[] = []
  private loopable: LoopChoice[] = []
  private dropIdx = 0
  private loopIdx = 0

  private stepIdx = 0
  private stepStartT = 0
  private stepStartDist = 0
  private lastT: number | null = null
  private lastDist: number | null = null
  private paceSecPerKm: number
  /** Last watch step-sequence value; once seen, the watch owns boundaries. */
  private wkSeq: number | null = null

  private mode: Mode | null = null
  private playing: { song: SongTags; positionAtMs: number; atTMs: number } | null = null
  private fillStartedT: number | null = null
  private loopBounds: { startMs: number; endMs: number } | null = null
  private buildTargetT: number | null = null
  private buildDropMs: number | null = null
  private lastReaimT = -Infinity
  private crestRideUntil: number | null = null

  private readonly gradeTracker = new GradeTracker()
  private readonly hrTracker: HrTracker
  private gradeState = { grade: 0, climbing: false, crest: false }
  private hrState: { hr: number | null; zone: number } = { hr: null, zone: 0 }

  readonly commands: PlayCommand[] = []
  readonly landings: LandingReport[] = []
  readonly warnings: string[] = []

  constructor(plan: WorkoutPlan, songs: SongTags[], opts: { paceSecPerKm?: number; hrMax?: number } = {}) {
    this.steps = plan.steps
    this.paceSecPerKm = opts.paceSecPerKm ?? DEFAULT_PACE_SEC_PER_KM
    this.hrTracker = new HrTracker(opts.hrMax)
    for (const song of songs) {
      for (const d of song.markers.filter((m) => m.type === 'drop')) {
        const buildups = song.markers
          .filter((m) => m.type === 'buildup' && m.ms < d.ms)
          .sort((a, b) => b.ms - a.ms)
        const entryMs = buildups[0]?.ms ?? Math.max(0, d.ms - DEFAULT_LEAD_MS)
        if (entryMs < d.ms) this.droppable.push({ song, dropMs: d.ms, entryMs })
      }
      const starts = song.markers.filter((m) => m.type === 'loop_start').sort((a, b) => a.ms - b.ms)
      for (const s of starts) {
        const end = song.markers.find((m) => m.type === 'loop_end' && m.ms > s.ms)
        if (end) {
          this.loopable.push({ song, startMs: s.ms, endMs: end.ms })
          break
        }
      }
    }
    if (this.droppable.length === 0) this.warnings.push('no drop-tagged songs')
    if (this.loopable.length === 0) this.warnings.push('no loop-tagged songs')
  }

  /** Read-only snapshot of the engine's mind — for UIs and the replay simulator. */
  get state(): {
    stepIdx: number
    mode: Mode | null
    paceSecPerKm: number
    playingTrackId: string | null
    etaToHardMs: number | null
    gradePct: number
    climbing: boolean
    hrZone: number
  } {
    return {
      stepIdx: this.stepIdx,
      mode: this.mode,
      paceSecPerKm: this.paceSecPerKm,
      playingTrackId: this.playing?.song.trackId ?? null,
      etaToHardMs: this.lastT != null ? this.etaToNextHardMs(this.lastT, this.lastDist) : null,
      gradePct: this.gradeState.grade * 100,
      climbing: this.gradeState.climbing,
      hrZone: this.hrState.zone,
    }
  }

  /** Current playhead position in the active track at time t. */
  private playheadMs(t: number): number {
    if (!this.playing) return 0
    return this.playing.positionAtMs + (t - this.playing.atTMs)
  }

  private emit(t: number, song: SongTags, positionMs: number, fadeSec: number, reason: string) {
    this.commands.push({ tMs: t, trackId: song.trackId, uri: song.uri, positionMs, fadeSec, reason })
    this.playing = { song, positionAtMs: positionMs, atTMs: t }
  }

  private currentStep(): WorkoutStep | null {
    return this.steps[this.stepIdx] ?? null
  }

  /** Progress current step; advance through completed steps. Returns kinds entered.
   *  Two regimes:
   *  - Watch-driven (wkStepSeq in the stream): a seq increment IS the boundary
   *    — exact, drift-free. Our own estimate never advances steps.
   *  - Estimated (no watch step stream — old logs, synthetic sims): advance on
   *    our own time/distance. Distance steps advance stepStartDist by the
   *    step's PRESCRIBED meters, not the sample's current distance — sampling
   *    overshoot must not compound into the next rep (the time path always
   *    did this correctly; the distance path drifted 34.8s over 4 reps). */
  /** Where inside the last sample window did the current step's boundary
   *  actually fall? Samples quantize (1Hz live, 4–7s on smart-recording
   *  logs); the model can do better: time steps end at exact prescriptive
   *  arithmetic, distance steps at the interpolated crossing of the
   *  prescribed meters. Falls back to the sample itself when the model's
   *  estimate lies outside the window. */
  private boundaryEstimate(
    step: WorkoutStep,
    prevT: number | null,
    prevDist: number | null,
    t: number,
    dist: number | null,
  ): { bT: number; bD: number | null } {
    if (step.seconds != null) {
      const est = this.stepStartT + step.seconds * 1000
      if (prevT != null && est > prevT && est <= t) {
        const bD =
          prevDist != null && dist != null && t > prevT
            ? prevDist + ((dist - prevDist) * (est - prevT)) / (t - prevT)
            : dist
        return { bT: est, bD }
      }
    } else if (step.meters != null && dist != null) {
      const cross = this.stepStartDist + step.meters
      if (prevT != null && prevDist != null && dist > prevDist && cross > prevDist && cross <= dist) {
        return { bT: prevT + ((t - prevT) * (cross - prevDist)) / (dist - prevDist), bD: cross }
      }
      if (cross <= dist) return { bT: t, bD: cross }
    }
    return { bT: t, bD: dist }
  }

  private trackSteps(t: number, dist: number | null, wkSeq?: number): WorkoutStep[] {
    const entered: WorkoutStep[] = []
    const prevT = this.lastT
    const prevDist = this.lastDist
    if (wkSeq != null && this.wkSeq == null) this.wkSeq = wkSeq // align: current seq ↔ current step
    if (this.wkSeq != null) {
      // Watch-driven: the seq increment IS the boundary (which step —
      // drift-free truth); the model refines WHEN within the sample window.
      if (wkSeq != null && wkSeq > this.wkSeq) {
        let advanceBy = wkSeq - this.wkSeq
        this.wkSeq = wkSeq
        while (advanceBy-- > 0) {
          const step = this.currentStep()
          if (!step) break
          const { bT, bD } = this.boundaryEstimate(step, prevT, prevDist, t, dist)
          this.stepIdx++
          this.stepStartT = bT
          this.stepStartDist = bD ?? this.stepStartDist
          const next = this.currentStep()
          if (next) entered.push(next)
        }
      }
      // Belt and braces: the watch's step-change detection is signature-based
      // and PERMANENTLY misses a boundary between identical adjacent steps
      // (seen in the wild: Rolling 800s = 8 back-to-back same-shape actives).
      // If our own tracking says the step is far past done — 25% / ≥12s
      // beyond the prescription, far beyond the watch's real 1–3s seq lag —
      // advance by odometer. A later seq bump is always a NEW boundary
      // (sig misses never re-detect), so no double-advance bookkeeping.
      const cur = this.currentStep()
      if (cur) {
        const overdue =
          cur.seconds != null
            ? t - this.stepStartT - cur.seconds * 1000 > Math.max(12_000, cur.seconds * 250)
            : dist != null && cur.meters != null
              ? dist - this.stepStartDist - cur.meters > Math.max(50, cur.meters * 0.25)
              : false
        if (overdue) {
          // The real boundary was ~the prescription ago, not now — backdate
          // so the steps after it don't inherit the detection delay.
          let bT: number
          let bD: number | null
          if (cur.seconds != null) {
            bT = this.stepStartT + cur.seconds * 1000
            bD = dist != null ? dist - ((t - bT) / 1000) * (1000 / this.paceSecPerKm) : null
          } else {
            bD = this.stepStartDist + (cur.meters ?? 0)
            bT = dist != null ? t - ((dist - bD) / 1000) * this.paceSecPerKm * 1000 : t
          }
          this.stepIdx++
          this.stepStartT = bT
          this.stepStartDist = bD ?? this.stepStartDist
          this.warnings.push(`watch step stream stalled — advanced step ${this.stepIdx} by odometer`)
          const next = this.currentStep()
          if (next) entered.push(next)
        }
      }
      return entered
    }
    // Estimated (no watch step stream): advance on our own time/distance,
    // boundary times refined the same way so overshoot never compounds.
    for (;;) {
      const step = this.currentStep()
      if (!step) break
      const done =
        step.seconds != null
          ? t - this.stepStartT >= step.seconds * 1000
          : dist != null && step.meters != null
            ? dist - this.stepStartDist >= step.meters
            : false
      if (!done) break
      const { bT, bD } = this.boundaryEstimate(step, prevT, prevDist, t, dist)
      this.stepIdx++
      this.stepStartT = step.seconds != null ? this.stepStartT + step.seconds * 1000 : bT
      this.stepStartDist = step.meters != null ? this.stepStartDist + step.meters : (bD ?? this.stepStartDist)
      const next = this.currentStep()
      if (next) entered.push(next)
    }
    return entered
  }

  /** ms until the next hard step STARTS — including the next rep while
   *  already in a hard step (interval blocks: every rep start is a drop
   *  moment, not just the first). Null when no hard step lies ahead. */
  private etaToNextHardMs(t: number, dist: number | null): number | null {
    const cur = this.currentStep()
    if (!cur) return null
    let eta = this.remainingMs(cur, t, dist)
    for (let i = this.stepIdx + 1; i < this.steps.length; i++) {
      const s = this.steps[i]
      if (s.kind === 'hard') return eta
      eta += s.seconds != null ? s.seconds * 1000 : ((s.meters ?? 0) / 1000) * this.paceSecPerKm * 1000
    }
    return null
  }

  private remainingMs(step: WorkoutStep, t: number, dist: number | null): number {
    if (step.seconds != null) return Math.max(0, this.stepStartT + step.seconds * 1000 - t)
    if (step.meters != null && dist != null) {
      const remainingM = Math.max(0, step.meters - (dist - this.stepStartDist))
      return (remainingM / 1000) * this.paceSecPerKm * 1000
    }
    return 0
  }

  /** DJ-crate selection: prefer the candidate that mixes best out of what's
   *  playing (tempo within tolerance, harmonic key), rotation breaks ties so
   *  the set stays varied. Same-track repeats remain the last resort. */
  private pickBest<T extends { song: SongTags }>(
    choices: T[],
    startIdx: number,
  ): { choice: T; advance: number } | null {
    if (choices.length === 0) return null
    const from = this.playing?.song
    // Variety pressure: without it, two perfectly-compatible songs ping-pong
    // forever (the critic caught a 32-minute two-song set). Recently-played
    // candidates lose a point, so equally-good fresh songs win.
    const recent = new Set(
      this.commands
        .slice(-6)
        .map((c) => c.trackId)
        .filter((id) => id !== this.playing?.song.trackId),
    )
    let best: { choice: T; advance: number; score: number } | null = null
    for (let i = 0; i < choices.length; i++) {
      const c = choices[(startIdx + i) % choices.length]
      if (c.song.trackId === this.playing?.song.trackId) continue
      const score = (from ? mixScore(from, c.song) : 0) - (recent.has(c.song.trackId) ? 1 : 0)
      if (!best || score > best.score) best = { choice: c, advance: i + 1, score }
    }
    if (best) return best
    return { choice: choices[startIdx % choices.length], advance: 1 }
  }

  private pickDrop(): DropChoice | null {
    const r = this.pickBest(this.droppable, this.dropIdx)
    if (!r) return null
    this.dropIdx += r.advance
    return r.choice
  }

  private pickLoop(): LoopChoice | null {
    const r = this.pickBest(this.loopable, this.loopIdx)
    if (!r) return null
    this.loopIdx += r.advance
    return r.choice
  }

  private startFill(t: number) {
    const fill = this.pickLoop()
    if (!fill) return
    this.mode = 'fill'
    this.fillStartedT = t
    this.loopBounds = { startMs: fill.startMs, endMs: fill.endMs }
    this.emit(t, fill.song, fill.startMs, 1.2, `groove fill (${fill.song.name})`)
  }

  /** Advance the engine with a fresh sample; returns commands issued this tick. */
  advance(sample: LiveSample): PlayCommand[] {
    const before = this.commands.length
    const t = sample.tMs
    const dist = sample.distanceM ?? null

    // Rolling pace from real movement.
    if (this.lastT != null && this.lastDist != null && dist != null && t > this.lastT) {
      const dD = dist - this.lastDist
      const dT = (t - this.lastT) / 1000
      if (dD > 0.5) {
        const instPace = (dT / dD) * 1000 // sec per km
        this.paceSecPerKm = this.paceSecPerKm * (1 - PACE_ALPHA) + instPace * PACE_ALPHA
      }
    }
    // Body-signal trackers: grade/climb/crest from altitude, zones from HR.
    this.gradeState = this.gradeTracker.update(dist, sample.altitudeM)
    this.hrState = this.hrTracker.update(sample.hr)

    // trackSteps reads lastT/lastDist as the PREVIOUS sample (boundary
    // interpolation window) — update them only after.
    const entered = this.trackSteps(t, dist, sample.wkStepSeq)
    this.lastT = t
    this.lastDist = dist

    // Actual hard-step arrival: score the landing, ensure we're riding a drop.
    for (const step of entered) {
      if (step.kind === 'hard') {
        if (this.mode === 'build' && this.buildTargetT != null) {
          this.landings.push({ targetTMs: this.buildTargetT, actualTMs: t, errorMs: t - this.buildTargetT })
        } else {
          // ETA collapsed before any commit — cut straight to a drop, truncated.
          const pick = this.pickDrop()
          if (pick) {
            this.emit(t, pick.song, pick.dropMs, 0.3, `drop lands (truncated) (${pick.song.name})`)
            this.landings.push({ targetTMs: t, actualTMs: t, errorMs: 0 })
          }
        }
        this.mode = 'ride'
        this.buildTargetT = null
        this.buildDropMs = null
        this.crestRideUntil = null
      } else if (this.mode === 'ride') {
        // Hard step over — back to groove.
        this.startFill(t)
        this.crestRideUntil = null
      }
    }

    // First sample of the session: a plan that OPENS on a hard step opens on
    // a drop (backtest 2026-08-16: every progressive long run's first effort
    // was missed — step 0 is never "entered", so nothing choreographed it).
    if (this.mode === null) {
      if (this.currentStep()?.kind === 'hard') {
        const pick = this.pickDrop()
        if (pick) {
          this.emit(t, pick.song, pick.dropMs, 0.3, `drop lands (opening) (${pick.song.name})`)
          this.landings.push({ targetTMs: t, actualTMs: t, errorMs: 0 })
          this.mode = 'ride'
        } else {
          this.startFill(t)
        }
      } else {
        this.startFill(t)
      }
    }

    // Crest reward: you ground up a real hill and just topped out — the drop
    // hits NOW. Only from the groove (planned drops own their moments), only
    // when no hard step is imminent, and only if the body actually worked
    // for it (zone ≥ 3 when HR data exists).
    if (this.gradeState.crest && this.mode === 'fill') {
      const eta = this.etaToNextHardMs(t, dist)
      const earned = this.hrState.hr == null || this.hrState.zone >= 3
      if ((eta == null || eta > CREST_MIN_ETA_MS) && earned) {
        const pick = this.pickDrop()
        if (pick) {
          this.emit(t, pick.song, pick.dropMs, 0.45, `drop lands (crest reward) (${pick.song.name})`)
          this.mode = 'ride'
          this.crestRideUntil = t + CREST_RIDE_MS
        }
      }
    }

    // Crest rides are time-boxed — drift back into the groove afterwards.
    if (this.mode === 'ride' && this.crestRideUntil != null && t >= this.crestRideUntil) {
      this.crestRideUntil = null
      this.startFill(t)
    }

    // Next-rep anticipation: in an interval block the engine used to be blind
    // mid-ride — every rep after the first got a jarring truncated cut
    // (backtest 2026-08-16: 8/8 truncated on Rolling 800s). Riding a drop and
    // the NEXT hard start's ETA now fits the best candidate's buildup → cut
    // into that buildup so the next drop lands as the next rep begins.
    if (this.mode === 'ride' && this.crestRideUntil == null) {
      const eta = this.etaToNextHardMs(t, dist)
      if (eta != null) {
        const r = this.pickBest(this.droppable, this.dropIdx)
        if (r) {
          const buildLen = r.choice.dropMs - r.choice.entryMs
          if (eta <= buildLen) {
            this.dropIdx += r.advance
            const positionMs = snapToBeat(Math.max(0, r.choice.dropMs - eta), r.choice.dropMs, r.choice.song.bpm)
            this.emit(t, r.choice.song, positionMs, 0.45, `buildup toward next rep (${r.choice.song.name})`)
            this.mode = 'build'
            this.buildTargetT = t + (r.choice.dropMs - positionMs)
            this.buildDropMs = r.choice.dropMs
          }
        }
      }
    }

    // Mid-build re-aim: the commit predicted the arrival 20–30s out; real legs
    // fade or surge over a rep's last 150m (backtest 2026-08-16: ±3–6s tail).
    // If the live ETA has drifted more than half a beat off the committed
    // landing, re-cut within the buildup on the beat — inaudible in a rising
    // build — so the drop still lands on ARRIVAL, not on the stale forecast.
    // Never inside the last 3s (let it land), at most once per 4s.
    if (this.mode === 'build' && this.buildTargetT != null && this.buildDropMs != null && this.playing) {
      const eta = this.etaToNextHardMs(t, dist)
      if (eta != null && eta > 3000) {
        const beatMs = 60_000 / (this.playing.song.bpm || 125)
        const driftMs = t + eta - this.buildTargetT
        // Funnel threshold: only the LAST correction sets the landing, so
        // tolerate drift proportional to time-out (12%) far from the drop and
        // tighten to half a beat close in — one or two cuts per build, not six.
        const threshold = Math.max(beatMs / 2, eta * 0.12)
        if (Math.abs(driftMs) > threshold && t - this.lastReaimT >= 4000) {
          const positionMs = snapToBeat(Math.max(0, this.buildDropMs - eta), this.buildDropMs, this.playing.song.bpm)
          this.emit(t, this.playing.song, positionMs, 0.2, `build re-aim (${this.playing.song.name})`)
          this.buildTargetT = t + (this.buildDropMs - positionMs)
          this.lastReaimT = t
        }
      }
    }

    // Fill-mode loop management + commit decision at loop boundaries.
    if (this.mode === 'fill' && this.playing && this.loopBounds) {
      const pos = this.playheadMs(t)
      if (pos >= this.loopBounds.endMs) {
        const eta = this.etaToNextHardMs(t, dist)
        const loopLen = this.loopBounds.endMs - this.loopBounds.startMs
        const pick = eta != null ? this.pickDrop() : null
        if (eta != null && pick) {
          const buildLen = pick.dropMs - pick.entryMs
          if (eta <= buildLen + loopLen) {
            // Last viable boundary: enter so the drop lands at ETA — snapped
            // to the incoming song's beat grid (anchored at its downbeat-
            // aligned drop), so the cut enters on the beat. Costs ≤ half a
            // beat of landing precision; buys musical phrasing.
            const positionMs = snapToBeat(Math.max(0, pick.dropMs - eta), pick.dropMs, pick.song.bpm)
            this.emit(t, pick.song, positionMs, 0.45, `buildup toward the effort (${pick.song.name})`)
            this.mode = 'build'
            this.buildTargetT = t + (pick.dropMs - positionMs)
            this.buildDropMs = pick.dropMs
            return this.commands.slice(before)
          }
        }
        // Freshness (corpus-learned): real DJs move on after ~3 minutes.
        // At a loop boundary with no commit pending, a stale fill trades
        // its loop for a fresh groove instead of looping back again.
        if (this.fillStartedT != null && t - this.fillStartedT >= MAX_FILL_RIDE_MS && this.loopable.length > 1) {
          this.startFill(t)
        } else {
          this.emit(t, this.playing.song, this.loopBounds.startMs, 0.25, `loop back (${this.playing.song.name})`)
        }
      }
    }

    // Never-silence: chain a fresh groove if the current track would end.
    if (this.playing && this.mode !== 'build') {
      const pos = this.playheadMs(t)
      if (pos >= this.playing.song.durationMs - 1500 && this.mode !== 'ride') {
        this.startFill(t)
      } else if (pos >= this.playing.song.durationMs - 1500 && this.mode === 'ride') {
        this.startFill(t)
        this.mode = 'ride'
      }
    }

    return this.commands.slice(before)
  }
}
