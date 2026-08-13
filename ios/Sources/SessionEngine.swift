// SessionEngine — the pocket conductor's executor.
// Imports a session bundle, matches imported audio files to songs, and runs
// the cue schedule against the DualDeck with the same semantics the browser
// proved: never interrupt the run, watch events drive start/pause/resume.
import Foundation

@MainActor
final class SessionEngine: ObservableObject {
  enum Phase: String { case idle, running, paused, done }

  @Published var phase: Phase = .idle
  @Published var clockMs: Double = 0
  @Published var status = "import a session bundle to begin"
  @Published var bundle: SessionBundle?
  @Published var audioReady: [String: Bool] = [:]
  @Published var firedCount = 0
  @Published var liveMode = false
  @Published var lastCommand = ""
  @Published var landingCount = 0
  @Published var simulating = false

  let deck = DualDeck()
  private var clock = SessionClock()
  private var prevMs: Double = -1
  private var tick: Timer?
  private var lastHandledEvent: Double = 0
  private var live: LiveEngine?
  private var simTask: Task<Void, Never>?
  /// At accelerated sim speeds the engine's musical clock outruns real-time
  /// audio — executing loop-backs would re-cut every few seconds. Suppress
  /// them on the deck (the engine still models them internally).
  private var suppressLoopbacks = false
  /// Raw stream as conducted — uploaded at session end so every run becomes
  /// a replayable test case in the cloud (the data flywheel).
  struct RecordedSample {
    let t: Double
    let d: Double?
    let hr: Double?
    var altitude: Double? = nil
    var wkSeq: Double? = nil
    var wkKind: String? = nil
    var wkDurType: Double? = nil
    var wkDurVal: Double? = nil
    var wkNextKind: String? = nil
  }
  private var recorded: [RecordedSample] = []
  private var uploaded = false

  var allAudioReady: Bool {
    guard let b = bundle, !b.songs.isEmpty else { return false }
    return b.songs.allSatisfy { audioReady[$0.trackId] == true }
  }

  /// LIVE mode needs the plan + tag library (newer bundle exports).
  var supportsLive: Bool {
    guard let b = bundle else { return false }
    return !(b.plan ?? []).isEmpty && !(b.tags ?? []).isEmpty
  }

