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
import { RouteMatcher, type AheadCue, type Route } from './route-match'
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
  /** Streamed shape of the CURRENT watch step (follow mode): engine kind
   *  ('warmup'|'hard'|'rest'|…), duration type (0 = time s, 1 = distance m),
   *  and the prescribed amount. */
  wkKind?: string
  wkDurationType?: number
  wkDurationValue?: number
  /** Kind of the NEXT step — what anticipation aims at with no plan loaded. */
  wkNextKind?: string
  /** Phone GPS fix (both tiers, 2026-09-06) — feeds route matching: "your
   *  history is your route". Own data only; never leaves key-gated storage. */
  lat?: number
  lon?: number
}

/** A terrain cue the route matcher saw coming, frozen at the fresh-cut
 *  lead — the engine's claim about WHEN the hill tops out. Graded against
 *  the reactive detector in `terrainLandings`. */
export interface TerrainPrediction {
  key: string
  type: 'climbStart' | 'crest'
  tMs: number
  predictedTMs: number
  liveDistanceM: number
  gainM: number
  confidence: number
  /** Whether this prediction moved the music (false = shadow mode). */
  drove: boolean
}

export interface TerrainLanding {
  key: string
  predictedTMs: number
  actualTMs: number
  errorMs: number
}

export interface PlayCommand {
  tMs: number
  trackId: string
  uri: string
  positionMs: number
  fadeSec: number
  reason: string
  /** Cruise commands carry a second pick so a streaming executor can queue
   *  it — the runner's "next" button lands somewhere real instead of
   *  restarting the song (8/25 easy run). Pure suggestion: if it actually
   *  plays, the executor reports it via syncExternalPlayback. */
  spareTrackId?: string
  spareUri?: string
  /** The player is ALREADY on this song — a natural roll into the spare it
   *  held, or an adoption the executor just observed. Issue no play; only
   *  queue the new spare so the chain continues natively. (9/3 walk: the
   *  engine cut at its MODELED song end, ±3s off the real one — early was a
   *  hard pause, late restarted the song Spotify had already rolled into.) */
  handoff?: boolean
}

/** A manual song change the executor observed — the runner overruled the
 *  DJ. The abandoned track is the flywheel's first thumbs-down signal. */
export interface SkipEvent {
  tMs: number
  fromTrackId: string | null
  fromPositionMs: number | null
  toTrackId: string
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

/** Moment fit from perceived intensity (tag table, 0..1 — observed 0.5–1.0).
 *  Hard moments (drops, rep changes, crest rewards) pull high-energy songs
 *  hard (±2: a banger belongs on the rep, even over a slightly better key
 *  match); wind-down fills (rest, cooldown) nudge low (±1: calm preferred,
 *  mix quality still leads). Unknown energy is neutral — an untagged song
 *  is never punished (rule 4: honest neutrality beats a guessed penalty). */
export function energyFit(energy: number | null | undefined, want: 'high' | 'low' | null): number {
  if (energy == null || want == null) return 0
  if (want === 'high') return Math.max(-2, Math.min(2, (energy - 0.5) * 4))
  return Math.max(-1, Math.min(1, (0.5 - energy) * 2))
}

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
/** How far past the freshness timer a structureless song may run to reach
 *  its natural end. Was 90s (4:30 ceiling) — the 8/25 easy run voted it
 *  down: every >4:30 track still got the 3:00 guillotine and Ethan heard
 *  every cut ("songs were def getting cut off"). On a cruise, songs
 *  FINISH: 180s slack = a 6:00 ceiling that covers effectively the whole
 *  radio-edit universe; only true extended mixes get the timer. */
const NATURAL_END_SLACK_MS = 180_000
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
  readonly skips: SkipEvent[] = []

  /** Learned pairing weights ("<norm from>><norm to>" → observed count) —
   *  mined from real DJ sets by analysis/selection_weights.py. */
  private readonly pairBonus: Record<string, number>
  /** trackId → normalized "artist title" key (mirrors the miner's norm()). */
  private readonly normKey = new Map<string, string>()

