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
  // LIVE is the one brain (static cues are the legacy path, kept only for
  // clock-started HIIT programs) — no user toggle, no mode to explain.
  @Published var liveMode = true
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

  /// Built-in programs: the demo set + HIIT presets shaped by real interval
  /// data (292 structured sessions: ~60s work / ~45s rest, ~11 bouts).
  static let builtinPrograms: [(resource: String, title: String)] = [
    ("demo-bundle", "Demo Set — 15 min"),
    ("preset-hiit-express", "HIIT Express — 12 min"),
    ("preset-hiit-classic", "HIIT Classic — 25 min"),
    ("preset-intervals", "Long Intervals — 22 min"),
  ]

  func loadBuiltin(_ resource: String) {
    guard phase == .idle || phase == .done else { return }
    guard let url = Bundle.main.url(forResource: resource, withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let b = try? JSONDecoder().decode(SessionBundle.self, from: data)
    else {
      status = "program \(resource) missing from app bundle"
      return
    }
    bundle = b
    musicSource = .ownedFiles // built-in programs play bundled audio
    phase = .idle
    clockMs = 0
    status = "program: \(b.name)"
    stampTagTable()
    matchAudioFiles()
  }

  /// LIVE mode needs the tag library; a plan is OPTIONAL — with none, the
  /// engine FOLLOWS the watch's structured-workout stream (the workout lives
  /// in Runna/Garmin; nobody retypes it).
  var supportsLive: Bool {
    guard let b = bundle else { return false }
    return !(b.tags ?? []).isEmpty
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
      musicSource = .ownedFiles // imported bundles carry owned audio
      try data.write(to: docs.appendingPathComponent("session-bundle.json"))
      // Calibrated zone anchor rides in on real bundles; keep it even when
      // the demo set later replaces the bundle in memory.
      if let m = bundle!.hrMax, m >= 120, m <= 230 {
        UserDefaults.standard.set(m, forKey: "awdj.hrMax")
      }
      stampTagTable()
      matchAudioFiles()
      status = "bundle: \(bundle!.name) · \(bundle!.cues.count) cues"
    } catch {
      status = "bundle import failed: \(error.localizedDescription)"
    }
  }

  /// In-app music source (playlist scrape / Liked Songs): the tags REPLACE
  /// the music library while everything the bundle learned stays — hrMax,
  /// learned pairs. Persisted like any imported bundle.
  func adoptLibrary(name: String, tags: [TaggedSong]) {
    // Adopting a Spotify playlist / Liked Songs IS declaring Spotify the
    // source — otherwise musicSource stays .ownedFiles and every command
    // routes to the silent deck (8/27: the SECOND half of the silent-run
    // bug; the runner never knew a hidden picker also had to be flipped).
    musicSource = .spotify
    workoutName = nil // the plan goes with it — prepareForToday reloads
    // Plan deliberately dropped: adopting a music library is a fresh start,
    // and an empty plan is what lets FOLLOW MODE conduct from the watch's
    // step stream (a stale plan would silently block it — Thursday's test).
    var b = SessionBundle(
      name: name, planEndMs: 0, cues: [], songs: [],
      plan: nil, tags: tags,
      hrMax: bundle?.hrMax ?? UserDefaults.standard.object(forKey: "awdj.hrMax") as? Double,
      pairBonus: bundle?.pairBonus, files: nil)
    b.source = MusicSource.spotify.rawValue
    bundle = b
    if let data = try? JSONEncoder().encode(b) {
      try? data.write(to: docs.appendingPathComponent("session-bundle.json"))
    }
    matchAudioFiles()
    let tagged = tags.filter { $0.bpm != nil }.count
    status = "library: \(name) · \(tags.count) songs (\(tagged) with DJ tags)"
    // Report the adopted library (names only) so enrichment runs on the Mac
    // can preview-tag what the phone actually plays from — the tag table
    // then upgrades every picker at next app-open.
    let snapshot: [String: Any] = [
      "name": "library-snapshot", "source": "library", "library": name,
      "tracks": tags.map { ["id": $0.trackId, "name": $0.name, "artists": $0.artists, "tagged": $0.bpm != nil] },
    ]
    if let body = try? JSONSerialization.data(withJSONObject: snapshot) {
      var req = URLRequest(url: URL(string: "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x")!, timeoutInterval: 20)
      req.httpMethod = "POST"
      req.httpBody = body
      URLSession.shared.dataTask(with: req).resume()
    }
  }

  /// The day's workout as shown on the ready screen ("Rolling 800s (5mi)").
  @Published var workoutName: String?

  /// Attach the day's planned workout to the current music library. Live,
  /// the watch still owns step BOUNDARIES (wkStepSeq is authoritative); the
  /// plan supplies step IDENTITY the stream can't carry — Runna authors
  /// tempo floats as plain "interval" steps, indistinguishable from the
  /// efforts, so a Rolling 800s day would read as six identical hards.
  func adoptPlan(name: String, steps: [WorkoutStep]) {
    guard let b = bundle, b.tags?.isEmpty == false else {
      status = "pick a music library first, then load the workout"
      return
    }
    var withPlan = SessionBundle(
      name: b.name, planEndMs: b.planEndMs, cues: b.cues, songs: b.songs,
      plan: steps, tags: b.tags, hrMax: b.hrMax, pairBonus: b.pairBonus, files: b.files)
    withPlan.source = b.source
    bundle = withPlan
    if let data = try? JSONEncoder().encode(bundle) {
      try? data.write(to: docs.appendingPathComponent("session-bundle.json"))
    }
    workoutName = name
    let hard = steps.filter { $0.kind == "hard" }.count
    status = "workout loaded: \(name) — \(steps.count) steps, \(hard) efforts get bangers"
  }

  private struct NextWorkout: Decodable {
    let name: String
    let date: String?
    let steps: [WorkoutStep]
  }

  /// The Mac publishes the next planned workout (scripts/publish-next-
  /// workout.sh, launchd-daily) — fetched automatically at app open and
  /// on the manual menu button.
  func loadNextWorkout() {
    status = "fetching today's workout…"
    Task { [weak self] in await self?.fetchNextWorkout() }
  }

  private func fetchNextWorkout() async {
    do {
      let url = URL(string: "https://awdj-relay.vercel.app/api/next-workout?k=awdj-7g2k9x")!
      let (data, resp) = try await URLSession.shared.data(from: url)
      guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
        throw NSError(domain: "awdj", code: 404, userInfo: [
          NSLocalizedDescriptionKey: "none published — run publish-next-workout.sh on the Mac"])
      }
      let w = try JSONDecoder().decode(NextWorkout.self, from: data)
      adoptPlan(name: w.name, steps: w.steps)
    } catch {
      status = "workout fetch failed: \(error.localizedDescription)"
    }
  }

  /// Preset, ready to rock (9/1 postmortem: the run failed on setup
  /// friction, not the brain). At app open: hold the audio session so a
  /// locked phone still hears the watch's START, ensure a library (cached
  /// Free Play crate when none picked — always wired), and load the day's
  /// workout. After this, the whole start ritual is: press START on the
  /// watch (plus Spotify's own wake, which iOS will not let us do).
  func prepareForToday(spotifyConnected: Bool) async {
    guard phase == .idle else { return }
    // Parity law: the ready-state flow serves BOTH tiers. Spotify-specific:
    // the pre-run keep-alive (the deck holds its own audio session) and the
    // Free Play default library. The workout preset is universal.
    if musicSource == .spotify {
      guard spotifyConnected else { return }
      KeepAlive.shared.start() // awake BEFORE the run — START must find us listening
      if bundle?.tags?.isEmpty != false {
        status = "wiring up Free Play…"
        if let tags = try? await SpotifyLibrary.freeCrate(progress: { [weak self] in self?.status = $0 }) {
          adoptLibrary(name: SpotifyLibrary.freeCrateName, tags: tags)
        }
      }
    }
    if bundle?.tags?.isEmpty == false { await fetchNextWorkout() }
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
  /// First launch with nothing imported: the built-in demo set loads itself —
  /// a new tester hears the DJ in minute one, zero setup.
  func restore() {
    retryPendingUploads()
    if bundle == nil,
       let data = try? Data(contentsOf: docs.appendingPathComponent("session-bundle.json")),
       let b = try? JSONDecoder().decode(SessionBundle.self, from: data) {
      bundle = b
      status = "bundle: \(b.name) · \(b.cues.count) cues"
    }
    if bundle == nil,
       let url = Bundle.main.url(forResource: "demo-bundle", withExtension: "json"),
       let data = try? Data(contentsOf: url),
       let b = try? JSONDecoder().decode(SessionBundle.self, from: data) {
      bundle = b
      status = "demo set loaded — press Start, or Simulate a run"
    }
    stampTagTable()
    matchAudioFiles()
    // Restore the music source: the bundle's RECORDED fact wins (9/2:
    // heuristics failed three ways — the name-match derivation flagged a
    // Spotify library as owned because a track title matched an old
    // imported file). Legacy fallbacks only for bundles that predate the
    // source field; the didSet then self-heals them on first assignment.
    if let src = bundle?.source, let m = MusicSource(rawValue: src) {
      musicSource = m
    } else if isStreamingShaped(bundle) {
      // Deterministic, zero-heuristic: in-app libraries (playlist / Liked /
      // Free Play) are ALWAYS built with songs:[] and tags full; owned-file
      // web bundles ALWAYS carry songs+cues. (The previous derivation —
      // "no matched owned audio" — was defeated by a tag title
      // name-matching an old imported file: shakeout attempt 3.)
      musicSource = .spotify
    } else if let raw = UserDefaults.standard.string(forKey: "awdj.musicSource"),
       let m = MusicSource(rawValue: raw) {
      musicSource = m
    }
  }

  /// Parity law (2026-09-01): owned-file bundles get the same taste +
  /// energy enrichment the Spotify imports get — the tiers move together.
  /// Per-field provenance (rule 5): the tagger's bpm/camelot/markers are
  /// file-derived ground truth and are never overwritten — the table only
  /// fills gaps; affinity/energy are table-derived by nature and refresh.
  private func stampTagTable() {
    guard let b = bundle, let tags = b.tags, !tags.isEmpty else { return }
    let stamped = tags.map { t -> TaggedSong in
      let e = SpotifyLibrary.enrich(artist: t.artists, title: t.name)
      var s = TaggedSong(trackId: t.trackId, uri: t.uri, name: t.name, artists: t.artists,
                         durationMs: t.durationMs, bpm: t.bpm ?? e.bpm,
                         camelot: t.camelot ?? e.camelot, markers: t.markers)
      s.segments = t.segments
      s.affinity = e.affinity ?? t.affinity
      s.energy = t.energy ?? e.energy
      return s
    }
    var stampedBundle = SessionBundle(
      name: b.name, planEndMs: b.planEndMs, cues: b.cues, songs: b.songs,
      plan: b.plan, tags: stamped, hrMax: b.hrMax, pairBonus: b.pairBonus, files: b.files)
    stampedBundle.source = b.source
    bundle = stampedBundle
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
    // Built-in demo audio ships inside the app bundle, mapped explicitly.
    for (trackId, fname) in b.files ?? [:] {
      let base = (fname as NSString).deletingPathExtension
      let ext = (fname as NSString).pathExtension
      if !(audioReady[trackId] ?? false), let url = Bundle.main.url(forResource: base, withExtension: ext) {
        if (try? deck.load(id: trackId, url: url)) != nil {
          audioReady[trackId] = true
        }
      }
    }
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
    // Pause silences EVERY output, keyed on music source — not just the deck
    // (8/31: pause left Spotify playing; same class as the 8/27 trailMode
    // gating bug). An undelivered command is stashed for resume; an in-flight
    // attempt is orphaned so it can't undo the pause.
    if musicSource == .spotify {
      spotifyGen += 1
      pausedSpotify = pendingSpotify
      pendingSpotify = nil
      Task { await SpotifyRemote.shared.pause() }
    }
    phase = .paused
  }

  func resumeSession(atOffsetMs offset: Double? = nil) {
    guard phase == .paused else { return }
    if live != nil {
      // LIVE follows the watch/sim clock — just unmute and continue.
      clock.resume()
      deck.resume()
      if musicSource == .spotify {
        if let p = pausedSpotify {
          // A command was still undelivered at pause — re-offer it; the
          // watchdog rejoins at the modeled playhead automatically.
          pausedSpotify = nil
          deliverSpotify(uris: p.uris, positionMs: p.positionMs, timerMs: p.atTimerMs, reason: p.reason)
        } else {
          Task { [weak self] in
            if await SpotifyRemote.shared.resume() { return }
            // Device slept through the pause — fall back to re-delivering
            // the last command; the watchdog retries until it lands.
            guard let self, self.phase == .running, let l = self.lastDeliveredSpotify else { return }
            self.deliverSpotify(uris: l.uris, positionMs: l.positionMs, timerMs: l.atTimerMs, reason: "\(l.reason) (resume)")
          }
        }
      }
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
    if trailMode {
      phoneSensors.stop()
      BleHeartRate.shared.stop()
      deck.stop() // trail sessions end SILENT — no orphan DJ haunting the car ride home
    }
    // Spotify cleanup keys on music source, not mode — a LIVE (watch-driven)
    // Spotify run must also stop cleanly (8/27: same trailMode-gating bug).
    silenceSpotify()
    phase = .done
    status = trailMode ? "trail session ended" : "stopped"
    uploadSessionLog(source: trailMode ? "ios-trail" : simulating ? "ios-sim" : "ios")
    trailMode = false
    // The watch may still be running this activity — remember it so a
    // Reset to idle doesn't late-join the same run and restart the music.
    if let t = lastWatchTimerMs { stoppedActivity = (timerMs: t, wall: Date().timeIntervalSince1970) }
  }

  /// The activity the user stopped the app on: watch timer + wall clock at
  /// the stop. 9/3 walk: five resurrections in 40s after the stop — each
  /// Reset went idle, the still-running watch timer late-joined, and the
  /// first song started again. Same activity ⇔ the timer has advanced about
  /// as much as the wall clock (pauses only shrink it); a NEW activity seen
  /// past the old stop point shows a far larger wall gap.
  private var stoppedActivity: (timerMs: Double, wall: TimeInterval)?
  private var lastWatchTimerMs: Double?
  private func isStoppedActivity(timerMs t: Double) -> Bool {
    guard let s = stoppedActivity, t >= s.timerMs else { return false }
    let wallElapsedMs = (Date().timeIntervalSince1970 - s.wall) * 1000
    return wallElapsedMs < (t - s.timerMs) + 600_000
  }

  /// Anonymous per-install identity — multi-user flywheel data needs to
  /// tell bodies apart without knowing who anyone is.
  private var athleteId: String {
    let key = "awdj.athleteId"
    if let v = UserDefaults.standard.string(forKey: key) { return v }
    let v = "a-" + UUID().uuidString.prefix(12).lowercased()
    UserDefaults.standard.set(v, forKey: key)
    return v
  }

  /// Fire-and-forget POST of the session log to the relay's archive.
  private func uploadSessionLog(source: String) {
    guard !uploaded, !recorded.isEmpty, let b = bundle else { return }
    uploaded = true
    var payload: [String: Any] = [
      "source": source,
      "athlete": athleteId,
      "athleteName": UserDefaults.standard.string(forKey: "awdj.profileName") ?? "",
      "athletePhone": UserDefaults.standard.string(forKey: "awdj.profilePhone") ?? "",
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
      if !deliveryEvents.isEmpty { payload["delivery"] = deliveryEvents }
      payload["musicSource"] = musicSource.rawValue
      // The runner's overrules — per-transition negative feedback, free.
      payload["skips"] = live.skips.map {
        var d: [String: Any] = ["tMs": $0.tMs, "toTrackId": $0.toTrackId]
        if let f = $0.fromTrackId { d["fromTrackId"] = f }
        if let p = $0.fromPositionMs { d["fromPositionMs"] = p }
        return d
      }
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
    // DURABLE FIRST: a trail run may end in a dead zone — the log lands on
    // disk before any network is attempted, and retries on future launches.
    let pending = docs.appendingPathComponent("pending-log-\(Int(Date().timeIntervalSince1970)).json")
    try? data.write(to: pending)
    Task { await self.tryUpload(file: pending) }
  }

  /// POST one persisted log; delete only on confirmed 201.
  private func tryUpload(file: URL) async {
    guard let data = try? Data(contentsOf: file),
          let url = URL(string: "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x") else { return }
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = data
    if let (_, res) = try? await URLSession.shared.data(for: req),
       (res as? HTTPURLResponse)?.statusCode == 201 {
      try? FileManager.default.removeItem(at: file)
      await MainActor.run { status += " · ☁️ log uploaded" }
    }
  }

  /// Called from restore(): push any logs that never made it out.
  func retryPendingUploads() {
    let files = (try? FileManager.default.contentsOfDirectory(at: docs, includingPropertiesForKeys: nil)) ?? []
    for f in files where f.lastPathComponent.hasPrefix("pending-log-") {
      Task { await self.tryUpload(file: f) }
    }
  }

  func reset() {
    tick?.invalidate()
    simTask?.cancel()
    live = nil
    deck.stop()
    silenceSpotify()
    phase = .idle
    clockMs = 0
    lastCommand = ""
    landingCount = 0
    status = bundle.map { "bundle: \($0.name) · \($0.cues.count) cues" } ?? "import a session bundle to begin"
  }

  // MARK: - LIVE mode (LiveEngine conducts from the watch's stream)

  func startLive() {
    guard phase == .idle || phase == .done else { return }
    guard let b = bundle, let tags = b.tags, supportsLive else {
      status = "this bundle has no LIVE payload — re-export from the web app"
      return
    }
    // LAST-GATE GUARD (9/2, four failed shakeouts on this one field): a
    // LIVE session must never run a streaming-shaped library on the deck —
    // the deck is silent for it AND its non-mixing session pauses Spotify.
    if musicSource == .ownedFiles, isStreamingShaped(b) {
      musicSource = .spotify
    }
    deck.stop()
    // Empty plan → follow mode: the watch's step stream IS the workout.
    // hrMax: calibrated per-athlete anchor delivered by the bundle import.
    let hrMax = UserDefaults.standard.object(forKey: "awdj.hrMax") as? Double
    live = LiveEngine(plan: b.plan ?? [], songs: tags, pairBonus: b.pairBonus ?? [:], hrMax: hrMax, streamingHandoff: musicSource == .spotify)
    firedCount = 0
    landingCount = 0
    lastCommand = ""
    recorded = []
    uploaded = false
    suppressLoopbacks = false
    prevMs = 0
    resetSpotifyDelivery()
    if musicSource == .spotify { KeepAlive.shared.start() } // survive the pocket
    phase = .running
    status = "🛰 LIVE — conducting \(b.name) from your body's data"
    for w in live?.warnings ?? [] { status += " · ⚠️ \(w)" }
  }

  // MARK: - TRAIL mode (the phone conducts itself: GPS + barometer, offline)

  let phoneSensors = PhoneSensors()
  @Published var trailMode = false

  /// What plays the music on a trail run: the on-device deck (owned files,
  /// fully offline) or the phone's own Spotify app (downloaded playlist;
  /// commands need signal — airplane mode = music pauses at song end while
  /// RECORDING continues untouched).
  enum MusicSource: String { case ownedFiles, spotify }
  @Published var musicSource: MusicSource = .ownedFiles {
    // The source is a FACT about the library, recorded into the bundle
    // itself (9/2: three shakeout attempts died on this field being
    // guessed — first not restored at all, then mis-derived by a name
    // match against old imported audio). Any change, including the manual
    // picker, rewrites the bundle's source so restarts restore truth.
    didSet {
      UserDefaults.standard.set(musicSource.rawValue, forKey: "awdj.musicSource")
      persistBundleSource()
    }
  }

  /// In-app adopted streaming libraries are structurally distinct from
  /// owned-file bundles: no songs, no cues, tags only.
  private func isStreamingShaped(_ b: SessionBundle?) -> Bool {
    guard let b else { return false }
    return b.songs.isEmpty && b.cues.isEmpty && !(b.tags ?? []).isEmpty
  }

  private func persistBundleSource() {
    // In-memory patch only: the adoption/import sites own their disk
    // writes. Writing here would let a built-in demo program (never
    // persisted by design) clobber the user's real library on disk.
    guard let b = bundle, b.source != musicSource.rawValue else { return }
    var patched = b
    patched.source = musicSource.rawValue
    bundle = patched
  }

  // MARK: - Spotify delivery watchdog
  // Soft-fail is still the doctrine (recording never depends on playback),
  // but the 8/22 trail run showed the cost of fire-and-forget: one command
  // lost to a dead zone = SILENCE until the next scheduled change, minutes
  // away — Ethan DJed by hand at mile 9. An undelivered command is now
  // retried every 10s at the engine's modeled playhead, so music rejoins
  // where the model thinks it is the moment signal returns.
  private struct PendingSpotify { let uris: [String]; let positionMs: Double; let atTimerMs: Double; let gen: Int; let reason: String }
  private var pendingSpotify: PendingSpotify?
  /// Command that was still undelivered when the session paused — re-offered on resume.
  private var pausedSpotify: PendingSpotify?
  /// Most recent successfully delivered command — the fallback anchor when a
  /// plain resume fails (device slept through a long pause): re-offer it and
  /// the watchdog rejoins at the modeled playhead.
  private var lastDeliveredSpotify: PendingSpotify?

  /// Session over (stop, sim completion, reset): Spotify goes silent, nothing
  /// in flight may resurrect it. Every halt path calls this — halting only
  /// the deck while the source is Spotify is the 8/27+8/31 bug class.
  private func silenceSpotify() {
    guard musicSource == .spotify else { return }
    spotifyGen += 1 // orphan any in-flight retry — it must not resurrect music
    pendingSpotify = nil
    pausedSpotify = nil
    KeepAlive.shared.stop()
    Task { await SpotifyRemote.shared.pause() }
  }
  private var spotifyGen = 0
  private var spotifyRetryAtMs: Double = 0
  private var spotifyAttemptInFlight = false
  private var spotifyPollAtMs: Double = 0
  private var spotifyPollInFlight = false
  private var spotifyEverDelivered = false
  private var spotifyLastDeliveryWall: TimeInterval = 0
  /// STREAMING HANDOFF (9/3 walk: every song-end cut landed ±3s off the real
  /// end — early was a hard pause, late restarted the song Spotify had
  /// already rolled into). Song ends are now the player's own roll into the
  /// spare it holds; the engine predicts the roll, a read verifies it, and
  /// only then the next spare is queued.
  private struct SpotifyHandoff { let command: LivePlayCommand; let fromTrackId: String?; let atMs: Double; var tries: Int }
  private var spotifyHandoff: SpotifyHandoff?
  /// What the executor last put in front of the player (cut or verified roll).
  private var spotifyModelTrackId: String?
  private var spotifyQueueRetry: (uri: String, atMs: Double)?
  /// Field diagnosability (9/2 shakeout: "music never came on" with zero
  /// evidence in the log): every delivery attempt's outcome, shipped in the
  /// session log. Ring-capped — a broken morning must not bloat the upload.
  private var deliveryEvents: [[String: Any]] = []

  private func recordDelivery(ok: Bool, note: String) {
    deliveryEvents.append(["tMs": clockMs, "ok": ok, "note": String(note.prefix(120))])
    if deliveryEvents.count > 200 { deliveryEvents.removeFirst(deliveryEvents.count - 200) }
  }

  /// Fresh pipeline for a fresh session. Stale poll/retry deadlines from a
  /// previous session either fired a reconciliation read on the FIRST tick
  /// (adopting the pre-run song as choreography — the dirty-start bug) or
  /// pushed the first poll minutes out (skip detection dead all session).
  private func resetSpotifyDelivery() {
    spotifyGen += 1 // orphan any in-flight attempt from a previous session
    pendingSpotify = nil
    pausedSpotify = nil
    lastDeliveredSpotify = nil
    deliveryEvents = []
    spotifyRetryAtMs = 0
    spotifyPollAtMs = 0
    spotifyEverDelivered = false
    spotifyLastDeliveryWall = 0
    spotifyHandoff = nil
    spotifyModelTrackId = nil
    spotifyQueueRetry = nil
  }

  private func deliverSpotify(uris: [String], positionMs: Double, timerMs: Double, reason: String) {
    spotifyGen += 1
    pendingSpotify = PendingSpotify(uris: uris, positionMs: positionMs, atTimerMs: timerMs, gen: spotifyGen, reason: reason)
    // Retry FAST early (3s): the first command often lands before Spotify's
    // device is awake, and a runner shouldn't wait 10s for music. The pump
    // backs off to 10s once something has delivered.
    spotifyRetryAtMs = timerMs + 3_000
    attemptSpotifyDelivery()
  }

  private func attemptSpotifyDelivery() {
    guard !spotifyAttemptInFlight, let p = pendingSpotify else { return }
    spotifyAttemptInFlight = true
    // Rejoin at the engine's modeled NOW, not the command's original position
    // — a cut delivered 40s late should sound 40s in, or every chain point
    // after it drifts off the model.
    let position = p.positionMs + max(0, clockMs - p.atTimerMs)
    Task { [weak self] in
      let err = await SpotifyRemote.shared.play(uris: p.uris, positionMs: position)
      guard let self else { return }
      self.spotifyAttemptInFlight = false
      guard self.pendingSpotify?.gen == p.gen else { return } // superseded mid-flight
      self.recordDelivery(ok: err == nil, note: err ?? p.reason)
      if err == nil {
        self.pendingSpotify = nil
        self.spotifyEverDelivered = true
        self.lastDeliveredSpotify = p
        self.spotifyLastDeliveryWall = Date().timeIntervalSince1970
        // Grace window: /me/player is eventually-consistent — a read right
        // after a play command reports the PREVIOUS track, and adopting it
        // snaps the model backwards and re-cuts the song we just started.
        self.spotifyPollAtMs = self.clockMs + 20_000
      } else {
        // Actionable message: the usual cause is a sleeping Spotify.
        self.lastCommand = self.spotifyEverDelivered
          ? "\(p.reason) · \(err!) — retrying"
          : "open Spotify & press play once, then it takes over"
      }
    }
  }

  /// No watch, no relay, no signal: the phone's own sensors drive the engine.
  /// Empty plan → pure cruise + crest rewards — free-run choreography.
  func startTrailRun() {
    guard phase == .idle || phase == .done else { return }
    guard let b = bundle, let tags = b.tags, !tags.isEmpty else {
      status = "trail mode needs a music bundle first"
      return
    }
    if musicSource == .spotify && !SpotifyAuth.shared.connected {
      status = "connect Spotify first (or switch music source to owned files)"
      return
    }
    deck.stop()
    let hrMax = UserDefaults.standard.object(forKey: "awdj.hrMax") as? Double
    live = LiveEngine(plan: [], songs: tags, pairBonus: b.pairBonus ?? [:], hrMax: hrMax, streamingHandoff: musicSource == .spotify)
    firedCount = 0
    landingCount = 0
    lastCommand = ""
    recorded = []
    uploaded = false
    suppressLoopbacks = false
    prevMs = 0
    resetSpotifyDelivery()
    if musicSource == .spotify { KeepAlive.shared.start() } // survive the pocket
    trailMode = true
    phase = .running
    status = "TRAIL — phone sensors conducting (offline-ready)"
    phoneSensors.onTick = { [weak self] t, d, alt in
      guard let self, self.phase == .running else { return }
      // Watch BLE broadcast fills the trail log's HR hole (8/22 run had
      // none) — and activates the crest "earned" gate (zone ≥ 3).
      let hr = BleHeartRate.shared.currentBpm
      self.advanceLive(timerMs: t, distanceM: d, hr: hr, altitudeM: alt)
      self.recorded.append(RecordedSample(t: t, d: d, hr: hr, altitude: alt))
    }
    BleHeartRate.shared.start()
    phoneSensors.start()
  }

  /// Every fresh watch sample advances the engine — the watch's own timer and
  /// distance ARE the session clock, so pauses come free.
  /// Record a watch sample regardless of mode — every session feeds the flywheel.
  func recordSample(_ s: GarminSample) {
    if trailMode { return } // trail sessions record from phone sensors
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
  func advanceLive(
    timerMs: Double,
    distanceM: Double?,
    hr: Double? = nil,
    altitudeM: Double? = nil,
    wkStepSeq: Double? = nil,
    wkKind: String? = nil,
    wkDurationType: Double? = nil,
    wkDurationValue: Double? = nil,
    wkNextKind: String? = nil
  ) {
    guard phase == .running, let live else { return }
    clockMs = timerMs
    let s = LiveSample(
      tMs: timerMs, distanceM: distanceM, altitudeM: altitudeM, hr: hr, wkStepSeq: wkStepSeq,
      wkKind: wkKind, wkDurationType: wkDurationType, wkDurationValue: wkDurationValue, wkNextKind: wkNextKind
    )
    for c in live.advance(s) {
      // Commands from advance() are PREDICTIONS (a handoff's roll is not
      // yet observed); adoptions from a player read arrive confirmed.
      execute(c, timerMs: timerMs, confirmed: false)
    }
    // Watchdog pump: re-offer an undelivered Spotify command. Fast (3s)
    // while nothing has ever delivered (waking the device); 10s after.
    if pendingSpotify != nil, timerMs >= spotifyRetryAtMs {
      spotifyRetryAtMs = timerMs + (spotifyEverDelivered ? 10_000 : 3_000)
      attemptSpotifyDelivery()
    }
    if let r = spotifyQueueRetry, timerMs >= r.atMs {
      spotifyQueueRetry = nil
      queueSpare(r.uri, for: "queue retry")
    }
    // Reconciliation: every 20s ask Spotify what is ACTUALLY playing. A
    // mismatch = the runner skipped (or the queue spare fired) — the model
    // adopts reality and the overrule lands in the log as feedback.
    // Skipped while a delivery is pending: the player is known-stale then.
    // Also skipped: before the first delivery (a t≈0 read adopts the runner's
    // pre-run song as choreography), within 5s wall-time of any delivery
    // (stale-read window), and during simulation (engine clock runs 8× real
    // audio — "reconciling" against lagging audio is a permanent jump loop).
    if musicSource == .spotify, pendingSpotify == nil, !simulating,
       spotifyEverDelivered,
       Date().timeIntervalSince1970 - spotifyLastDeliveryWall >= 5,
       timerMs >= spotifyPollAtMs, !spotifyPollInFlight {
      spotifyPollAtMs = timerMs + 20_000
      spotifyPollInFlight = true
      Task { [weak self] in
        let state = await SpotifyRemote.shared.playerState()
        guard let self else { return }
        self.spotifyPollInFlight = false
        guard self.phase == .running else { return }
        if let h = self.spotifyHandoff {
          self.verifyHandoff(h, state)
          return
        }
        guard let st = state, st.isPlaying else { return }
        let adopted = self.live?.syncExternalPlayback(trackId: st.trackId, positionMs: st.progressMs, tMs: self.clockMs) ?? []
        for c in adopted { self.execute(c, timerMs: self.clockMs, confirmed: true) }
      }
    }
    landingCount = live.landings.count
  }

  /// Route one engine command to the music output. Output keys on MUSIC
  /// SOURCE, not session mode (8/27: gating on trailMode sent a LIVE run's
  /// commands to the silent owned-files deck).
  private func execute(_ c: LivePlayCommand, timerMs: Double, confirmed: Bool) {
    if suppressLoopbacks && c.reason.hasPrefix("loop back") { return }
    firedCount += 1
    lastCommand = c.reason
    guard musicSource == .spotify else {
      // Never interrupt the run: a missing file leaves current audio playing.
      // (A handoff is a plain play here — the deck crossfades into it.)
      try? deck.play(id: c.trackId, positionMs: c.positionMs, fadeSec: c.fadeSec, opts: BeatMath.deckOpts(for: c.reason))
      return
    }
    if c.handoff {
      if confirmed {
        // The read that produced this command saw the player on it — the
        // queue is empty behind it, so the next spare goes in now.
        recordDelivery(ok: true, note: "\(c.reason) · adopted")
        spotifyModelTrackId = c.trackId
        queueSpare(c.spareUri, for: c.reason)
      } else {
        // PREDICTED roll into the held spare: no play — verify the player
        // got there before touching the queue. A queue item plays before
        // any context continuation, so queueing behind the wrong song
        // leaks it into the wrong slot.
        spotifyHandoff = SpotifyHandoff(command: c, fromTrackId: spotifyModelTrackId, atMs: timerMs, tries: 0)
        spotifyPollAtMs = timerMs + 4_500 // /me/player lags reality by a few seconds
      }
      return
    }
    // A real cut: the phone conducts its Spotify app; the watchdog owns
    // delivery. The spare rides along so the runner's "next" button works
    // and the song end after this one rolls natively.
    spotifyHandoff = nil
    spotifyQueueRetry = nil
    spotifyModelTrackId = c.trackId
    var uris = [c.uri]
    if let spare = c.spareUri { uris.append(spare) }
    deliverSpotify(uris: uris, positionMs: c.positionMs, timerMs: timerMs, reason: c.reason)
  }

  /// A predicted handoff's verification read. Three outcomes besides the
  /// happy one: the player is still finishing the old song (stale read →
  /// look again; genuinely early → the model steps back), it rolled into
  /// something else (adopt it — a queue item that outlived a cut, never a
  /// skip), or it is silent/unreachable (rescue with an explicit play).
  private func verifyHandoff(_ h: SpotifyHandoff, _ state: (trackId: String, progressMs: Double, isPlaying: Bool)?) {
    let c = h.command
    if let st = state, st.isPlaying {
      if st.trackId == c.trackId {
        spotifyHandoff = nil
        spotifyModelTrackId = c.trackId
        recordDelivery(ok: true, note: "\(c.reason) · verified at \(Int(st.progressMs / 1000))s")
        _ = live?.syncExternalPlayback(trackId: st.trackId, positionMs: st.progressMs, tMs: clockMs)
        queueSpare(c.spareUri, for: c.reason)
        return
      }
      if st.trackId == h.fromTrackId {
        let dur = bundle?.tags?.first(where: { $0.trackId == st.trackId })?.durationMs ?? 0
        let remaining = dur - st.progressMs
        if remaining > 4_000 {
          spotifyHandoff = nil
          recordDelivery(ok: true, note: "\(c.reason) · early by \(Int(remaining / 1000))s — model stepped back")
          _ = live?.syncExternalPlayback(trackId: st.trackId, positionMs: st.progressMs, tMs: clockMs, natural: true)
          return
        }
        if h.tries < 3 {
          // Seconds from the end, or a stale read of it: look again.
          spotifyHandoff?.tries += 1
          spotifyPollAtMs = clockMs + 3_000
          return
        }
        // Reported at its end three reads running — stuck. Rescue below.
      } else {
        spotifyHandoff = nil
        recordDelivery(ok: true, note: "\(c.reason) · player rolled into \(st.trackId) instead — adopted")
        let adopted = live?.syncExternalPlayback(trackId: st.trackId, positionMs: st.progressMs, tMs: clockMs, natural: true) ?? []
        for cmd in adopted { execute(cmd, timerMs: clockMs, confirmed: true) }
        return
      }
    } else if h.tries < 2 {
      spotifyHandoff?.tries += 1
      spotifyPollAtMs = clockMs + 3_000
      return
    }
    // Rescue: the queue never carried the spare (a failed queue call, an
    // exhausted context) or the player is unreachable. Explicit play at the
    // modeled position — the watchdog carries it if we are offline.
    spotifyHandoff = nil
    spotifyModelTrackId = c.trackId
    recordDelivery(ok: false, note: "\(c.reason) · rescue: player \(state == nil ? "unreachable or idle" : "not playing") — issuing play")
    var uris = [c.uri]
    if let spare = c.spareUri { uris.append(spare) }
    deliverSpotify(uris: uris, positionMs: 0, timerMs: h.atMs, reason: "rescue \(c.reason)")
  }

  private func queueSpare(_ uri: String?, for reason: String) {
    guard let uri else {
      recordDelivery(ok: false, note: "\(reason) · no spare to queue")
      return
    }
    let gen = spotifyGen
    Task { [weak self] in
      let err = await SpotifyRemote.shared.queue(uri: uri)
      guard let self, self.spotifyGen == gen else { return }
      self.recordDelivery(ok: err == nil, note: err.map { "queue spare · \($0)" } ?? "queued spare")
      if err != nil { self.spotifyQueueRetry = (uri: uri, atMs: self.clockMs + 10_000) }
    }
  }

  /// Projected setlist: run the REAL engine in-memory against a
  /// representative interval workout and return what it would play — so
  /// "did it do anything?" is answered in a glance, no 40-min run, no audio
  /// (8/27: an 8× sim can't demonstrate the Spotify tier audibly). This is
  /// exactly what a real Drop-Set-shaped run would choreograph.
  struct PreviewRow: Identifiable { let id = UUID(); let atMin: Double; let reason: String }

  func previewSetlist() -> [PreviewRow] {
    guard let b = bundle, let tags = b.tags, !tags.isEmpty else { return [] }
    // A LOADED workout previews the real choreography; otherwise the
    // representative Drop Set stands in.
    let plan: [WorkoutStep] = (b.plan?.isEmpty == false) ? b.plan! : [
      WorkoutStep(kind: "warmup", seconds: nil, meters: 1200),
    ] + [1000.0, 1000, 800, 800, 600, 600, 400, 400].flatMap { m in
      [WorkoutStep(kind: "hard", seconds: nil, meters: m),
       WorkoutStep(kind: "rest", seconds: 90, meters: nil)]
    } + [WorkoutStep(kind: "cooldown", seconds: nil, meters: 1250)]
    let hrMax = UserDefaults.standard.object(forKey: "awdj.hrMax") as? Double
    let eng = LiveEngine(plan: plan, songs: tags, pairBonus: b.pairBonus ?? [:], hrMax: hrMax, streamingHandoff: musicSource == .spotify)
    var t = 0.0, d = 0.0, si = 0, stepD = 0.0
    func pace(_ k: String) -> Double { k == "hard" ? 3.6 : k == "rest" ? 1.5 : 3.1 }
    func len(_ s: WorkoutStep) -> Double { s.meters ?? ((s.seconds ?? 0) * pace(s.kind)) }
    var sec = 0
    while sec < 3600, si < plan.count {
      let s = plan[si]; t += 1000; d += pace(s.kind); stepD += pace(s.kind)
      eng.advance(LiveSample(tMs: t, distanceM: d, hr: s.kind == "hard" ? 175 : 150))
      if stepD >= len(s) { si += 1; stepD = 0 }
      sec += 1
    }
    return eng.commands.map { PreviewRow(atMin: $0.tMs / 60000, reason: $0.reason) }
  }

  // MARK: - Simulated run (no watch needed — demo + Thursday dress rehearsal)

  func startSimulatedRun(speed: Double = 8) {
    guard phase == .idle || phase == .done else { return }
    guard let b = bundle, supportsLive else {
      status = "select a playlist or library first"
      return
    }
    // Playlist libraries carry no plan (they run follow mode live). For a
    // desk dress rehearsal, drive the synthetic runner with a stand-in
    // interval plan so the whole output path — including Spotify — exercises.
    let plan = (b.plan?.isEmpty == false) ? b.plan! : [
      WorkoutStep(kind: "warmup", seconds: 120, meters: nil),
      WorkoutStep(kind: "hard", seconds: 60, meters: nil),
      WorkoutStep(kind: "rest", seconds: 60, meters: nil),
      WorkoutStep(kind: "hard", seconds: 60, meters: nil),
      WorkoutStep(kind: "rest", seconds: 60, meters: nil),
      WorkoutStep(kind: "cooldown", seconds: 120, meters: nil),
    ]
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
        advanceLive(
          timerMs: s.tMs, distanceM: s.distanceM,
          wkStepSeq: s.wkStepSeq, wkKind: s.wkKind,
          wkDurationType: s.wkDurationType, wkDurationValue: s.wkDurationValue,
          wkNextKind: s.wkNextKind
        )
        recorded.append(RecordedSample(
          t: s.tMs, d: s.distanceM, hr: nil,
          wkSeq: s.wkStepSeq, wkKind: s.wkKind,
          wkDurType: s.wkDurationType, wkDurVal: s.wkDurationValue,
          wkNextKind: s.wkNextKind
        ))
        try? await Task.sleep(nanoseconds: UInt64(1_000_000_000 / speed))
      }
      guard phase == .running else { return }
      phase = .done
      status = "simulated session complete — \(firedCount) cues · \(landingCount) landings"
      deck.stop()
      silenceSpotify()
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
    // LATE-JOIN (9/2): timerStart is one relay sample — if the phone wasn't
    // listening that exact second (app opening late, mid-update, brief
    // suspension), the whole run used to be stranded even though the relay
    // kept streaming the timer. A running watch timer with no active
    // session now joins mid-run; wkStepSeq catches the engine up. Idle
    // only: a session the user STOPPED (phase .done) never resurrects.
    if let timerMs { lastWatchTimerMs = timerMs }
    if event == nil, phase == .idle, armed, liveMode, supportsLive, !trailMode,
       let t = timerMs, t > 5_000, !isStoppedActivity(timerMs: t),
       Date().timeIntervalSince1970 * 1000 - receivedAt < 15_000 {
      startLive()
      status += " · joined mid-run"
    }
    guard let event, receivedAt != lastHandledEvent else { return }
    lastHandledEvent = receivedAt
    if event == "timerStart" { stoppedActivity = nil } // a fresh activity
    // Trail sessions are phone-clocked: a watch recording running alongside
    // must not pause/steer the music (the 8/21 conflict, finally closed).
    if trailMode { return }
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
