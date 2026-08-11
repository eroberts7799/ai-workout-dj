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

  let deck = DualDeck()
  private var clock = SessionClock()
  private var prevMs: Double = -1
  private var tick: Timer?
  private var lastHandledEvent: Double = 0

  var allAudioReady: Bool {
    guard let b = bundle, !b.songs.isEmpty else { return false }
    return b.songs.allSatisfy { audioReady[$0.trackId] == true }
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
    for song in b.songs {
      let target = normalize(song.name)
      let hit = audio.first { f in
        let n = normalize(f.lastPathComponent)
        return n.contains(target) || target.contains(n)
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
  }

  // MARK: - Session control

  func start(atOffsetMs offset: Double) {
    guard phase == .idle || phase == .done else { return } // double-start guard
    guard let b = bundle, allAudioReady else {
      status = "not ready — missing audio files"
      return
    }
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
      try? deck.play(id: cue.trackId, positionMs: cue.positionMs, fadeSec: fadeSeconds(for: cue))
      firedCount += 1
    }
    prevMs = now
    if now >= b.planEndMs {
      phase = .done
      status = "session complete — \(firedCount) cues"
      tick?.invalidate()
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
    guard phase == .paused, let b = bundle else { return }
    clock.resume()
    if let o = offset { clock.seek(to: o) }
    let now = clock.nowMs()
    prevMs = now
    establishPlayback(at: now, bundle: b)
    phase = .running
  }

  func stopSession() {
    tick?.invalidate()
    phase = .done
    status = "stopped — music left playing"
  }

  func reset() {
    tick?.invalidate()
    deck.stop()
    phase = .idle
    clockMs = 0
    status = bundle.map { "bundle: \($0.name) · \($0.cues.count) cues" } ?? "import a session bundle to begin"
  }

  // MARK: - Garmin events (from the relay)

  func handleGarmin(event: String?, timerMs: Double?, receivedAt: Double, armed: Bool) {
    guard let event, receivedAt != lastHandledEvent else { return }
    lastHandledEvent = receivedAt
    let backdated = (timerMs ?? 0) + (Date().timeIntervalSince1970 * 1000 - receivedAt)
    switch (event, phase) {
    case ("timerStart", .idle) where armed:
      start(atOffsetMs: backdated)
    case ("timerPause", .running):
      pauseSession()
    case ("timerResume", .paused):
      resumeSession(atOffsetMs: backdated)
    default:
      break
    }
  }
}
