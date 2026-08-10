import type { SongTags } from '../tags/types'

/** One step of a time-based structured workout (v1: time-deterministic only). */
export interface WorkoutStep {
  kind: 'warmup' | 'easy' | 'hard' | 'rest' | 'cooldown'
  seconds: number
  label?: string
}

export interface WorkoutPlan {
  name: string
  steps: WorkoutStep[]
}

/** A scheduled playback command, times in ms from workout t=0. */
export interface Cue {
  /** When to execute, ms into the workout. */
  atMs: number
  trackId: string
  uri: string
  /** Where to enter the track, ms into the track (continuous — not boundary-quantized). */
  positionMs: number
  reason: string
}

export interface Setlist {
  cues: Cue[]
  /** Human-readable issues (e.g. not enough tagged songs) — never throws mid-run. */
  warnings: string[]
}

export type { SongTags }
