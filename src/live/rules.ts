// Body-signal rule modules for the LiveEngine — pure, sample-in state-out.
//
// GradeTracker: live grade % from the watch's altitude stream, climb
// detection, and the moment the design doc always wanted: the CREST — you
// grind up a hill and the drop hits as you top out.
//
// HrTracker: smoothed heart rate and classic five-zone classification, so
// rules can ask "is this actually an effort?" before rewarding it.

/** Grade below which a climb counts as topped out. */
const CREST_GRADE = 0.005
/** Grade at which sustained ascent counts as climbing. */
const CLIMB_GRADE = 0.025
/** Minimum vertical gain before a crest is worth celebrating. */
const MIN_CLIMB_GAIN_M = 6
/** EMA smoothing for grade (per ~1Hz sample). */
const GRADE_ALPHA = 0.25

export interface GradeState {
  /** Smoothed grade as a fraction (0.03 = 3%). 0 until data arrives. */
  grade: number
  climbing: boolean
  /** True on exactly the sample where a qualifying climb tops out. */
  crest: boolean
}

export class GradeTracker {
  private lastDist: number | null = null
  private lastAlt: number | null = null
  private grade = 0
  private climbing = false
  private climbGainM = 0

  update(distanceM: number | null | undefined, altitudeM: number | null | undefined): GradeState {
    let crest = false
    if (distanceM != null && altitudeM != null) {
      if (this.lastDist != null && this.lastAlt != null) {
        const dD = distanceM - this.lastDist
        if (dD >= 1) {
          const inst = (altitudeM - this.lastAlt) / dD
          this.grade = this.grade * (1 - GRADE_ALPHA) + inst * GRADE_ALPHA
          if (this.climbing) {
            this.climbGainM += Math.max(0, altitudeM - this.lastAlt)
            if (this.grade <= CREST_GRADE) {
              // Topped out — celebrate only real hills.
              crest = this.climbGainM >= MIN_CLIMB_GAIN_M
              this.climbing = false
              this.climbGainM = 0
            }
          } else if (this.grade >= CLIMB_GRADE) {
            this.climbing = true
            this.climbGainM = 0
          }
          this.lastDist = distanceM
          this.lastAlt = altitudeM
        }
      } else {
        this.lastDist = distanceM
        this.lastAlt = altitudeM
      }
    }
    return { grade: this.grade, climbing: this.climbing, crest }
  }
}

export interface HrState {
  /** Smoothed HR in bpm; null until data arrives. */
  hr: number | null
  /** 1–5 classic zones by % of max; 0 when no data. */
  zone: number
}

const HR_ALPHA = 0.3
export const DEFAULT_HR_MAX = 190

export class HrTracker {
  private smoothed: number | null = null
  constructor(private readonly hrMax: number = DEFAULT_HR_MAX) {}

  update(hr: number | null | undefined): HrState {
    if (hr != null && hr > 0) {
      this.smoothed = this.smoothed == null ? hr : this.smoothed * (1 - HR_ALPHA) + hr * HR_ALPHA
    }
    if (this.smoothed == null) return { hr: null, zone: 0 }
    const pct = this.smoothed / this.hrMax
    const zone = pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5
    return { hr: this.smoothed, zone }
  }
}
