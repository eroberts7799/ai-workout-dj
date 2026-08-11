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

export interface LiveSample {
  /** Session clock, ms (watch timer). */
  tMs: number
  /** Accumulated activity distance, meters (absent for time-only plans). */
  distanceM?: number
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

  private mode: Mode | null = null
  private playing: { song: SongTags; positionAtMs: number; atTMs: number } | null = null
  private loopBounds: { startMs: number; endMs: number } | null = null
  private buildTargetT: number | null = null

  readonly commands: PlayCommand[] = []
  readonly landings: LandingReport[] = []
  readonly warnings: string[] = []

  constructor(plan: WorkoutPlan, songs: SongTags[], opts: { paceSecPerKm?: number } = {}) {
    this.steps = plan.steps
    this.paceSecPerKm = opts.paceSecPerKm ?? DEFAULT_PACE_SEC_PER_KM
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
  } {
    return {
      stepIdx: this.stepIdx,
      mode: this.mode,
      paceSecPerKm: this.paceSecPerKm,
      playingTrackId: this.playing?.song.trackId ?? null,
      etaToHardMs: this.lastT != null ? this.etaToNextHardMs(this.lastT, this.lastDist) : null,
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

  /** Progress current step; advance through completed steps. Returns kinds entered. */
  private trackSteps(t: number, dist: number | null): WorkoutStep[] {
    const entered: WorkoutStep[] = []
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
      this.stepIdx++
      this.stepStartT = step.seconds != null ? this.stepStartT + step.seconds * 1000 : t
      this.stepStartDist = dist ?? this.stepStartDist
      const next = this.currentStep()
      if (next) entered.push(next)
    }
    return entered
  }

  /** ms until the next hard step STARTS (null if none ahead or currently in one). */
  private etaToNextHardMs(t: number, dist: number | null): number | null {
    const cur = this.currentStep()
    if (!cur) return null
    if (cur.kind === 'hard') return null
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

  private pickDrop(): DropChoice | null {
    if (this.droppable.length === 0) return null
    for (let i = 0; i < this.droppable.length; i++) {
      const c = this.droppable[(this.dropIdx + i) % this.droppable.length]
      if (c.song.trackId !== this.playing?.song.trackId) {
        this.dropIdx += i + 1
        return c
      }
    }
    return this.droppable[this.dropIdx++ % this.droppable.length]
  }

  private pickLoop(): LoopChoice | null {
    if (this.loopable.length === 0) return null
    for (let i = 0; i < this.loopable.length; i++) {
      const c = this.loopable[(this.loopIdx + i) % this.loopable.length]
      if (c.song.trackId !== this.playing?.song.trackId) {
        this.loopIdx += i + 1
        return c
      }
    }
    return this.loopable[this.loopIdx++ % this.loopable.length]
  }

  private startFill(t: number) {
    const fill = this.pickLoop()
    if (!fill) return
    this.mode = 'fill'
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
    this.lastT = t
    this.lastDist = dist

    const entered = this.trackSteps(t, dist)

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
      } else if (this.mode === 'ride') {
        // Hard step over — back to groove.
        this.startFill(t)
      }
    }

    if (this.mode === null) this.startFill(t)

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
            // Last viable boundary: enter so the drop lands exactly at ETA.
            const positionMs = Math.max(0, pick.dropMs - eta)
            this.emit(t, pick.song, positionMs, 0.45, `buildup toward the effort (${pick.song.name})`)
            this.mode = 'build'
            this.buildTargetT = t + eta
            return this.commands.slice(before)
          }
        }
        this.emit(t, this.playing.song, this.loopBounds.startMs, 0.25, `loop back (${this.playing.song.name})`)
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
