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
 *  (Fred: 140s). Past this, a cruise chains to a fresh groove. */
const MAX_FILL_RIDE_MS = 180_000
/** Energy-aware chain window brackets that median: never change before MIN,
 *  force a change by CAP; between them, leave at a segment boundary where a
 *  strong section (chorus/inst/solo) just ended — on top, not mid-breakdown. */
const MIN_FILL_RIDE_MS = 120_000
const FILL_RIDE_CAP_MS = 240_000
const HIGH_ENERGY_LABELS = new Set(['chorus', 'inst', 'solo'])
/** Skip the rep-end release when the NEXT buildup would cut in before this
 *  much listening — ride the current song through the rest instead. One song
 *  change per rep, not two. (Chosen, not measured: pending listen feedback.) */
const RELEASE_MIN_LISTEN_MS = 60_000
/** Fresh-mode rep changes: start the Spotify-style crossfade this far before
 *  the boundary so the incoming song peaks right as the effort begins. */
const FRESH_CHANGE_LEAD_MS = 4_000

/** How a rep start is marked musically:
 *  - 'fresh': a NEW song from 0:00, crossfaded to land on the boundary —
 *    "songs start from the beginning until we can create sick drops" (Ethan,
 *    2026-08-17). The DEFAULT.
 *  - 'anticipated': the original moat mechanics — cut into the incoming
 *    song's buildup exactly buildup-length out so its drop detonates on
 *    arrival. Parked (like the blends) until the mixing earns it back. */
