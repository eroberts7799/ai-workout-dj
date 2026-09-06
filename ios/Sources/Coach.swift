// CoachEngine — Swift port of src/live/coach.ts (parity law, 2026-09-06).
// The intent channel beside the music: a voice that reads the same
// anticipation clock the DJ does. Deterministic templates, a strict cue
// budget, and the one rule above all: the voice never lands on a drop.
import Foundation

struct CoachCue {
  let tMs: Double
  let kind: String
  let text: String
}

/// Lines written for THIS session by the morning job. Mirrors TS CoachScript.
struct CoachScript: Decodable {
  var opening: String? = nil
  var pre30: [String]? = nil
  var repEnd: [String]? = nil
  var halfway: [String]? = nil
  var final: String? = nil
  var hrHigh: String? = nil
  var crest: String? = nil
}

struct CoachView {
  struct Step { let kind: String; let idx: Int; let remainingMs: Double?; let targetPaceSecPerKm: Double? }
  struct NextHard { let meters: Double?; let seconds: Double?; let targetPaceSecPerKm: Double? }
  let tMs: Double
  let distanceM: Double?
  let hr: Double?
  let paceSecPerKm: Double
  let etaToHardMs: Double?
  let hrZone: Int
  let step: Step?
  let hardDone: Int
  let hardTotal: Int?
  let nextHard: NextHard?
  let entered: String?
  let crest: Bool
  let route: RouteLock?
  let terrainAhead: LiveEngine.TerrainAhead?
  let pAhead1k: Double
}

func spokenPace(_ secPerKm: Double) -> String {
  let m = Int(secPerKm / 60)
  let s = Int((secPerKm - Double(m) * 60).rounded())
  return "\(m):\(s < 10 ? "0" : "")\(s)"
}

private func fill(_ text: String, _ vars: [String: String]) -> String {
  var out = text
  for (k, v) in vars { out = out.replacingOccurrences(of: "{\(k)}", with: v) }
  return out
}

final class CoachEngine {
  private static let minGapMs = 8_000.0
  private static let quietBeforeMs = 6_000.0
  private static let quietAfterMs = 3_000.0
  private static let hrHighZone = 4
  private static let hrHighHoldSamples = 30
  private static let hrHighCooldownMs = 300_000.0

  private(set) var cues: [CoachCue] = []
  private let script: CoachScript
  private var lastCueT = -Double.infinity
  private var lastLandingT = -Double.infinity
  private var startT: Double?
  private var openingSaid = false
  private var pre30Rep = -1
  private var pre10Rep = -1
  private var halfwayRep = -1
  private var driftRep = -1
  private var repEntryT: Double?
  private var repEntryDist: Double?
  private var inHard = false
  private var awaitingRecovery = false
  private var hrHighRun = 0
  private var lastHrHighT = -Double.infinity
  private var lastCrestT = -Double.infinity
  private var lastTerrainKey: String?
  private var routeSaid = false
  private var finalSaid = false
  private var lastTarget: Double?

  init(script: CoachScript? = nil) {
    self.script = script ?? CoachScript()
  }

  @discardableResult
  private func say(_ t: Double, _ kind: String, _ text: String) -> CoachCue {
    let cue = CoachCue(tMs: t, kind: kind, text: text)
    cues.append(cue)
    lastCueT = t
    return cue
  }

  private func canSpeak(_ t: Double, _ v: CoachView) -> Bool {
    if t - lastCueT < Self.minGapMs { return false }
    if let eta = v.etaToHardMs, eta > 0, eta <= Self.quietBeforeMs { return false }
    if t - lastLandingT < Self.quietAfterMs { return false }
    return true
  }

