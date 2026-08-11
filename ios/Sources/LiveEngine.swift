// LiveEngine — Swift port of src/live/live-engine.ts (the single source of
// choreography truth stays the TypeScript engine + its tests; this port
// mirrors it decision-for-decision so the phone can conduct with no Mac).
//
// Feed it the watch's live stream (time + accumulated distance); it tracks
// where you are in the plan (distance steps measured by real meters), keeps
// a rolling pace, predicts the ETA to the next hard-step start, holds the
// groove loop, exits into the buildup at the last loop boundary where it
// still fits, and lands the drop when you ARRIVE.
import Foundation

struct LiveSample {
  let tMs: Double
  let distanceM: Double?
}

struct LivePlayCommand {
  let tMs: Double
  let trackId: String
  let uri: String
  let positionMs: Double
  let fadeSec: Double
  let reason: String
}

struct LandingReport {
  let targetTMs: Double
  let actualTMs: Double
  let errorMs: Double
}

let defaultPaceSecPerKm: Double = 360 // mirrors conductor.ts DEFAULT_PACE_SEC_PER_KM

final class LiveEngine {
  private struct DropChoice {
    let song: TaggedSong
    let dropMs: Double
    let entryMs: Double
  }

  private struct LoopChoice {
    let song: TaggedSong
    let startMs: Double
    let endMs: Double
  }

  enum Mode: String { case fill, build, ride }

  private static let defaultLeadMs: Double = 30_000
  /// EMA smoothing for pace (per sample at ~1Hz).
  private static let paceAlpha = 0.15

  private let steps: [WorkoutStep]
  private var droppable: [DropChoice] = []
  private var loopable: [LoopChoice] = []
  private var dropIdx = 0
  private var loopIdx = 0

  private var stepIdx = 0
  private var stepStartT: Double = 0
  private var stepStartDist: Double = 0
  private var lastT: Double?
  private var lastDist: Double?
  private var paceSecPerKm: Double

  private var mode: Mode?
  private var playing: (song: TaggedSong, positionAtMs: Double, atTMs: Double)?
  private var loopBounds: (startMs: Double, endMs: Double)?
  private var buildTargetT: Double?

  private(set) var commands: [LivePlayCommand] = []
  private(set) var landings: [LandingReport] = []
  private(set) var warnings: [String] = []

  init(plan: [WorkoutStep], songs: [TaggedSong], paceSecPerKm: Double = defaultPaceSecPerKm) {
    steps = plan
    self.paceSecPerKm = paceSecPerKm
    for song in songs {
      for d in song.markers.filter({ $0.type == "drop" }) {
        let buildups = song.markers
          .filter { $0.type == "buildup" && $0.ms < d.ms }
          .sorted { $0.ms > $1.ms }
        let entryMs = buildups.first?.ms ?? max(0, d.ms - Self.defaultLeadMs)
        if entryMs < d.ms { droppable.append(DropChoice(song: song, dropMs: d.ms, entryMs: entryMs)) }
      }
      let starts = song.markers.filter { $0.type == "loop_start" }.sorted { $0.ms < $1.ms }
      for s in starts {
        if let end = song.markers.first(where: { $0.type == "loop_end" && $0.ms > s.ms }) {
          loopable.append(LoopChoice(song: song, startMs: s.ms, endMs: end.ms))
          break
        }
      }
    }
    if droppable.isEmpty { warnings.append("no drop-tagged songs") }
    if loopable.isEmpty { warnings.append("no loop-tagged songs") }
  }

  /// Read-only snapshot of the engine's mind — for the UI.
  var state: (stepIdx: Int, mode: Mode?, paceSecPerKm: Double, playingTrackId: String?, etaToHardMs: Double?) {
    (
      stepIdx: stepIdx,
      mode: mode,
      paceSecPerKm: paceSecPerKm,
      playingTrackId: playing?.song.trackId,
      etaToHardMs: lastT.flatMap { etaToNextHardMs(t: $0, dist: lastDist) }
    )
  }

  /// Current playhead position in the active track at time t.
  private func playheadMs(_ t: Double) -> Double {
    guard let p = playing else { return 0 }
    return p.positionAtMs + (t - p.atTMs)
  }

  private func emit(t: Double, song: TaggedSong, positionMs: Double, fadeSec: Double, reason: String) {
    commands.append(LivePlayCommand(tMs: t, trackId: song.trackId, uri: song.uri, positionMs: positionMs, fadeSec: fadeSec, reason: reason))
    playing = (song: song, positionAtMs: positionMs, atTMs: t)
  }

  private func currentStep() -> WorkoutStep? {
    stepIdx < steps.count ? steps[stepIdx] : nil
  }

  /// Progress current step; advance through completed steps. Returns steps entered.
  private func trackSteps(t: Double, dist: Double?) -> [WorkoutStep] {
    var entered: [WorkoutStep] = []
    while true {
      guard let step = currentStep() else { break }
      let done: Bool
      if let seconds = step.seconds {
        done = t - stepStartT >= seconds * 1000
      } else if let dist, let meters = step.meters {
        done = dist - stepStartDist >= meters
      } else {
        done = false
      }
      if !done { break }
      stepIdx += 1
      stepStartT = step.seconds != nil ? stepStartT + step.seconds! * 1000 : t
      stepStartDist = dist ?? stepStartDist
      if let next = currentStep() { entered.append(next) }
    }
    return entered
  }