  private var docs: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
  }

  // MARK: - Import

  func importBundle(from url: URL) {
    do {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      let data = try Data(contentsOf: url)
      bundle = try JSONDecoder().decode(SessionBundle.self, from: data)
      try data.write(to: docs.appendingPathComponent("session-bundle.json"))
      matchAudioFiles()
      status = "bundle: \(bundle!.name) · \(bundle!.cues.count) cues"
    } catch {
      status = "bundle import failed: \(error.localizedDescription)"
    }
  }

  func importAudio(from urls: [URL]) {
    for url in urls {
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      let dest = docs.appendingPathComponent(url.lastPathComponent)
      try? FileManager.default.removeItem(at: dest)
      try? FileManager.default.copyItem(at: url, to: dest)
    }
    matchAudioFiles()
  }

  /// On launch or after imports: restore bundle and match Documents audio to songs.
  func restore() {
    if bundle == nil,
       let data = try? Data(contentsOf: docs.appendingPathComponent("session-bundle.json")),
       let b = try? JSONDecoder().decode(SessionBundle.self, from: data) {
      bundle = b
      status = "bundle: \(b.name) · \(b.cues.count) cues"
    }
    matchAudioFiles()
  }

  private func normalize(_ s: String) -> String {
    s.lowercased()
      .replacingOccurrences(of: #"\.(m4a|mp3|wav|flac|aac)$"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"^\d+[\s.\-_]*"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespaces)
  }

  private func matchAudioFiles() {
    guard let b = bundle else { return }
    let files = (try? FileManager.default.contentsOfDirectory(at: docs, includingPropertiesForKeys: nil)) ?? []
    let audio = files.filter { ["m4a", "mp3", "wav", "flac"].contains($0.pathExtension.lowercased()) }
    // LIVE mode can play any tagged song, not just the static setlist — match both.
    var candidates = b.songs
    for t in b.tags ?? [] where !candidates.contains(where: { $0.trackId == t.trackId }) {
      candidates.append(SongMeta(trackId: t.trackId, name: t.name, artists: t.artists, durationMs: t.durationMs, bpm: t.bpm))
    }
    for song in candidates {
      let target = normalize(song.name)
      guard !target.isEmpty else { continue }
      // Word-boundary matches outrank substrings ("ten" must not steal
      // TENTEN's file); longest title wins ties — mirrors the web matcher.
      let boundary = "(^| )\(NSRegularExpression.escapedPattern(for: target))( |$)"
      var hit: URL?
      var bestScore = 0.0
      for f in audio {
        let n = normalize(f.lastPathComponent)
        let score: Double
        if n.range(of: boundary, options: .regularExpression) != nil {
          score = 2 + Double(target.count) / 1000
        } else if n.contains(target) || target.contains(n) {
          score = 1 + Double(target.count) / 1000
        } else {
          score = 0
        }
        if score > bestScore {
          bestScore = score
          hit = f
        }
      }
      if let hit, !(audioReady[song.trackId] ?? false) {
        do {
          try deck.load(id: song.trackId, url: hit)
          audioReady[song.trackId] = true
        } catch {
          audioReady[song.trackId] = false
        }
      } else if hit == nil {
        audioReady[song.trackId] = audioReady[song.trackId] ?? false
      }
    }
    // Beat meta for the DJ deck: tags carry bpm + downbeat-snapped markers.
    for t in b.tags ?? [] {
      deck.setMeta(id: t.trackId, bpm: t.bpm, anchorMs: BeatMath.beatAnchorMs(markers: t.markers))
    }
    for s in b.songs where (b.tags ?? []).first(where: { $0.trackId == s.trackId }) == nil {
      deck.setMeta(id: s.trackId, bpm: s.bpm, anchorMs: 0)
    }
  }

  // MARK: - Session control

  func start(atOffsetMs offset: Double) {
    guard phase == .idle || phase == .done else { return } // double-start guard
    guard let b = bundle, allAudioReady else {
      status = "not ready — missing audio files"
      return
    }
    recorded = []
    uploaded = false
    deck.stop() // clean slate — nothing from a previous session may linger
    clock = SessionClock()
    clock.start()
    if offset > 0 { clock.seek(to: offset) }
    prevMs = offset
    firedCount = 0
    establishPlayback(at: offset, bundle: b)
    phase = .running
    status = "conducting \(b.name)"
    tick?.invalidate()
    tick = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.onTick() }
    }
  }

  private func onTick() {
    guard let b = bundle, phase == .running else { return }
    let now = clock.nowMs()
    clockMs = now
    for cue in dueCues(b.cues, prevMs: prevMs, nowMs: now, leadMs: 0) {
      // Never interrupt the run: a failed cue leaves current audio playing.
      try? deck.play(id: cue.trackId, positionMs: cue.positionMs, fadeSec: fadeSeconds(for: cue), opts: BeatMath.deckOpts(for: cue.reason))
      firedCount += 1
    }
    prevMs = now
    if now >= b.planEndMs {
      phase = .done
      status = "session complete — \(firedCount) cues"
      tick?.invalidate()
      uploadSessionLog(source: "ios")
    }
  }

  private func establishPlayback(at ms: Double, bundle b: SessionBundle) {
    let past = b.cues.filter { $0.atMs <= ms }.max { $0.atMs < $1.atMs }
    guard let cue = past else { return }
    let dur = b.songs.first { $0.trackId == cue.trackId }?.durationMs ?? 240_000
    let pos = min(max(0, cue.positionMs + (ms - cue.atMs)), dur - 5000)
    try? deck.play(id: cue.trackId, positionMs: pos, fadeSec: 0.2)
  }

  func pauseSession() {
    guard phase == .running else { return }
    clock.pause()
    deck.pause()
    phase = .paused
  }

  func resumeSession(atOffsetMs offset: Double? = nil) {
    guard phase == .paused else { return }
    if live != nil {
      // LIVE follows the watch/sim clock — just unmute and continue.
      clock.resume()
      deck.resume()
      phase = .running
      return
    }
    guard let b = bundle else { return }
    clock.resume()
    if let o = offset { clock.seek(to: o) }
    let now = clock.nowMs()
    prevMs = now
    establishPlayback(at: now, bundle: b)
    phase = .running
  }

  func stopSession() {
    tick?.invalidate()
    simTask?.cancel()
    phase = .done
    status = "stopped — music left playing"
    uploadSessionLog(source: simulating ? "ios-sim" : "ios")
  }

  /// Fire-and-forget POST of the session log to the relay's archive.
  private func uploadSessionLog(source: String) {
    guard !uploaded, !recorded.isEmpty, let b = bundle else { return }
    uploaded = true
    var payload: [String: Any] = [
      "source": source,
      "name": b.name,
      "plan": ["name": b.name, "steps": (b.plan ?? []).map { s -> [String: Any] in
        var d: [String: Any] = ["kind": s.kind]
        if let v = s.seconds { d["seconds"] = v }
        if let v = s.meters { d["meters"] = v }
        return d
      }],
      "samples": recorded.map { r -> [String: Any] in
        var d: [String: Any] = ["tMs": r.t]
        if let v = r.d { d["distanceM"] = v }
        if let v = r.hr { d["hr"] = v }
        if let v = r.altitude { d["altitude"] = v }
        if let v = r.wkSeq { d["wkStepSeq"] = v }
        if let k = r.wkKind {
          var s: [String: Any] = ["kind": k]
          if let v = r.wkDurType { s["durationType"] = v }
          if let v = r.wkDurVal { s["durationValue"] = v }
          d["wkStep"] = s
        }
        if let k = r.wkNextKind { d["wkNext"] = ["kind": k] }
        return d
      },
    ]
    if let live {
      payload["landings"] = live.landings.map { ["targetTMs": $0.targetTMs, "actualTMs": $0.actualTMs, "errorMs": $0.errorMs] }
      payload["commands"] = live.commands.map { ["tMs": $0.tMs, "trackId": $0.trackId, "positionMs": $0.positionMs, "reason": $0.reason] }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let url = URL(string: "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x")
    else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    Task {
      if let (_, res) = try? await URLSession.shared.data(for: req),
         (res as? HTTPURLResponse)?.statusCode == 201 {
        status += " · ☁️ log uploaded"
      }
    }
  }

  func reset() {
    tick?.invalidate()
    simTask?.cancel()
    live = nil
    deck.stop()
    phase = .idle
    clockMs = 0
    lastCommand = ""
    landingCount = 0
    status = bundle.map { "bundle: \($0.name) · \($0.cues.count) cues" } ?? "import a session bundle to begin"
  }

  // MARK: - LIVE mode (LiveEngine conducts from the watch's stream)

  func startLive() {
    guard phase == .idle || phase == .done else { return }
    guard let b = bundle, let plan = b.plan, let tags = b.tags, supportsLive else {
      status = "this bundle has no LIVE payload — re-export from the web app"
      return
    }
    deck.stop()
    live = LiveEngine(plan: plan, songs: tags)
    firedCount = 0
    landingCount = 0
    lastCommand = ""
    recorded = []
    uploaded = false
    suppressLoopbacks = false
    prevMs = 0
    phase = .running
    status = "🛰 LIVE — conducting \(b.name) from your body's data"
    for w in live?.warnings ?? [] { status += " · ⚠️ \(w)" }
  }

  /// Every fresh watch sample advances the engine — the watch's own timer and
  /// distance ARE the session clock, so pauses come free.
  /// Record a watch sample regardless of mode — every session feeds the flywheel.
  func recordSample(_ s: GarminSample) {
    guard phase == .running, let t = s.timerMs else { return }
    recorded.append(RecordedSample(
      t: t, d: s.distanceM, hr: s.hr, altitude: s.altitude,
      wkSeq: s.wkStepSeq, wkKind: s.wkStep?.kind,
      wkDurType: s.wkStep?.durationType, wkDurVal: s.wkStep?.durationValue,
      wkNextKind: s.wkNext?.kind
    ))
  }

  // NOTE: capture happens in recordSample (all modes, full fidelity) — the
  // simulator appends its own samples. advanceLive only conducts.
  func advanceLive(timerMs: Double, distanceM: Double?, hr: Double? = nil) {
    guard phase == .running, let live else { return }
    clockMs = timerMs
    for c in live.advance(LiveSample(tMs: timerMs, distanceM: distanceM)) {
      if suppressLoopbacks && c.reason.hasPrefix("loop back") { continue }
      // Never interrupt the run: a missing file leaves current audio playing.
      try? deck.play(id: c.trackId, positionMs: c.positionMs, fadeSec: c.fadeSec, opts: BeatMath.deckOpts(for: c.reason))
      firedCount += 1
      lastCommand = c.reason
    }
    landingCount = live.landings.count
  }

  // MARK: - Simulated run (no watch needed — demo + Thursday dress rehearsal)

  func startSimulatedRun(speed: Double = 8) {
    guard phase == .idle || phase == .done else { return }
    guard let b = bundle, let plan = b.plan, supportsLive else {
      status = "this bundle has no LIVE payload — re-export from the web app"
      return
    }
    startLive()
    guard phase == .running else { return }
    suppressLoopbacks = speed > 1
    status = "🧪 simulated runner ×\(Int(speed)) — \(b.name)"
    let samples = syntheticSamples(plan: plan, scenario: RunScenario())
    simTask?.cancel()
    simulating = true
    simTask = Task { // inherits @MainActor
      defer { simulating = false }
      for s in samples {
        if Task.isCancelled { return }
        while phase == .paused { // Pause holds the runner, doesn't kill it
          try? await Task.sleep(nanoseconds: 200_000_000)
          if Task.isCancelled { return }
        }
        guard phase == .running else { return }
        advanceLive(timerMs: s.tMs, distanceM: s.distanceM)
        recorded.append(RecordedSample(t: s.tMs, d: s.distanceM, hr: nil))
        try? await Task.sleep(nanoseconds: UInt64(1_000_000_000 / speed))
      }
      guard phase == .running else { return }
      phase = .done
      status = "simulated session complete — \(firedCount) cues · \(landingCount) landings"
      deck.stop()
      uploadSessionLog(source: "ios-sim")
    }
  }

  func stopSimulatedRun() {
    simTask?.cancel()
    simTask = nil
    simulating = false
    suppressLoopbacks = false
  }

  // MARK: - Garmin events (from the relay)

  func handleGarmin(event: String?, timerMs: Double?, receivedAt: Double, armed: Bool) {
    guard let event, receivedAt != lastHandledEvent else { return }
    lastHandledEvent = receivedAt
    let backdated = (timerMs ?? 0) + (Date().timeIntervalSince1970 * 1000 - receivedAt)
    switch (event, phase) {
    case ("timerStart", .idle) where armed:
      liveMode && supportsLive ? startLive() : start(atOffsetMs: backdated)
    case ("timerPause", .running):
      pauseSession()
    case ("timerResume", .paused):
      resumeSession(atOffsetMs: backdated) // live-aware: LIVE just unmutes
    default:
      break
    }
  }
}