export type DropStyle = 'fresh' | 'anticipated'

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
  /** Track position (ms) where this cruise should chain to the next song. */
  private fillExitPosMs: number | null = null
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

  /** Learned pairing weights ("<norm from>><norm to>" → observed count) —
   *  mined from real DJ sets by analysis/selection_weights.py. */
  private readonly pairBonus: Record<string, number>
  /** trackId → normalized "artist title" key (mirrors the miner's norm()). */
  private readonly normKey = new Map<string, string>()

  private readonly dropStyle: DropStyle

  constructor(
    plan: WorkoutPlan,
    songs: SongTags[],
    opts: { paceSecPerKm?: number; hrMax?: number; pairBonus?: Record<string, number>; dropStyle?: DropStyle } = {},
  ) {
    this.steps = plan.steps
    this.paceSecPerKm = opts.paceSecPerKm ?? DEFAULT_PACE_SEC_PER_KM
    this.hrTracker = new HrTracker(opts.hrMax)
    this.pairBonus = opts.pairBonus ?? {}
    this.dropStyle = opts.dropStyle ?? 'fresh'
    for (const song of songs) {
      const words = `${song.artists} ${song.name}`.toLowerCase().match(/[a-z0-9]+/g) ?? []
      this.normKey.set(song.trackId, words.join(' '))
    }
    for (const song of songs) {
      for (const d of song.markers.filter((m) => m.type === 'drop')) {
        const buildups = song.markers
          .filter((m) => m.type === 'buildup' && m.ms < d.ms)
          .sort((a, b) => b.ms - a.ms)
        const entryMs = buildups[0]?.ms ?? Math.max(0, d.ms - DEFAULT_LEAD_MS)
        if (entryMs < d.ms) this.droppable.push({ song, dropMs: d.ms, entryMs })
      }
      // Cruise plays from 0:00 — EVERY song is cruise-capable. (Loop markers
      // used to gate this; that's the loop era's leftover, and it silently
      // excluded songs whose analysis found no loopable section — common
      // outside EDM.)
      this.loopable.push({ song, startMs: 0, endMs: 0 })
    }
    if (this.dropStyle === 'anticipated' && this.droppable.length === 0) this.warnings.push('no drop-tagged songs')
    if (this.loopable.length === 0) this.warnings.push('no songs')
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
      // Learned edge: real DJs played this pair adjacently/layered in the
      // harvested sets. Capped at +2 so ground truth outweighs a heuristic
      // point but can't override gross tempo/key mismatch + freshness.
      const learned = from
        ? Math.min(2, this.pairBonus[`${this.normKey.get(from.trackId)}>${this.normKey.get(c.song.trackId)}`] ?? 0)
        : 0
      const score = (from ? mixScore(from, c.song) : 0) + learned - (recent.has(c.song.trackId) ? 1 : 0)
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

  /** Cruise: enter the next song at its groove and LET IT PLAY. No loops —
   *  the listener hears most of a song; changes happen at song ends, at the
   *  ~3min freshness mark, or when a rep demands a buildup. (Loop-backs as
   *  default texture were "the UX sucks when it loops every 30 seconds" —
   *  Ethan, 2026-08-16. The loop markers stay as groove ENTRY points.) */
  /** Where should this cruise END, in track time? With segment structure:
   *  the first boundary in [entry+MIN, entry+CAP] where a strong section
   *  just finished (leave on top); any boundary in-window beats the timer;
   *  no structure → the corpus timer. */
  private chainExitPosMs(song: SongTags, entryMs: number): number {
    const segs = song.segments
    if (segs && segs.length > 0) {
      const minExit = entryMs + MIN_FILL_RIDE_MS
      const cap = entryMs + FILL_RIDE_CAP_MS
      let fallback: number | null = null
      for (const s of segs) {
        if (s.endMs < minExit || s.endMs > cap) continue
        if (HIGH_ENERGY_LABELS.has(s.label)) return s.endMs
        fallback ??= s.endMs
      }
      if (fallback != null) return fallback
    }
    return entryMs + MAX_FILL_RIDE_MS
  }

  private startFill(t: number) {
    const fill = this.pickLoop()
    if (!fill) return
    this.mode = 'fill'
    // Songs start at the BEGINNING — Spotify-style listening ("until we get
    // really great mixing, songs should just play from the beginning").
    this.fillExitPosMs = this.chainExitPosMs(fill.song, 0)
    this.emit(t, fill.song, 0, 1.2, `groove fill (${fill.song.name})`)
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

    // Actual hard-step arrival: score the landing, ensure the moment is marked.
    for (const step of entered) {
      if (step.kind === 'hard') {
        if (this.mode === 'build' && this.buildTargetT != null) {
          this.landings.push({ targetTMs: this.buildTargetT, actualTMs: t, errorMs: t - this.buildTargetT })
        } else if (this.dropStyle === 'fresh') {
          // ETA collapsed before the commit — change songs NOW, from the top.
          const pick = this.pickLoop()
          if (pick) {
            this.emit(t, pick.song, 0, 0.3, `rep change (truncated) (${pick.song.name})`)
            this.landings.push({ targetTMs: t, actualTMs: t, errorMs: 0 })
          }
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
        // Hard step over — back to the groove... unless the NEXT effort's
        // buildup would cut in moments later (short rests): then changing
        // songs twice in quick succession is worse than riding this one
        // straight through the rest into the buildup.
        const eta = this.etaToNextHardMs(t, dist)
        const peek = this.dropStyle === 'anticipated' ? this.pickBest(this.droppable, this.dropIdx) : null
        const lead = this.dropStyle === 'fresh' ? FRESH_CHANGE_LEAD_MS : peek ? peek.choice.dropMs - peek.choice.entryMs : 0
        if (eta == null || eta > lead + RELEASE_MIN_LISTEN_MS) this.startFill(t)
        this.crestRideUntil = null
      }
    }

    // First sample of the session: a plan that OPENS on a hard step opens on
    // a drop (backtest 2026-08-16: every progressive long run's first effort
    // was missed — step 0 is never "entered", so nothing choreographed it).
    if (this.mode === null) {
      if (this.currentStep()?.kind === 'hard') {
        const pick = this.dropStyle === 'fresh' ? this.pickLoop() : this.pickDrop()
        if (pick) {
          const pos = this.dropStyle === 'fresh' ? 0 : (pick as DropChoice).dropMs
          const reason = this.dropStyle === 'fresh' ? 'rep change (opening)' : 'drop lands (opening)'
          this.emit(t, pick.song, pos, 0.3, `${reason} (${pick.song.name})`)
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
        if (this.dropStyle === 'fresh') {
          const pick = this.pickLoop()
          if (pick) {
            this.emit(t, pick.song, 0, 0.45, `rep change (crest reward) (${pick.song.name})`)
            this.mode = 'ride'
            this.crestRideUntil = t + CREST_RIDE_MS
          }
        } else {
          const pick = this.pickDrop()
          if (pick) {
            this.emit(t, pick.song, pick.dropMs, 0.45, `drop lands (crest reward) (${pick.song.name})`)
            this.mode = 'ride'
            this.crestRideUntil = t + CREST_RIDE_MS
          }
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
    // The SAME check runs while cruising: the engine watches the ETA every
    // second and leaves the current song exactly buildup-length before the
    // effort — no loop boundary to wait for, no holding pattern.
    if ((this.mode === 'ride' || this.mode === 'fill') && this.crestRideUntil == null) {
      const eta = this.etaToNextHardMs(t, dist)
      if (eta != null && this.dropStyle === 'fresh') {
        // Fresh mode: a NEW song from 0:00, crossfade timed so the swap
        // peaks right as the rep begins. The prediction machinery still owns
        // the WHEN; only the WHAT changed.
        if (eta <= FRESH_CHANGE_LEAD_MS) {
          const pick = this.pickLoop()
          if (pick) {
            this.emit(t, pick.song, 0, 0.45, `rep change (${pick.song.name})`)
            this.mode = 'build'
            this.buildTargetT = t + eta
            this.buildDropMs = null // no re-aim: the window is 4s, drift can't matter
          }
        }
      } else if (eta != null) {
        const r = this.pickBest(this.droppable, this.dropIdx)
        if (r) {
          const buildLen = r.choice.dropMs - r.choice.entryMs
          if (eta <= buildLen) {
            this.dropIdx += r.advance
            const positionMs = snapToBeat(Math.max(0, r.choice.dropMs - eta), r.choice.dropMs, r.choice.song.bpm)
            const reason = this.mode === 'ride' ? 'buildup toward next rep' : 'buildup toward the effort'
            this.emit(t, r.choice.song, positionMs, 0.45, `${reason} (${r.choice.song.name})`)
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

    // Cruise chain point: change songs where the MUSIC says to — at the
    // planned segment boundary (strong section just ended), or the corpus
    // timer when the song carries no structure.
    if (this.mode === 'fill' && this.playing && this.fillExitPosMs != null && this.loopable.length > 1) {
      if (this.playheadMs(t) >= this.fillExitPosMs) this.startFill(t)
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