  /// ms until the next hard step STARTS (nil if none ahead or currently in one).
  private func etaToNextHardMs(t: Double, dist: Double?) -> Double? {
    guard let cur = currentStep() else { return nil }
    if cur.kind == "hard" { return nil }
    var eta = remainingMs(step: cur, t: t, dist: dist)
    for i in (stepIdx + 1)..<steps.count {
      let s = steps[i]
      if s.kind == "hard" { return eta }
      eta += s.seconds != nil ? s.seconds! * 1000 : ((s.meters ?? 0) / 1000) * paceSecPerKm * 1000
    }
    return nil
  }

  private func remainingMs(step: WorkoutStep, t: Double, dist: Double?) -> Double {
    if let seconds = step.seconds { return max(0, stepStartT + seconds * 1000 - t) }
    if let meters = step.meters, let dist {
      let remainingM = max(0, meters - (dist - stepStartDist))
      return (remainingM / 1000) * paceSecPerKm * 1000
    }
    return 0
  }

  private func pickDrop() -> DropChoice? {
    guard !droppable.isEmpty else { return nil }
    for i in 0..<droppable.count {
      let c = droppable[(dropIdx + i) % droppable.count]
      if c.song.trackId != playing?.song.trackId {
        dropIdx += i + 1
        return c
      }
    }
    let c = droppable[dropIdx % droppable.count]
    dropIdx += 1
    return c
  }

  private func pickLoop() -> LoopChoice? {
    guard !loopable.isEmpty else { return nil }
    for i in 0..<loopable.count {
      let c = loopable[(loopIdx + i) % loopable.count]
      if c.song.trackId != playing?.song.trackId {
        loopIdx += i + 1
        return c
      }
    }
    let c = loopable[loopIdx % loopable.count]
    loopIdx += 1
    return c
  }

  private func startFill(_ t: Double) {
    guard let fill = pickLoop() else { return }
    mode = .fill
    loopBounds = (startMs: fill.startMs, endMs: fill.endMs)
    emit(t: t, song: fill.song, positionMs: fill.startMs, fadeSec: 1.2, reason: "groove fill (\(fill.song.name))")
  }

  /// Advance the engine with a fresh sample; returns commands issued this tick.
  @discardableResult
  func advance(_ sample: LiveSample) -> [LivePlayCommand] {
    let before = commands.count
    let t = sample.tMs
    let dist = sample.distanceM

    // Rolling pace from real movement.
    if let lt = lastT, let ld = lastDist, let dist, t > lt {
      let dD = dist - ld
      let dT = (t - lt) / 1000
      if dD > 0.5 {
        let instPace = (dT / dD) * 1000 // sec per km
        paceSecPerKm = paceSecPerKm * (1 - Self.paceAlpha) + instPace * Self.paceAlpha
      }
    }
    lastT = t
    lastDist = dist

    let entered = trackSteps(t: t, dist: dist)

    // Actual hard-step arrival: score the landing, ensure we're riding a drop.
    for step in entered {
      if step.kind == "hard" {
        if mode == .build, let target = buildTargetT {
          landings.append(LandingReport(targetTMs: target, actualTMs: t, errorMs: t - target))
        } else {
          // ETA collapsed before any commit — cut straight to a drop, truncated.
          if let pick = pickDrop() {
            emit(t: t, song: pick.song, positionMs: pick.dropMs, fadeSec: 0.3, reason: "drop lands (truncated) (\(pick.song.name))")
            landings.append(LandingReport(targetTMs: t, actualTMs: t, errorMs: 0))
          }
        }
        mode = .ride
        buildTargetT = nil
      } else if mode == .ride {
        // Hard step over — back to groove.
        startFill(t)
      }
    }

    if mode == nil { startFill(t) }

    // Fill-mode loop management + commit decision at loop boundaries.
    if mode == .fill, let p = playing, let bounds = loopBounds {
      let pos = playheadMs(t)
      if pos >= bounds.endMs {
        let eta = etaToNextHardMs(t: t, dist: dist)
        let loopLen = bounds.endMs - bounds.startMs
        let pick = eta != nil ? pickDrop() : nil
        if let eta, let pick {
          let buildLen = pick.dropMs - pick.entryMs
          if eta <= buildLen + loopLen {
            // Last viable boundary: enter so the drop lands exactly at ETA.
            let positionMs = max(0, pick.dropMs - eta)
            emit(t: t, song: pick.song, positionMs: positionMs, fadeSec: 0.45, reason: "buildup toward the effort (\(pick.song.name))")
            mode = .build
            buildTargetT = t + eta
            return Array(commands[before...])
          }
        }
        emit(t: t, song: p.song, positionMs: bounds.startMs, fadeSec: 0.25, reason: "loop back (\(p.song.name))")
      }
    }

    // Never-silence: chain a fresh groove if the current track would end.
    if let p = playing, mode != .build {
      let pos = playheadMs(t)
      if pos >= p.song.durationMs - 1500, mode != .ride {
        startFill(t)
      } else if pos >= p.song.durationMs - 1500, mode == .ride {
        startFill(t)
        mode = .ride
      }
    }

    return Array(commands[before...])
  }
}
