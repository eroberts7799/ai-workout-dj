// Session clock + cue dispatch, pure and testable (time injected).
import type { Cue } from '../conductor/types'

/** Pausable workout clock. All times ms. `now` injected for tests. */
export class SessionClock {
  private startedAt: number | null = null
  private pausedAt: number | null = null
  private pausedTotal = 0

  constructor(private readonly now: () => number = () => performance.now()) {}

  start(): void {
    this.startedAt = this.now()
    this.pausedAt = null
    this.pausedTotal = 0
  }

  pause(): void {
    if (this.startedAt !== null && this.pausedAt === null) this.pausedAt = this.now()
  }

  resume(): void {
    if (this.pausedAt !== null) {
      this.pausedTotal += this.now() - this.pausedAt
      this.pausedAt = null
    }
  }

  get running(): boolean {
    return this.startedAt !== null && this.pausedAt === null
  }

  get started(): boolean {
    return this.startedAt !== null
  }

  /** Workout time: wall time minus paused time. Frozen while paused. */
  nowMs(): number {
    if (this.startedAt === null) return 0
    const end = this.pausedAt ?? this.now()
    return end - this.startedAt - this.pausedTotal
  }
}

/**
 * Cues whose (compensated) fire time falls in (prevMs, nowMs]. Call on every
 * tick with the previous tick's clock value; each cue fires exactly once.
 * leadMs = measured median command latency (issue early so the cut lands on time).
 */
export function dueCues(cues: Cue[], prevMs: number, nowMs: number, leadMs: number): Cue[] {
  return cues.filter((c) => {
    const fireAt = c.atMs - leadMs
    return fireAt > prevMs && fireAt <= nowMs
  })
}
