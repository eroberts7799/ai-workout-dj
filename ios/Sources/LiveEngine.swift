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
  /// Body signals (watch relay OR phone sensors): barometric/GPS altitude
  /// for the crest rules, HR for effort gating.
  var altitudeM: Double? = nil
  var hr: Double? = nil
  /// Watch workout-step sequence counter — increments exactly when the watch
  /// advances to the next plan step. When present, step boundaries come from
  /// HERE (drift-free); our own tracking powers anticipation only. Mirrors
  /// the TS engine's trigger-doctrine split (2026-08-16).
  var wkStepSeq: Double? = nil
  /// Streamed shape of the CURRENT step + kind of the NEXT — follow mode
  /// conducts with no plan loaded at all. Mirrors TS.
  var wkKind: String? = nil
  var wkDurationType: Double? = nil
  var wkDurationValue: Double? = nil
  var wkNextKind: String? = nil
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
  /// Corpus-learned freshness (65 real DJ sets, median ride ~190s):
  /// past this, a fill trades its loop for a fresh groove. Mirrors TS.
  private static let maxFillRideMs: Double = 180_000
  /// Energy-aware chain window bracketing the ~190s corpus median: never
  /// change before MIN, force by CAP; between them leave where a strong
  /// section (chorus/inst/solo) just ended. Mirrors TS.
  private static let minFillRideMs: Double = 120_000
  private static let fillRideCapMs: Double = 240_000
  private static let highEnergyLabels: Set<String> = ["chorus", "inst", "solo"]
  /// Skip the rep-end release when the next buildup would cut in before this
  /// much listening — one song change per rep, not two. Mirrors TS.
  private static let releaseMinListenMs: Double = 60_000
  /// Crest rewards stay clear of an imminent hard step — its moment owns it.
  private static let crestMinEtaMs: Double = 45_000
  /// How long a crest-reward song rides before returning to the groove.
  private static let crestRideMs: Double = 25_000
  /// Fresh-mode rep changes: crossfade starts this far before the boundary
  /// so the incoming song peaks as the effort begins. Mirrors TS.
  private static let freshChangeLeadMs: Double = 4_000

  /// 'fresh' (default): rep starts = NEW song from 0:00 crossfaded onto the
  /// boundary. 'anticipated': the parked buildup/drop machinery. Mirrors TS.
  enum DropStyle { case fresh, anticipated }

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
  /// Last watch step-sequence value; once seen, the watch owns boundaries.
  private var wkSeq: Double?

  private var mode: Mode?
  private var playing: (song: TaggedSong, positionAtMs: Double, atTMs: Double)?
  /// Track position (ms) where this cruise should chain to the next song.
  private var fillExitPosMs: Double?
  private var buildTargetT: Double?
  private var buildDropMs: Double?
  private var lastReaimT: Double = -.infinity

  private(set) var commands: [LivePlayCommand] = []
  private(set) var landings: [LandingReport] = []
  private(set) var warnings: [String] = []

  /// Learned pairing weights ("<norm from>><norm to>" → count) — mined from
  /// real DJ sets; arrives via the session bundle. Mirrors TS.
  private let pairBonus: [String: Double]
  private var normKey: [String: String] = [:]

  private let dropStyle: DropStyle
  /// FOLLOW MODE (empty plan): conduct straight from the watch's stream —
  /// the workout lives in Runna/Garmin, nobody retypes it. Mirrors TS.
  private let followMode: Bool
  private var followStep: WorkoutStep?
  private var followNextKind: String?

  // Body-signal rules (crest rewards, effort gating) — mirrors TS.
  private let gradeTracker = GradeTracker()
  private let hrTracker: HrTracker
  private var gradeState = GradeState()
  private var hrState = HrState()
  private var crestRideUntil: Double?

  init(plan: [WorkoutStep], songs: [TaggedSong], paceSecPerKm: Double = defaultPaceSecPerKm, pairBonus: [String: Double] = [:], dropStyle: DropStyle = .fresh, hrMax: Double? = nil) {
    self.dropStyle = dropStyle
    self.followMode = plan.isEmpty
    self.hrTracker = HrTracker(hrMax: hrMax)
    steps = plan
    self.paceSecPerKm = paceSecPerKm
    self.pairBonus = pairBonus
    for song in songs {
      // ASCII [a-z0-9] words only — must match the miner's and TS's regex
      // exactly (CharacterSet.alphanumerics would keep accents and diverge).
      let lower = "\(song.artists) \(song.name)".lowercased()
      var words: [String] = []
      var cur = ""
      for ch in lower.unicodeScalars {
        if (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") {
          cur.unicodeScalars.append(ch)
        } else if !cur.isEmpty {
          words.append(cur)
          cur = ""
        }
      }
      if !cur.isEmpty { words.append(cur) }
      normKey[song.trackId] = words.joined(separator: " ")
    }
    for song in songs {
      for d in song.markers.filter({ $0.type == "drop" }) {
        let buildups = song.markers
          .filter { $0.type == "buildup" && $0.ms < d.ms }
          .sorted { $0.ms > $1.ms }
        let entryMs = buildups.first?.ms ?? max(0, d.ms - Self.defaultLeadMs)
        if entryMs < d.ms { droppable.append(DropChoice(song: song, dropMs: d.ms, entryMs: entryMs)) }
      }
      // Cruise plays from 0:00 — EVERY song is cruise-capable. Mirrors TS.
      loopable.append(LoopChoice(song: song, startMs: 0, endMs: 0))
    }
    if dropStyle == .anticipated && droppable.isEmpty { warnings.append("no drop-tagged songs") }
    if loopable.isEmpty { warnings.append("no songs") }
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
    if followMode { return followStep }
    return stepIdx < steps.count ? steps[stepIdx] : nil
  }

  /// The current step as the watch streams it (follow mode). Mirrors TS.
  private func stepFromSample(_ s: LiveSample) -> WorkoutStep? {
    guard let raw = s.wkKind else { return nil }
    let kinds: Set<String> = ["warmup", "easy", "hard", "rest", "cooldown"]
    let kind = kinds.contains(raw) ? raw : "easy"
    if s.wkDurationType == 0, let v = s.wkDurationValue { return WorkoutStep(kind: kind, seconds: v, meters: nil) }
    if s.wkDurationType == 1, let v = s.wkDurationValue { return WorkoutStep(kind: kind, seconds: nil, meters: v) }
    return WorkoutStep(kind: kind, seconds: nil, meters: nil)
  }

  /// Where inside the last sample window did the current step's boundary
  /// fall? Time steps end at exact prescriptive arithmetic; distance steps
  /// at the interpolated crossing of the prescribed meters. Mirrors TS
  /// boundaryEstimate (2026-08-16).
  private func boundaryEstimate(step: WorkoutStep, prevT: Double?, prevDist: Double?, t: Double, dist: Double?) -> (bT: Double, bD: Double?) {
    if let seconds = step.seconds {
      let est = stepStartT + seconds * 1000
      if let prevT, est > prevT, est <= t {
        let bD: Double?
        if let prevDist, let dist, t > prevT {
          bD = prevDist + ((dist - prevDist) * (est - prevT)) / (t - prevT)
        } else {
          bD = dist
        }
        return (est, bD)
      }
    } else if let meters = step.meters, let dist {
      let cross = stepStartDist + meters
      if let prevT, let prevDist, dist > prevDist, cross > prevDist, cross <= dist {
        return (prevT + ((t - prevT) * (cross - prevDist)) / (dist - prevDist), cross)
      }
      if cross <= dist { return (t, cross) }
    }
    return (t, dist)
  }

  /// Progress current step; advance through completed steps. Returns steps entered.
  /// Watch-driven regime (wkStepSeq in the stream): a seq increment IS the
  /// boundary — drift-free truth for WHICH step; the model refines WHEN.
  /// Estimated regime: our own time/distance, with the prescribed-meters
  /// advance so sampling overshoot never compounds (34.8s field drift class).
  private func trackSteps(t: Double, dist: Double?, sample: LiveSample) -> [WorkoutStep] {
    let wkStepSeq = sample.wkStepSeq
    var entered: [WorkoutStep] = []
    let prevT = lastT
    let prevDist = lastDist

    if followMode {
      let streamed = stepFromSample(sample)
      followNextKind = sample.wkNextKind ?? followNextKind
      if let seq = wkStepSeq, wkSeq == nil {
        wkSeq = seq
        followStep = streamed
        stepStartT = t
        stepStartDist = dist ?? 0
        return entered
      }
      if let seq = wkStepSeq, let known = wkSeq, seq > known {
        let bT: Double
        let bD: Double?
        if let prev = followStep {
          (bT, bD) = boundaryEstimate(step: prev, prevT: prevT, prevDist: prevDist, t: t, dist: dist)
        } else {
          (bT, bD) = (t, dist)
        }
        wkSeq = seq
        stepIdx += 1
        stepStartT = bT
        stepStartDist = bD ?? stepStartDist
        followStep = streamed ?? followStep
        if let f = followStep { entered.append(f) }
        return entered
      }
      if let cur = followStep {
        var overdue = false
        if let seconds = cur.seconds {
          overdue = t - stepStartT - seconds * 1000 > max(12_000, seconds * 250)
        } else if let dist, let meters = cur.meters {
          overdue = dist - stepStartDist - meters > max(50, meters * 0.25)
        }
        if overdue {
          if let seconds = cur.seconds {
            stepStartT += seconds * 1000
          } else {
            stepStartDist += cur.meters ?? 0
            stepStartT = t
          }
          stepIdx += 1
          followStep = streamed ?? cur
          warnings.append("watch step stream stalled — advanced step \(stepIdx) by odometer")
          if let f = followStep { entered.append(f) }
        }
      }
      return entered
    }

    if let seq = wkStepSeq, wkSeq == nil { wkSeq = seq } // align: current seq ↔ current step
    if let known = wkSeq {
      if let seq = wkStepSeq, seq > known {
        var advanceBy = Int(seq - known)
        wkSeq = seq
        while advanceBy > 0, let step = currentStep() {
          advanceBy -= 1
          let (bT, bD) = boundaryEstimate(step: step, prevT: prevT, prevDist: prevDist, t: t, dist: dist)
          stepIdx += 1
          stepStartT = bT
          stepStartDist = bD ?? stepStartDist
          if let next = currentStep() { entered.append(next) }
        }
      }
      // Belt and braces: sig-based step detection PERMANENTLY misses a
      // boundary between identical adjacent steps. 25% / ≥12s past the
      // prescription (≫ the watch's real 1–3s seq lag) → advance by
      // odometer, backdating to the prescribed boundary. Mirrors TS.
      if let cur = currentStep() {
        var overdue = false
        if let seconds = cur.seconds {
          overdue = t - stepStartT - seconds * 1000 > max(12_000, seconds * 250)
        } else if let dist, let meters = cur.meters {
          overdue = dist - stepStartDist - meters > max(50, meters * 0.25)
        }
        if overdue {
          let bT: Double
          let bD: Double?
          if let seconds = cur.seconds {
            bT = stepStartT + seconds * 1000
            bD = dist.map { $0 - ((t - bT) / 1000) * (1000 / paceSecPerKm) }
          } else {
            let cross = stepStartDist + (cur.meters ?? 0)
            bD = cross
            bT = dist != nil ? t - ((dist! - cross) / 1000) * paceSecPerKm * 1000 : t
          }
          stepIdx += 1
          stepStartT = bT
          stepStartDist = bD ?? stepStartDist
          warnings.append("watch step stream stalled — advanced step \(stepIdx) by odometer")
          if let next = currentStep() { entered.append(next) }
        }
      }
      return entered
    }
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
      let (bT, bD) = boundaryEstimate(step: step, prevT: prevT, prevDist: prevDist, t: t, dist: dist)
      stepIdx += 1
      stepStartT = step.seconds != nil ? stepStartT + step.seconds! * 1000 : bT
      stepStartDist = step.meters != nil ? stepStartDist + step.meters! : (bD ?? stepStartDist)
      if let next = currentStep() { entered.append(next) }
    }
    return entered
  }

  /// ms until the next hard step STARTS — including the next rep while
  /// already in a hard step (every rep start is a drop moment). Nil when no
  /// hard step lies ahead.
  private func etaToNextHardMs(t: Double, dist: Double?) -> Double? {
    guard let cur = currentStep() else { return nil }
    if followMode {
      return followNextKind == "hard" ? remainingMs(step: cur, t: t, dist: dist) : nil
    }
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

  /// DJ-crate selection with variety pressure — mirrors pickBest in the TS
  /// engine: best mix score out of what's playing wins, recently-played
  /// candidates lose a point, same-track repeats stay the last resort.
  private func recentIds() -> Set<String> {
    Set(commands.suffix(6).map { $0.trackId }.filter { $0 != playing?.song.trackId })
  }

  /// Peek the best drop candidate WITHOUT consuming rotation — the ride-mode
  /// commit needs to inspect the candidate's buildup length before deciding.
  /// Learned edge for from→to, capped at +2 (mirrors TS: ground truth
  /// outweighs a heuristic point, never gross mismatch + freshness).
  private func learnedBonus(from: TaggedSong?, to: TaggedSong) -> Int {
    guard let from, let a = normKey[from.trackId], let b = normKey[to.trackId] else { return 0 }
    return Int(min(2, pairBonus["\(a)>\(b)"] ?? 0))
  }

  private func bestDrop() -> (c: DropChoice, advance: Int)? {
    guard !droppable.isEmpty else { return nil }
    let from = playing?.song
    let recent = recentIds()
    var best: (c: DropChoice, advance: Int, score: Int)?
    for i in 0..<droppable.count {
      let c = droppable[(dropIdx + i) % droppable.count]
      if c.song.trackId == playing?.song.trackId { continue }
      var score = from != nil ? BeatMath.mixScore(fromBpm: from!.bpm, fromKey: from!.camelot, toBpm: c.song.bpm, toKey: c.song.camelot) : 0
      score += learnedBonus(from: from, to: c.song)
      if recent.contains(c.song.trackId) { score -= 1 }
      if best == nil || score > best!.score { best = (c, i + 1, score) }
    }
    if let b = best { return (b.c, b.advance) }
    return (droppable[dropIdx % droppable.count], 1)
  }

  private func pickDrop() -> DropChoice? {
    guard let b = bestDrop() else { return nil }
    dropIdx += b.advance
    return b.c
  }

  private func pickLoop() -> LoopChoice? {
    guard !loopable.isEmpty else { return nil }
    let from = playing?.song
    let recent = recentIds()
    var best: (c: LoopChoice, advance: Int, score: Int)?
    for i in 0..<loopable.count {
      let c = loopable[(loopIdx + i) % loopable.count]
      if c.song.trackId == playing?.song.trackId { continue }
      var score = from != nil ? BeatMath.mixScore(fromBpm: from!.bpm, fromKey: from!.camelot, toBpm: c.song.bpm, toKey: c.song.camelot) : 0
      score += learnedBonus(from: from, to: c.song)
      if recent.contains(c.song.trackId) { score -= 1 }
      if best == nil || score > best!.score { best = (c, i + 1, score) }
    }
    if let b = best {
      loopIdx += b.advance
      return b.c
    }
    let c = loopable[loopIdx % loopable.count]
    loopIdx += 1
    return c
  }

  /// Where should this cruise END, in track time? Mirrors TS chainExitPosMs:
  /// first boundary in [entry+MIN, entry+CAP] where a strong section just
  /// finished; any in-window boundary beats the timer; no structure → timer.
  private func chainExitPosMs(song: TaggedSong, entryMs: Double) -> Double {
    if let segs = song.segments, !segs.isEmpty {
      let minExit = entryMs + Self.minFillRideMs
      let cap = entryMs + Self.fillRideCapMs
      var fallback: Double?
      for s in segs {
        if s.endMs < minExit || s.endMs > cap { continue }
        if Self.highEnergyLabels.contains(s.label) { return s.endMs }
        if fallback == nil { fallback = s.endMs }
      }
      if let f = fallback { return f }
    }
    return entryMs + Self.maxFillRideMs
  }

  /// Cruise: songs start at the BEGINNING and play through — Spotify-style
  /// listening. Mirrors TS.
  private func startFill(_ t: Double) {
    guard let fill = pickLoop() else { return }
    mode = .fill
    fillExitPosMs = chainExitPosMs(song: fill.song, entryMs: 0)
    emit(t: t, song: fill.song, positionMs: 0, fadeSec: 1.2, reason: "groove fill (\(fill.song.name))")
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
    // Body-signal trackers: grade/climb/crest from altitude, zones from HR.
    gradeState = gradeTracker.update(distanceM: dist, altitudeM: sample.altitudeM)
    hrState = hrTracker.update(hr: sample.hr)

    // trackSteps reads lastT/lastDist as the PREVIOUS sample (boundary
    // interpolation window) — update them only after.
    let entered = trackSteps(t: t, dist: dist, sample: sample)
    lastT = t
    lastDist = dist

    // Actual hard-step arrival: score the landing, ensure we're riding a drop.
    for step in entered {
      if step.kind == "hard" {
        if mode == .build, let target = buildTargetT {
          landings.append(LandingReport(targetTMs: target, actualTMs: t, errorMs: t - target))
        } else if dropStyle == .fresh {
          // ETA collapsed before the commit — change songs NOW, from the top.
          if let pick = pickLoop() {
            emit(t: t, song: pick.song, positionMs: 0, fadeSec: 0.3, reason: "rep change (truncated) (\(pick.song.name))")
            landings.append(LandingReport(targetTMs: t, actualTMs: t, errorMs: 0))
          }
        } else {
          // ETA collapsed before any commit — cut straight to a drop, truncated.
          if let pick = pickDrop() {
            emit(t: t, song: pick.song, positionMs: pick.dropMs, fadeSec: 0.3, reason: "drop lands (truncated) (\(pick.song.name))")
            landings.append(LandingReport(targetTMs: t, actualTMs: t, errorMs: 0))
          }
        }
        mode = .ride
        buildTargetT = nil
        buildDropMs = nil
        crestRideUntil = nil
      } else if mode == .ride {
        // Hard step over — back to the groove, unless the next effort's
        // change would cut in moments later: then ride this song through
        // the rest (one change per rep, not two). Mirrors TS.
        let eta = etaToNextHardMs(t: t, dist: dist)
        let lead = dropStyle == .fresh ? Self.freshChangeLeadMs : (bestDrop().map { $0.c.dropMs - $0.c.entryMs } ?? 0)
        if eta == nil || eta! > lead + Self.releaseMinListenMs { startFill(t) }
        crestRideUntil = nil
      }
    }

    // First sample: a plan that OPENS on a hard step opens on a drop —
    // mirrors TS (backtest: every progressive long run's first effort missed).
    if mode == nil {
      if currentStep()?.kind == "hard" {
        if dropStyle == .fresh, let pick = pickLoop() {
          emit(t: t, song: pick.song, positionMs: 0, fadeSec: 0.3, reason: "rep change (opening) (\(pick.song.name))")
          landings.append(LandingReport(targetTMs: t, actualTMs: t, errorMs: 0))
          mode = .ride
        } else if dropStyle == .anticipated, let pick = pickDrop() {
          emit(t: t, song: pick.song, positionMs: pick.dropMs, fadeSec: 0.3, reason: "drop lands (opening) (\(pick.song.name))")
          landings.append(LandingReport(targetTMs: t, actualTMs: t, errorMs: 0))
          mode = .ride
        } else {
          startFill(t)
        }
      } else {
        startFill(t)
      }
    }

    // Crest reward: a real hill just topped out — the moment hits NOW.
    // Only from the groove, only when no hard step is imminent, and only if
    // the body actually worked for it (zone ≥ 3 when HR data exists).
    if gradeState.crest, mode == .fill {
      let eta = etaToNextHardMs(t: t, dist: dist)
      let earned = hrState.hr == nil || hrState.zone >= 3
      if (eta == nil || eta! > Self.crestMinEtaMs), earned {
        if dropStyle == .fresh, let pick = pickLoop() {
          // Fresh mode: the crest song is a normal cruise entry — it rides to
          // its own chain point. The 25s time-box belongs to the anticipated
          // style; boxing a 0:00 entry amputated it mid-intro (trail run
          // 2026-08-22, all 6 crests → three songs in 90s per summit).
          emit(t: t, song: pick.song, positionMs: 0, fadeSec: 0.45, reason: "rep change (crest reward) (\(pick.song.name))")
          fillExitPosMs = chainExitPosMs(song: pick.song, entryMs: 0)
        } else if dropStyle == .anticipated, let pick = pickDrop() {
          emit(t: t, song: pick.song, positionMs: pick.dropMs, fadeSec: 0.45, reason: "drop lands (crest reward) (\(pick.song.name))")
          mode = .ride
          crestRideUntil = t + Self.crestRideMs
        }
      }
    }

    // Crest rides are time-boxed — drift back into the groove afterwards.
    if mode == .ride, let until = crestRideUntil, t >= until {
      crestRideUntil = nil
      startFill(t)
    }

    // Effort anticipation from ride OR cruise: the engine watches the ETA
    // every tick and leaves the current song exactly buildup-length before
    // the effort — no loop boundary to wait for. Mirrors TS.
    if (mode == .ride || mode == .fill) && crestRideUntil == nil {
      if dropStyle == .fresh {
        // Fresh mode: a NEW song from 0:00, crossfade timed so the swap
        // peaks right as the rep begins. Prediction owns the WHEN. Mirrors TS.
        if let eta = etaToNextHardMs(t: t, dist: dist), eta <= Self.freshChangeLeadMs, let pick = pickLoop() {
          emit(t: t, song: pick.song, positionMs: 0, fadeSec: 0.45, reason: "rep change (\(pick.song.name))")
          mode = .build
          buildTargetT = t + eta
          buildDropMs = nil // no re-aim needed inside a 4s window
        }
      } else if let eta = etaToNextHardMs(t: t, dist: dist), let r = bestDrop() {
        let buildLen = r.c.dropMs - r.c.entryMs
        if eta <= buildLen {
          dropIdx += r.advance
          let positionMs = max(0, r.c.dropMs - eta)
          let reason = mode == .ride ? "buildup toward next rep" : "buildup toward the effort"
          emit(t: t, song: r.c.song, positionMs: positionMs, fadeSec: 0.45, reason: "\(reason) (\(r.c.song.name))")
          mode = .build
          buildTargetT = t + (r.c.dropMs - positionMs)
          buildDropMs = r.c.dropMs
        }
      }
    }

    // Mid-build re-aim (funnel threshold): if the live ETA drifts off the
    // committed landing — loose far out (12% of time-to-drop), half a beat
    // close in — re-cut within the buildup so the drop lands on ARRIVAL.
    // Never inside the last 3s; at most once per 4s. Mirrors TS.
    if mode == .build, let target = buildTargetT, let dropMs = buildDropMs, let p = playing {
      if let eta = etaToNextHardMs(t: t, dist: dist), eta > 3000 {
        let bpm = p.song.bpm ?? 125
        let beatMs = 60_000 / (bpm > 0 ? bpm : 125)
        let driftMs = t + eta - target
        let threshold = max(beatMs / 2, eta * 0.12)
        if abs(driftMs) > threshold, t - lastReaimT >= 4000 {
          let positionMs = max(0, dropMs - eta)
          emit(t: t, song: p.song, positionMs: positionMs, fadeSec: 0.2, reason: "build re-aim (\(p.song.name))")
          buildTargetT = t + (dropMs - positionMs)
          lastReaimT = t
        }
      }
    }

    // Cruise chain point: change songs where the MUSIC says to — the planned
    // segment boundary (strong section just ended), or the corpus timer for
    // structureless songs. Mirrors TS.
    if mode == .fill, playing != nil, let exit = fillExitPosMs, loopable.count > 1 {
      if playheadMs(t) >= exit { startFill(t) }
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