  private readonly dropStyle: DropStyle
  /** ROUTE AWARENESS (design doc Approach B, live wiring 2026-09-06). The
   *  matcher identifies which past route the runner is on from the phone's
   *  GPS; its terrain cues ahead become PREDICTIONS here. SHADOW by default:
   *  every prediction is logged and graded against the reactive crest
   *  detector, but the music still follows the reactive rules until the
   *  field error proves small (route backtest 2026-09-06: cross-run summit
   *  disagreement was unvalidated, n=7 — evaluators before optimizers). */
  private readonly matcher: RouteMatcher | null
  private readonly terrainDrivesMusic: boolean
  readonly terrainPredictions: TerrainPrediction[] = []
  readonly terrainLandings: TerrainLanding[] = []
  /** A frozen crest prediction waiting for the reactive detector to grade it. */
  private terrainPending: TerrainPrediction | null = null
  /** Reactive crest rule stays quiet until this live distance — a predicted
   *  crest already changed the song. */
  private crestSuppressUntilDist: number | null = null
  private lastFixDist: number | null = null
  /** FOLLOW MODE: constructed with an empty plan, the engine conducts
   *  straight from the watch's stream — the workout lives in Runna/Garmin,
   *  nobody should retype it. Current step shape + next-step kind arrive on
   *  every sample; boundaries on seq bumps, exactly as in plan mode. */
  private readonly followMode: boolean
  private followStep: WorkoutStep | null = null
  private followNextKind: string | null = null

  /** STREAMING HANDOFF: the executor is a remote player (Spotify) that holds
   *  the current song plus its advertised spare as a native context. A song
   *  end is then the player's own gapless (or user-crossfaded) roll — no
   *  command can time a cut better than "no cut". The engine adopts the
   *  spare at the modeled end and asks the executor to queue the next one.
   *  Off for the owned-file deck, whose crossfades are the product. */
  private readonly streamingHandoff: boolean
  /** Spare advertised with the song now playing — what the executor holds next. */
  private playingSpare: SongTags | null = null
  /** The song a handoff just left, kept so a verification read that finds
   *  the player STILL on it (model ran early) can revert without a skip. */
  private lastHandoffFrom: { song: SongTags; spare: SongTags } | null = null