  @discardableResult
  func advance(_ v: CoachView) -> [CoachCue] {
    let before = cues.count
    let t = v.tMs
    if startT == nil { startT = t }
    let stepKind = v.step?.kind
    let talkative = v.hardTotal == nil || v.hardTotal! > 0

    if v.entered == "hard" {
      lastLandingT = t
      inHard = true
      repEntryT = t
      repEntryDist = v.distanceM
    }
    if let e = v.entered, e != "hard", inHard {
      inHard = false
      let n = v.hardDone
      let elapsed = repEntryT.map { (t - $0) / 1000 }
      let dist: Double? = (repEntryDist != nil && v.distanceM != nil) ? v.distanceM! - repEntryDist! : nil
      let pace: Double? = (elapsed != nil && dist != nil && dist! > 50) ? (elapsed! / dist!) * 1000 : nil
      var delta = ""
      if let pace, let target = lastTarget {
        let d = Int((pace - target).rounded())
        delta = d <= -3 ? "\(-d) seconds under target." : d >= 3 ? "\(d) seconds over." : "Right on target."
      }
      let vars: [String: String] = [
        "n": String(n), "total": v.hardTotal.map(String.init) ?? "",
        "pace": pace.map(spokenPace) ?? "", "target": lastTarget.map(spokenPace) ?? "", "delta": delta,
        "hr": v.hr.map { String(Int($0.rounded())) } ?? "",
      ]
      let line = (script.repEnd?.count ?? 0) >= n && n >= 1 ? script.repEnd![n - 1] : nil
      let text = line.map { fill($0, vars) }
        ?? "Done. \(v.hardTotal != nil ? "\(n) of \(v.hardTotal!)." : "Rep \(n).")\(pace != nil ? " \(spokenPace(pace!)) pace." : "")\(delta.isEmpty ? "" : " \(delta)")"
      if t - lastLandingT >= Self.quietAfterMs { say(t, "repEnd", text) }
      awaitingRecovery = v.hr != nil
    }
    if let st = v.step, st.kind == "hard", let tp = st.targetPaceSecPerKm { lastTarget = tp }

    if !openingSaid, let opening = script.opening, t - startT! >= 12_000, canSpeak(t, v) {
      openingSaid = true
      say(t, "opening", opening)
    }

    if talkative {
      let eta = v.etaToHardMs
      let rep = v.hardDone
      if let eta, eta >= 24_000, eta <= 36_000, pre30Rep != rep, canSpeak(t, v) {
        pre30Rep = rep
        let nh = v.nextHard
        let what: String = {
          if let m = nh?.meters, m > 0 { return "\(Int(m.rounded())) meters" }
          if let s = nh?.seconds, s > 0 { return "\(Int(s.rounded())) seconds" }
          return "Effort"
        }()
        let target = nh?.targetPaceSecPerKm
        let vars: [String: String] = ["n": String(rep + 1), "total": v.hardTotal.map(String.init) ?? "", "target": target.map(spokenPace) ?? "", "what": what]
        let line = (script.pre30?.count ?? 0) > rep ? script.pre30![rep] : nil
        say(t, "pre30", line.map { fill($0, vars) }
          ?? "\(what) in 30 seconds.\(target != nil ? " Target \(spokenPace(target!))." : "") Settle your breathing.")
      }
      if let eta, eta >= 7_000, eta <= 12_000, pre10Rep != rep, t - lastCueT >= 10_000 {
        pre10Rep = rep
        say(t, "pre10", "Ten seconds. Tall and relaxed.")
      }
      if inHard, let entryT = repEntryT, let st = v.step, let remaining = st.remainingMs {
        let elapsed = t - entryT
        let repIdx = v.hardDone
        if elapsed >= 30_000, remaining <= elapsed, halfwayRep != repIdx, canSpeak(t, v) {
          halfwayRep = repIdx
          let vars: [String: String] = ["hr": v.hr.map { String(Int($0.rounded())) } ?? "", "n": String(repIdx + 1)]
          let line = (script.halfway?.count ?? 0) > repIdx ? script.halfway![repIdx] : nil
          say(t, "halfway", line.map { fill($0, vars) }
            ?? "Halfway.\(v.hr != nil ? " Heart rate \(Int(v.hr!.rounded()))." : "") Hold it.")
        }
        if let target = st.targetPaceSecPerKm, elapsed >= 20_000, driftRep != repIdx, canSpeak(t, v) {
          let d = v.paceSecPerKm - target
          if d > target * 0.05 { driftRep = repIdx; say(t, "drift", "\(Int(d.rounded())) seconds slow. Pick it up.") }
          else if d < -target * 0.07 { driftRep = repIdx; say(t, "drift", "Too fast. Ease off five seconds.") }
        }
      }
      if awaitingRecovery, !inHard, v.hrZone <= 2, let hr = v.hr, canSpeak(t, v) {
        awaitingRecovery = false
        say(t, "recovered", "Recovered. Heart rate \(Int(hr.rounded())).")
      }
    }

    if stepKind != "hard", let hr = v.hr, v.hrZone >= Self.hrHighZone, hr > 0 { hrHighRun += 1 } else { hrHighRun = 0 }
    if hrHighRun >= Self.hrHighHoldSamples, t - lastHrHighT >= Self.hrHighCooldownMs, canSpeak(t, v), let hr = v.hr {
      lastHrHighT = t
      hrHighRun = 0
      let vars = ["hr": String(Int(hr.rounded()))]
      say(t, "hrHigh", script.hrHigh.map { fill($0, vars) }
        ?? "Heart rate \(Int(hr.rounded()))\(talkative ? "" : " on an easy day"). Back it off.")
    }

    if let ta = v.terrainAhead, ta.confidence >= 0.5 {
      let mps = 1000 / max(120, v.paceSecPerKm)
      let key = "\(ta.type.rawValue)@\(Int((((v.distanceM ?? 0) + (ta.etaMs / 1000) * mps) / 50).rounded()) * 50)"
      if ta.type == .crest, ta.etaMs >= 18_000, ta.etaMs <= 26_000, lastTerrainKey != key, canSpeak(t, v) {
        lastTerrainKey = key
        lastCrestT = t
        say(t, "crestAhead", script.crest ?? "Crest in about twenty seconds. Drive to the top.")
      } else if ta.type == .climbStart, ta.etaMs >= 12_000, ta.etaMs <= 20_000, lastTerrainKey != key, canSpeak(t, v) {
        lastTerrainKey = key
        say(t, "climbAhead", "Climb coming. Short steps, easy arms.")
      }
    }
    if v.crest, t - lastCrestT > 40_000, (v.etaToHardMs == nil || v.etaToHardMs! > 45_000), canSpeak(t, v) {
      lastCrestT = t
      say(t, "crest", "Top of the hill.")
    }

    if let r = v.route, r.routeId != "self" {
      if !routeSaid, v.pAhead1k >= 0.7, canSpeak(t, v) {
        routeSaid = true
        let km = String(format: "%.1f", (r.progressM + r.remainingM) / 1000)
        let left = String(format: "%.1f", r.remainingM / 1000)
        say(t, "route", "On your \(km) k route. \(left) k to go.")
      }
      if !finalSaid, r.remainingM <= 1000, r.remainingM > 200, v.pAhead1k >= 0.7, canSpeak(t, v) {
        finalSaid = true
        say(t, "final", script.final ?? "Final kilometer.")
      }
    }
    return Array(cues[before...])
  }
}
