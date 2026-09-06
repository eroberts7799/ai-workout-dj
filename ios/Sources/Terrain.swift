// Terrain — Swift port of src/live/terrain.ts (parity law, 2026-09-06).
// Pure functions: an elevation profile in, terrain cues and arrival
// predictions out. Reuses GradeTracker so pre-run cues and the live
// reactive crest rules agree by construction.
import Foundation

struct ProfilePoint {
  let distanceM: Double
  let altitudeM: Double
}

struct TerrainCue {
  enum Kind: String { case climbStart, crest }
  let type: Kind
  /// Where the cue is AIMED — for a crest, the SUMMIT (max altitude of the
  /// climb), not the smoothed-grade decay point. Mirrors TS.
  let distanceM: Double
  /// Where the live reactive GradeTracker would fire (crest only).
  let detectDistanceM: Double?
  let gainM: Double
  /// 0..1 from climb size only (a 60m+ climb saturates). GUESS. Mirrors TS.
  let confidence: Double
}

enum Terrain {
  /// Distance-windowed median smoothing (±50m). Mirrors TS smoothProfile.
  static func smoothProfile(_ profile: [ProfilePoint], windowM: Double = 50) -> [ProfilePoint] {
    var out: [ProfilePoint] = []
    out.reserveCapacity(profile.count)
    var lo = 0
    var hi = 0
    for i in 0..<profile.count {
      let d = profile[i].distanceM
      while profile[lo].distanceM < d - windowM { lo += 1 }
      while hi < profile.count - 1 && profile[hi + 1].distanceM <= d + windowM { hi += 1 }
      let win = profile[lo...hi].map { $0.altitudeM }.sorted()
      out.append(ProfilePoint(distanceM: d, altitudeM: win[win.count / 2]))
    }
    return out
  }

  /// Walk the smoothed profile through the SAME GradeTracker the live rules
  /// use; emit cues at climb starts and crests. Mirrors TS extractTerrainCues.
  static func extractTerrainCues(_ profile: [ProfilePoint]) -> [TerrainCue] {
    let sm = smoothProfile(profile)
    let tracker = GradeTracker()
    var cues: [TerrainCue] = []
    var wasClimbing = false
    var climbStartAlt = 0.0
    var maxAlt = -Double.infinity
    var maxAltDist = 0.0
    for p in sm {
      let st = tracker.update(distanceM: p.distanceM, altitudeM: p.altitudeM)
      if st.climbing && !wasClimbing {
        climbStartAlt = p.altitudeM
        maxAlt = p.altitudeM
        maxAltDist = p.distanceM
        cues.append(TerrainCue(type: .climbStart, distanceM: p.distanceM, detectDistanceM: nil, gainM: 0, confidence: 0.5))
      }
      if st.climbing && p.altitudeM > maxAlt {
        maxAlt = p.altitudeM
        maxAltDist = p.distanceM
      }
      if st.crest {
        let gain = maxAlt - climbStartAlt
        cues.append(TerrainCue(type: .crest, distanceM: maxAltDist, detectDistanceM: p.distanceM, gainM: gain, confidence: min(1, gain / 60)))
      }
      wasClimbing = st.climbing
    }
    return cues
  }

  /// Grade-adjusted pace multiplier — literature prior (uphill ~6% pace per
  /// 1% grade; downhill floors at 0.9). GUESS per rule 8. Mirrors TS.
  static func gapMultiplier(_ grade: Double) -> Double {
    if grade > 0 { return 1 + 6.0 * grade }
    return max(0.9, 1 + 1.5 * grade)
  }

  /// Pre-run arrival prediction over the profile at the athlete's flat pace,
  /// grade-adjusted per segment. Mirrors TS predictArrivalMs.
  static func predictArrivalMs(_ profile: [ProfilePoint], targetDistanceM: Double, flatSecPerKm: Double) -> Double {
    let sm = smoothProfile(profile)
    var t = 0.0
    guard sm.count > 1 else { return 0 }
    for i in 1..<sm.count {
      let dd = sm[i].distanceM - sm[i - 1].distanceM
      if dd <= 0 { continue }
      let end = min(sm[i].distanceM, targetDistanceM)
      let seg = end - sm[i - 1].distanceM
      if seg <= 0 { break }
      let grade = (sm[i].altitudeM - sm[i - 1].altitudeM) / dd
      t += (seg / 1000) * flatSecPerKm * gapMultiplier(grade) * 1000
      if sm[i].distanceM >= targetDistanceM { break }
    }
    return t
  }
}
