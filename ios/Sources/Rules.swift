// Body-signal rule modules — Swift port of src/live/rules.ts, decision for
// decision. GradeTracker: live grade from the altitude stream, climb
// detection, and the CREST — you grind up a hill and the moment hits as you
// top out. HrTracker: smoothed HR + five zones gated on the calibrated max.

import Foundation

struct GradeState {
  var grade: Double = 0
  var climbing: Bool = false
  var crest: Bool = false
}

final class GradeTracker {
  /// Grade below which a climb counts as topped out.
  private static let crestGrade = 0.005
  /// Grade at which sustained ascent counts as climbing.
  private static let climbGrade = 0.025
  /// Minimum vertical gain before a crest is worth celebrating.
  /// Data-tuned 2026-08-13 over 562 real runs (185 trail) — mirrors TS.
  private static let minClimbGainM = 30.0
  /// EMA smoothing for grade (per ~1Hz sample).
  private static let gradeAlpha = 0.25

  private var lastDist: Double?
  private var lastAlt: Double?
  private var grade = 0.0
  private var climbing = false
  private var climbGainM = 0.0

  func update(distanceM: Double?, altitudeM: Double?) -> GradeState {
    var crest = false
    if let distanceM, let altitudeM {
      if let ld = lastDist, let la = lastAlt {
        let dD = distanceM - ld
        if dD >= 1 {
          let inst = (altitudeM - la) / dD
          grade = grade * (1 - Self.gradeAlpha) + inst * Self.gradeAlpha
          if climbing {
            climbGainM += max(0, altitudeM - la)
            if grade <= Self.crestGrade {
              // Topped out — celebrate only real hills.
              crest = climbGainM >= Self.minClimbGainM
              climbing = false
              climbGainM = 0
            }
          } else if grade >= Self.climbGrade {
            climbing = true
            climbGainM = 0
          }
          lastDist = distanceM
          lastAlt = altitudeM
        }
      } else {
        lastDist = distanceM
        lastAlt = altitudeM
      }
    }
    return GradeState(grade: grade, climbing: climbing, crest: crest)
  }
}

struct HrState {
  var hr: Double? = nil
  var zone: Int = 0
}

final class HrTracker {
  private static let hrAlpha = 0.3
  static let defaultHrMax = 190.0

  private let hrMax: Double
  private var smoothed: Double?

  init(hrMax: Double? = nil) {
    self.hrMax = hrMax ?? Self.defaultHrMax
  }

  func update(hr: Double?) -> HrState {
    if let hr, hr > 0 {
      smoothed = smoothed == nil ? hr : smoothed! * (1 - Self.hrAlpha) + hr * Self.hrAlpha
    }
    guard let s = smoothed else { return HrState(hr: nil, zone: 0) }
    let pct = s / hrMax
    let zone = pct < 0.6 ? 1 : pct < 0.7 ? 2 : pct < 0.8 ? 3 : pct < 0.9 ? 4 : 5
    return HrState(hr: s, zone: zone)
  }
}