  constructor(
    plan: WorkoutPlan,
    songs: SongTags[],
    opts: {
      paceSecPerKm?: number
      hrMax?: number
      pairBonus?: Record<string, number>
      dropStyle?: DropStyle
      streamingHandoff?: boolean
      routes?: Route[]
      terrainDrivesMusic?: boolean
    } = {},
  ) {
    this.matcher = opts.routes && opts.routes.length > 0 ? new RouteMatcher(opts.routes) : null
    this.terrainDrivesMusic = opts.terrainDrivesMusic ?? false
    this.steps = plan.steps
    this.paceSecPerKm = opts.paceSecPerKm ?? DEFAULT_PACE_SEC_PER_KM
    this.hrTracker = new HrTracker(opts.hrMax)
    this.pairBonus = opts.pairBonus ?? {}
    this.dropStyle = opts.dropStyle ?? 'fresh'
    this.streamingHandoff = opts.streamingHandoff ?? false
    this.followMode = plan.steps.length === 0
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
    route: { routeId: string; reversed: boolean; progressM: number; remainingM: number; agreement: number } | null
    /** Next terrain cue ahead on the locked route, with its ETA at current pace. */
    terrainAhead: { type: 'climbStart' | 'crest'; etaMs: number; gainM: number; confidence: number } | null
  } {
    const next = this.nextAheadCue()
    return {
      route: this.matcher?.lock ?? null,
      terrainAhead: next ? { type: next.type, etaMs: this.cueEtaMs(next), gainM: next.gainM, confidence: next.confidence } : null,
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

  private cueEtaMs(cue: AheadCue): number {
    return (cue.flatEquivRemainingM / 1000) * this.paceSecPerKm * 1000
  }

  /** The nearest cue ahead that still matters (crests need a real hill). */
  private nextAheadCue(): AheadCue | null {
    if (!this.matcher) return null
    for (const c of this.matcher.aheadCues()) {
      if (c.type === 'crest' && c.gainM < 30) continue
      return c
    }
    return null
  }

  /** Current playhead position in the active track at time t. */
  private playheadMs(t: number): number {
    if (!this.playing) return 0
    return this.playing.positionAtMs + (t - this.playing.atTMs)
  }

  private emit(t: number, song: SongTags, positionMs: number, fadeSec: number, reason: string, spare?: SongTags | null, handoff = false) {
    this.commands.push({
      tMs: t, trackId: song.trackId, uri: song.uri, positionMs, fadeSec, reason,
      ...(spare ? { spareTrackId: spare.trackId, spareUri: spare.uri } : {}),
      ...(handoff ? { handoff: true } : {}),
    })
    // A same-song re-aim keeps the spare the executor already holds; a new
    // song carries its own (or none — the executor then holds nothing next).
    const sameSong = this.playing?.song.trackId === song.trackId
    this.playingSpare = spare ?? (sameSong ? this.playingSpare : null)
    if (!handoff) this.lastHandoffFrom = null
    this.playing = { song, positionAtMs: positionMs, atTMs: t }
  }

  /** The executor's queue insurance: what "next" should land on if the
   *  runner skips DURING `chosen` — and, under streaming handoff, what the
   *  player rolls into at the song's end. Same scoring as a cruise pick
   *  (mix + learned + taste − recency) so the natural next is as good as a
   *  cut would have been. Pure peek — no rotation consumption; state
   *  changes only if the spare actually plays (syncExternalPlayback / handoff). */
  private peekSpare(chosen: SongTags): SongTags | null {
    const recent = new Set(this.commands.slice(-6).map((c) => c.trackId))
    let best: { song: SongTags; score: number } | null = null
    for (const c of this.loopable) {
      if (c.song.trackId === chosen.trackId) continue
      const learned = Math.min(2, this.pairBonus[`${this.normKey.get(chosen.trackId)}>${this.normKey.get(c.song.trackId)}`] ?? 0)
      const taste = Math.max(-2, Math.min(2, c.song.affinity ?? 0))
      const score = mixScore(chosen, c.song) + learned + taste - (recent.has(c.song.trackId) ? 1 : 0)
      if (!best || score > best.score) best = { song: c.song, score }
    }
    return best?.song ?? null
  }

  /** The player is on `song` at `positionMs` (rolled there itself, or the
   *  executor saw it there): adopt it, advertise its spare, emit a handoff
   *  command — no play, the executor only queues the spare. */
  private handoff(t: number, song: SongTags, positionMs: number, reason: string, predicted: boolean) {
    const from = this.playing?.song ?? null
    if (this.mode !== 'ride') this.mode = 'fill'
    this.fillExitPosMs = this.chainExitPosMs(song, positionMs)
    const spare = this.peekSpare(song)
    this.emit(t, song, positionMs, 0, reason, spare, true)
    // Only a PREDICTED handoff (the model's end estimate) can be found early
    // by verification; an adoption was observed, there is nothing to revert.
    this.lastHandoffFrom = predicted && from ? { song: from, spare: song } : null
  }

  /** The executor observed playback that differs from the model — a manual
   *  skip, a queue-spare firing, any external change. Adopt reality (the
   *  model must never argue with the speaker) and record the overrule:
   *  the abandoned song at its abandoned position is ground-truth negative
   *  feedback. Same-track calls with drifted position re-anchor the model
   *  (late watchdog delivery, restarts).
   *
   *  `natural`: the executor read this right after a modeled song end — the
   *  player's own progression, not the runner's hand. Never a skip. Returns
   *  any command the adoption emitted (a handoff, under streaming handoff)
   *  so the executor can act on it outside advance(). */
  syncExternalPlayback(trackId: string, positionMs: number, tMs: number, natural = false): PlayCommand[] {
    const before = this.commands.length
    const cur = this.playing
    if (cur && cur.song.trackId === trackId) {
      const modeled = cur.positionAtMs + (tMs - cur.atTMs)
      if (Math.abs(modeled - positionMs) > 5000) {
        this.playing = { song: cur.song, positionAtMs: positionMs, atTMs: tMs }
        if (this.mode === 'fill') this.fillExitPosMs = this.chainExitPosMs(cur.song, Math.min(positionMs, cur.song.durationMs))
      }
      return []
    }
    // The model handed off early: the player is still finishing the song we
    // left. Step back onto it (spare intact — the player still holds it) and
    // let the handoff fire again at the corrected end. No skip, no command.
    const prev = this.lastHandoffFrom
    const last = this.commands[this.commands.length - 1]
    if (natural && prev && prev.song.trackId === trackId && last?.handoff && last.trackId === cur?.song.trackId) {
      this.playing = { song: prev.song, positionAtMs: positionMs, atTMs: tMs }
      this.playingSpare = prev.spare
      this.lastHandoffFrom = null
      this.commands.pop() // the premature handoff never happened for the executor
      return []
    }
    const found = this.loopable.find((c) => c.song.trackId === trackId)
    const rolledIntoSpare =
      cur != null && this.playingSpare?.trackId === trackId
      && cur.positionAtMs + (tMs - cur.atTMs) >= cur.song.durationMs - 10_000
    // A roll into the spare at the song's end is the chain working, not a
    // thumbs-down (9/3 walk logged one as a "skip" of a song played to 308/312s).
    if (!natural && !rolledIntoSpare) {
      this.skips.push({
        tMs,
        fromTrackId: cur?.song.trackId ?? null,
        fromPositionMs: cur ? Math.round(cur.positionAtMs + (tMs - cur.atTMs)) : null,
        toTrackId: trackId,
      })
    }
    if (!found) return [] // external track outside the library — feedback logged, model unchanged
    if (this.streamingHandoff) {
      this.handoff(tMs, found.song, positionMs, `handoff (${found.song.name})`, false)
    } else {
      this.playing = { song: found.song, positionAtMs: positionMs, atTMs: tMs }
      if (this.mode === 'fill') this.fillExitPosMs = this.chainExitPosMs(found.song, positionMs)
    }
    return this.commands.slice(before)
  }

  private currentStep(): WorkoutStep | null {
    if (this.followMode) return this.followStep
    return this.steps[this.stepIdx] ?? null
  }

  /** The current step as the watch streams it (follow mode). */
  private stepFromSample(s: LiveSample): WorkoutStep | null {
    if (!s.wkKind) return null
    const KINDS = new Set(['warmup', 'easy', 'hard', 'rest', 'cooldown'])
    const kind = (KINDS.has(s.wkKind) ? s.wkKind : 'easy') as WorkoutStep['kind']
    if (s.wkDurationType === 0 && s.wkDurationValue != null) return { kind, seconds: s.wkDurationValue }
    if (s.wkDurationType === 1 && s.wkDurationValue != null) return { kind, meters: s.wkDurationValue }
    return { kind }
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

  private trackSteps(t: number, dist: number | null, sample: LiveSample): WorkoutStep[] {
    const wkSeq = sample.wkStepSeq
    const entered: WorkoutStep[] = []
    const prevT = this.lastT
    const prevDist = this.lastDist

    if (this.followMode) {
      const streamed = this.stepFromSample(sample)
      this.followNextKind = sample.wkNextKind ?? this.followNextKind
      if (wkSeq != null && this.wkSeq == null) {
        // Joined the workout mid-step: start the clock here.
        this.wkSeq = wkSeq
        this.followStep = streamed
        this.stepStartT = t
        this.stepStartDist = dist ?? 0
        return entered
      }
      if (wkSeq != null && this.wkSeq != null && wkSeq > this.wkSeq) {
        // Watch boundary — refine WHEN via the OLD step's prescription.
        const prev = this.followStep
        const { bT, bD } = prev ? this.boundaryEstimate(prev, prevT, prevDist, t, dist) : { bT: t, bD: dist }
        this.wkSeq = wkSeq
        this.stepIdx++
        this.stepStartT = bT
        this.stepStartDist = bD ?? this.stepStartDist
        this.followStep = streamed ?? this.followStep
        if (this.followStep) entered.push(this.followStep)
        return entered
      }
      // Overdue fallback: identical adjacent steps never bump the sig — if
      // the current step is far past its prescription, advance by odometer
      // (the streamed shape still describes the step we're now in).
      const cur = this.followStep
      if (cur) {
        const overdue =
          cur.seconds != null
            ? t - this.stepStartT - cur.seconds * 1000 > Math.max(12_000, cur.seconds * 250)
            : dist != null && cur.meters != null
              ? dist - this.stepStartDist - cur.meters > Math.max(50, cur.meters * 0.25)
              : false
        if (overdue) {
          if (cur.seconds != null) {
            this.stepStartT = this.stepStartT + cur.seconds * 1000
          } else {
            this.stepStartDist = this.stepStartDist + (cur.meters ?? 0)
            this.stepStartT = t
          }
          this.stepIdx++
          this.followStep = streamed ?? cur
          this.warnings.push(`watch step stream stalled — advanced step ${this.stepIdx} by odometer`)
          if (this.followStep) entered.push(this.followStep)
        }
      }
      return entered
    }

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
    if (this.followMode) {
      // The watch shows one step ahead — enough: anticipate when the NEXT
      // step is the effort, whatever the current one is.
      return this.followNextKind === 'hard' ? this.remainingMs(cur, t, dist) : null
    }
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
    wantEnergy: 'high' | 'low' | null = null,
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
      // Taste: lifetime affinity for the candidate itself (−2..+2). Intrinsic
      // to the song, not the transition — a track Ethan loves gets picked
      // more, one he skips less, all else near-equal.
      const taste = Math.max(-2, Math.min(2, c.song.affinity ?? 0))
      const score =
        (from ? mixScore(from, c.song) : 0) + learned + taste
        + energyFit(c.song.energy, wantEnergy)
        - (recent.has(c.song.trackId) ? 1 : 0)
      if (!best || score > best.score) best = { choice: c, advance: i + 1, score }
    }
    if (best) return best
    return { choice: choices[startIdx % choices.length], advance: 1 }
  }

  private pickDrop(): DropChoice | null {
    // A drop IS a hard moment — it always wants a banger.
    const r = this.pickBest(this.droppable, this.dropIdx, 'high')
    if (!r) return null
    this.dropIdx += r.advance
    return r.choice
  }

  private pickLoop(wantEnergy: 'high' | 'low' | null = null): LoopChoice | null {
    const r = this.pickBest(this.loopable, this.loopIdx, wantEnergy)
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
    // No structure to consult (streaming-tier scrapes carry no segments) —
    // but duration IS known. If the song's end is within reach of the timer,
    // ride to it: never-silence fires the change at the natural end. The 8/22
    // trail run cut all 99 fills at exactly 3:00 regardless of the song —
    // arbitrary mid-song exits for tracks that had ≤90s left to give.
    if (song.durationMs - entryMs <= MAX_FILL_RIDE_MS + NATURAL_END_SLACK_MS) {
      return song.durationMs
    }
    return entryMs + MAX_FILL_RIDE_MS
  }

  private startFill(t: number) {
    // Wind-down fills (rest, cooldown) breathe; everything else is neutral —
    // the hard/easy CONTRAST is the emotion machine, and it needs both poles.
    const kind = this.currentStep()?.kind
    const fill = this.pickLoop(kind === 'rest' || kind === 'cooldown' ? 'low' : null)
    if (!fill) return
    this.mode = 'fill'
    // Songs start at the BEGINNING — Spotify-style listening ("until we get
    // really great mixing, songs should just play from the beginning").
    this.fillExitPosMs = this.chainExitPosMs(fill.song, 0)
    this.emit(t, fill.song, 0, 1.2, `groove fill (${fill.song.name})`, this.peekSpare(fill.song))
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
    // Route matching: a GPS fix + the odometer identify the route ahead.
    if (this.matcher && sample.lat != null && sample.lon != null && dist != null && dist !== this.lastFixDist) {
      this.matcher.update({ lat: sample.lat, lon: sample.lon, distM: dist })
      this.lastFixDist = dist
    }

    // trackSteps reads lastT/lastDist as the PREVIOUS sample (boundary
    // interpolation window) — update them only after.
    const entered = this.trackSteps(t, dist, sample)
    this.lastT = t
    this.lastDist = dist

    // Actual hard-step arrival: score the landing, ensure the moment is marked.
    for (const step of entered) {
      if (step.kind === 'hard') {
        if (this.mode === 'build' && this.buildTargetT != null) {
          this.landings.push({ targetTMs: this.buildTargetT, actualTMs: t, errorMs: t - this.buildTargetT })
        } else if (this.dropStyle === 'fresh') {
          // ETA collapsed before the commit — change songs NOW, from the top.
          const pick = this.pickLoop('high')
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
        const peek = this.dropStyle === 'anticipated' ? this.pickBest(this.droppable, this.dropIdx, 'high') : null
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
        const pick = this.dropStyle === 'fresh' ? this.pickLoop('high') : this.pickDrop()
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

    // Predicted crest (route-aware): the matcher says the summit is
    // FRESH_CHANGE_LEAD_MS away at current pace. Freeze the prediction; in
    // drive mode (confidence ≥ 0.5 = real hill AND every plausible route
    // agrees on the future) change the song NOW so it lands on the summit —
    // in shadow mode just log it and let the reactive rule below play.
    if (dist != null && this.terrainPending == null) {
      const cue = this.nextAheadCue()
      if (cue && cue.type === 'crest') {
        const eta = this.cueEtaMs(cue)
        if (eta <= FRESH_CHANGE_LEAD_MS && !this.terrainPredictions.some((p) => p.key === cue.key)) {
          const hardEta = this.etaToNextHardMs(t, dist)
          const earned = this.hrState.hr == null || this.hrState.zone >= 3
          const drive = this.terrainDrivesMusic && cue.confidence >= 0.5 && this.mode === 'fill'
            && (hardEta == null || hardEta > CREST_MIN_ETA_MS) && earned && this.dropStyle === 'fresh'
          const pred: TerrainPrediction = {
            key: cue.key, type: 'crest', tMs: t, predictedTMs: t + eta, liveDistanceM: cue.liveDistanceM,
            gainM: cue.gainM, confidence: cue.confidence, drove: drive,
          }
          this.terrainPredictions.push(pred)
          this.terrainPending = pred
          if (drive) {
            const pick = this.pickLoop('high')
            if (pick) {
              this.emit(t, pick.song, 0, 0.45, `rep change (crest ahead) (${pick.song.name})`, this.peekSpare(pick.song))
              this.fillExitPosMs = this.chainExitPosMs(pick.song, 0)
              this.crestSuppressUntilDist = cue.liveDistanceM + 250
            }
          }
        }
      }
    }
    // Grade the pending prediction when the reactive detector fires (or give
    // up 400m past the predicted summit — the hill never crested).
    if (this.terrainPending && dist != null) {
      const pend = this.terrainPending
      if (this.gradeState.crest) {
        this.terrainLandings.push({ key: pend.key, predictedTMs: pend.predictedTMs, actualTMs: t, errorMs: t - pend.predictedTMs })
        this.terrainPending = null
      } else if (dist > pend.liveDistanceM + 400) {
        this.terrainPending = null
      }
    }
    if (this.crestSuppressUntilDist != null && dist != null && dist > this.crestSuppressUntilDist) this.crestSuppressUntilDist = null

    // Crest reward: you ground up a real hill and just topped out — the drop
    // hits NOW. Only from the groove (planned drops own their moments), only
    // when no hard step is imminent, and only if the body actually worked
    // for it (zone ≥ 3 when HR data exists). Silent while a PREDICTED crest
    // already changed the song for this hill.
    if (this.gradeState.crest && this.mode === 'fill' && this.crestSuppressUntilDist == null) {
      const eta = this.etaToNextHardMs(t, dist)
      const earned = this.hrState.hr == null || this.hrState.zone >= 3
      if ((eta == null || eta > CREST_MIN_ETA_MS) && earned) {
        if (this.dropStyle === 'fresh') {
          // Fresh mode: the crest song is a normal cruise entry — it plays
          // through like any groove fill (chain point / freshness apply from
          // its own entry). The 25s ride time-box belongs to the anticipated
          // style, where the entry IS a drop section; time-boxing a song that
          // started at 0:00 amputated it mid-intro and gave every summit
          // three songs in 90s (trail run 2026-08-22, all 6 crests).
          const pick = this.pickLoop('high')
          if (pick) {
            this.emit(t, pick.song, 0, 0.45, `rep change (crest reward) (${pick.song.name})`, this.peekSpare(pick.song))
            this.fillExitPosMs = this.chainExitPosMs(pick.song, 0)
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
          const pick = this.pickLoop('high')
          if (pick) {
            this.emit(t, pick.song, 0, 0.45, `rep change (${pick.song.name})`)
            this.mode = 'build'
            this.buildTargetT = t + eta
            this.buildDropMs = null // no re-aim: the window is 4s, drift can't matter
          }
        }
      } else if (eta != null) {
        const r = this.pickBest(this.droppable, this.dropIdx, 'high')
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

    // Never-silence: chain a fresh groove if the current track would end.
    // Runs BEFORE the chain point so a natural end (exit == duration) is
    // owned here — as a handoff when the player holds the spare, otherwise
    // as a cut with a 1.5s crossfade lead.
    if (this.playing && this.mode !== 'build') {
      const pos = this.playheadMs(t)
      const dur = this.playing.song.durationMs
      if (this.streamingHandoff && this.playingSpare) {
        // No lead: nothing to deliver, the player rolls by itself. The
        // model adopts the spare at ITS end estimate; the executor's
        // verification read re-anchors (or reverts) against reality.
        if (pos >= dur) this.handoff(t, this.playingSpare, 0, `handoff (${this.playingSpare.name})`, true)
      } else if (pos >= dur - 1500 && this.mode !== 'ride') {
        this.startFill(t)
      } else if (pos >= dur - 1500 && this.mode === 'ride') {
        this.startFill(t)
        this.mode = 'ride'
      }
    }

    // Cruise chain point: change songs where the MUSIC says to — at the
    // planned segment boundary (strong section just ended), or the corpus
    // timer when the song carries no structure.
    if (this.mode === 'fill' && this.playing && this.fillExitPosMs != null && this.loopable.length > 1) {
      if (this.playheadMs(t) >= this.fillExitPosMs) this.startFill(t)
    }

    return this.commands.slice(before)
  }
}
