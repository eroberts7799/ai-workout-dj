// In-app music sources for the streaming tier — no Mac in the loop.
// Two doors: any public playlist by link (the embed page carries its first
// 100 tracks in __NEXT_DATA__; native apps have no CORS wall, so the phone
// scrapes it directly — the Web API's playlist reads are a permanent 403
// for dev-mode apps), and Liked Songs via the real API (the one personal
// endpoint that works). Imported tracks are enriched from the bundled
// track-tags table (crate analysis + virtual-crate preview tags, matched
// by exact normalized artist|title — rule 4: a dropped match beats a
// wrong one) so the picker has BPM/key to work with instead of shuffling.

import Foundation

enum SpotifyLibrary {

  // Mirrors the analysis pipeline's norm(): strip edition suffixes and
  // features, collapse to lowercase alphanumerics.
  static func norm(_ s: String) -> String {
    var t = s.lowercased()
    t = t.replacingOccurrences(of: #"\((?:extended|original|club|radio)[^)]*\)"#, with: "", options: .regularExpression)
    t = t.replacingOccurrences(of: #"\s*(?:feat|ft)\.?\s.*"#, with: "", options: .regularExpression)
    t = t.replacingOccurrences(of: #"[^a-z0-9]+"#, with: " ", options: .regularExpression)
    return t.trimmingCharacters(in: .whitespaces)
  }

  // The tag table refreshes from the cloud (stable relay URL) so tagging
  // runs on the Mac reach every phone at next app-open — no app updates.
  // Load order: Documents cache (newest fetched) → bundled fallback.
  private static let tableURL = URL(string: "https://awdj-relay.vercel.app/api/track-tags")!
  private static var cachePath: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("track-tags.json")
  }

  private static var tables: (tags: [String: (bpm: Double?, energy: Double?)], camelot: [String: String]) = loadTables()

  private static func loadTables() -> (tags: [String: (bpm: Double?, energy: Double?)], camelot: [String: String]) {
    let data = (try? Data(contentsOf: cachePath))
      ?? Bundle.main.url(forResource: "track-tags", withExtension: "json").flatMap { try? Data(contentsOf: $0) }
    guard let data, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else {
      return ([:], [:])
    }
    var tags: [String: (bpm: Double?, energy: Double?)] = [:]
    var cam: [String: String] = [:]
    for (k, v) in raw {
      tags[k] = (v["bpm"] as? Double, v["energy"] as? Double)
      if let c = v["camelot"] as? String { cam[k] = c }
    }
    return (tags, cam)
  }

  // Per-user taste bonus (−2..+2), keyed/private. Loaded like the tag table.
  private static let tasteURL = URL(string: "https://awdj-relay.vercel.app/api/taste?k=awdj-7g2k9x")!
  private static var tasteCachePath: URL {
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("taste-bonus.json")
  }
  private static var taste: [String: Double] = loadTaste()

  private static func loadTaste() -> [String: Double] {
    guard let data = try? Data(contentsOf: tasteCachePath),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Double] else { return [:] }
    return raw
  }

  @MainActor
  static func refreshTagTable() async {
    if let (data, resp) = try? await URLSession.shared.data(from: tableURL),
       (resp as? HTTPURLResponse)?.statusCode == 200,
       (try? JSONSerialization.jsonObject(with: data)) != nil {
      try? data.write(to: cachePath)
      tables = loadTables()
    }
    if let (data, resp) = try? await URLSession.shared.data(from: tasteURL),
       (resp as? HTTPURLResponse)?.statusCode == 200,
       (try? JSONSerialization.jsonObject(with: data)) != nil {
      try? data.write(to: tasteCachePath)
      taste = loadTaste()
    }
  }

  static func enrich(artist: String, title: String) -> (bpm: Double?, camelot: String?, affinity: Double?) {
    let key = "\(norm(artist))|\(norm(title))"
    return (tables.tags[key]?.bpm ?? nil, tables.camelot[key], taste[key])
  }

  /// Public playlist by link → (name, tags). Nil on any failure — the
  /// status line says why via the thrown description.
  static func scrapePlaylist(link: String) async throws -> (name: String, tags: [TaggedSong]) {
    guard let id = link.range(of: #"playlist[/:]([A-Za-z0-9]+)"#, options: .regularExpression)
      .map({ String(link[$0]).replacingOccurrences(of: #"playlist[/:]"#, with: "", options: .regularExpression) })
    else { throw err("that doesn't look like a playlist link") }
    guard let url = URL(string: "https://open.spotify.com/embed/playlist/\(id)") else { throw err("bad link") }
    var req = URLRequest(url: url, timeoutInterval: 15)
    req.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", forHTTPHeaderField: "User-Agent")
    let (data, _) = try await URLSession.shared.data(for: req)
    guard let html = String(data: data, encoding: .utf8),
          let m = html.range(of: #"<script id="__NEXT_DATA__" type="application/json">"#),
          let end = html.range(of: "</script>", range: m.upperBound..<html.endIndex)
    else { throw err("embed page had no data — private playlist?") }
    let blob = Data(html[m.upperBound..<end.lowerBound].utf8)
    guard let root = try JSONSerialization.jsonObject(with: blob) as? [String: Any],
          let entity = (((root["props"] as? [String: Any])?["pageProps"] as? [String: Any])?["state"] as? [String: Any])
            .flatMap({ ($0["data"] as? [String: Any])?["entity"] as? [String: Any] }),
          let list = entity["trackList"] as? [[String: Any]]
    else { throw err("embed data had no track list") }
    let name = entity["name"] as? String ?? "playlist"
    let tags = list.compactMap { t -> TaggedSong? in
      guard let uri = t["uri"] as? String, uri.hasPrefix("spotify:track:") else { return nil }
      let trackId = String(uri.dropFirst("spotify:track:".count))
      let title = t["title"] as? String ?? ""
      let artists = (t["subtitle"] as? String ?? "").replacingOccurrences(of: "\u{00a0}", with: " ")
      let e = enrich(artist: artists, title: title)
      return TaggedSong(trackId: trackId, uri: uri, name: title, artists: artists,
                        durationMs: t["duration"] as? Double ?? 0,
                        bpm: e.bpm, camelot: e.camelot, markers: [], affinity: e.affinity)
    }
    guard !tags.isEmpty else { throw err("no playable tracks in that playlist") }
    return (name, tags)
  }

  /// Liked Songs via the API (user-library-read; the account is already
  /// connected for playback). Capped pages — a 4,000-song library would
  /// blow the session bundle; 500 newest is a real music universe.
  static func likedSongs(cap: Int = 500) async throws -> [TaggedSong] {
    var out: [TaggedSong] = []
    var offset = 0
    while out.count < cap {
      let token = try await SpotifyAuth.shared.accessToken()
      var req = URLRequest(url: URL(string: "https://api.spotify.com/v1/me/tracks?limit=50&offset=\(offset)")!, timeoutInterval: 15)
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (data, resp) = try await URLSession.shared.data(for: req)
      guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
        throw err("Liked Songs HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0) — reconnect Spotify (needs user-library-read)")
      }
      struct Page: Decodable {
        struct Item: Decodable { let track: Track? }
        struct Track: Decodable { let id: String?; let uri: String; let name: String; let duration_ms: Double; let artists: [Artist] }
        struct Artist: Decodable { let name: String }
        let items: [Item]
        let total: Int
      }
      let page = try JSONDecoder().decode(Page.self, from: data)
      for it in page.items {
        guard let t = it.track, let id = t.id else { continue }
        let artists = t.artists.map { $0.name }.joined(separator: ", ")
        let e = enrich(artist: artists, title: t.name)
        out.append(TaggedSong(trackId: id, uri: t.uri, name: t.name, artists: artists,
                              durationMs: t.duration_ms, bpm: e.bpm, camelot: e.camelot, markers: [], affinity: e.affinity))
      }
      offset += 50
      if offset >= page.total { break }
    }
    guard !out.isEmpty else { throw err("no Liked Songs found") }
    return out
  }

  private static func err(_ s: String) -> NSError {
    NSError(domain: "awdj", code: 1, userInfo: [NSLocalizedDescriptionKey: s])
  }

  // MARK: - Taste capture (the flywheel's preference intake)

  /// Personalization endpoints may or may not have survived the purge —
  /// probe them, capture whatever answers, ship it to the relay. Runs at
  /// most daily. Failures are silent: taste capture must never bother the
  /// runner.
  static func captureTasteSnapshot() async {
    let d = UserDefaults.standard
    let last = d.double(forKey: "awdj.tasteSnapshotAt")
    guard Date().timeIntervalSince1970 - last > 86_400 else { return }
    guard let token = try? await SpotifyAuth.shared.accessToken() else { return }
    var snapshot: [String: Any] = ["name": "taste-snapshot", "source": "taste"]
    var gotAny = false
    for range in ["short_term", "medium_term", "long_term"] {
      if let items = await fetchItems(token: token, path: "/me/top/tracks?time_range=\(range)&limit=50") {
        snapshot["top_\(range)"] = items
        gotAny = true
      }
    }
    if let recent = await fetchItems(token: token, path: "/me/player/recently-played?limit=50") {
      snapshot["recentlyPlayed"] = recent
      gotAny = true
    }
    guard gotAny, let body = try? JSONSerialization.data(withJSONObject: snapshot) else { return }
    var req = URLRequest(url: URL(string: "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x")!, timeoutInterval: 20)
    req.httpMethod = "POST"
    req.httpBody = body
    if let (_, resp) = try? await URLSession.shared.data(for: req),
       (resp as? HTTPURLResponse)?.statusCode == 201 {
      d.set(Date().timeIntervalSince1970, forKey: "awdj.tasteSnapshotAt")
    }
  }

  private static func fetchItems(token: String, path: String) async -> [[String: Any]]? {
    var req = URLRequest(url: URL(string: "https://api.spotify.com/v1\(path)")!, timeoutInterval: 15)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    guard let (data, resp) = try? await URLSession.shared.data(for: req),
          (resp as? HTTPURLResponse)?.statusCode == 200,
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let items = root["items"] as? [[String: Any]] else { return nil }
    // Lean records only — ids, names, artists, played_at when present.
    return items.compactMap { it in
      let t = (it["track"] as? [String: Any]) ?? it
      guard let id = t["id"] as? String else { return nil }
      var rec: [String: Any] = ["id": id, "name": t["name"] as? String ?? ""]
      rec["artists"] = ((t["artists"] as? [[String: Any]]) ?? []).compactMap { $0["name"] as? String }.joined(separator: ", ")
      if let p = it["played_at"] as? String { rec["playedAt"] = p }
      return rec
    }
  }

  // MARK: - The user's own playlists (post-migration API)

  struct PlaylistRef: Identifiable {
    let id: String
    let name: String
    let trackCount: Int
  }

  /// GET /me/playlists — survived the Feb 2026 migration (verified against
  /// migration reports; the legacy /playlists/{id}/tracks did not).
  static func myPlaylists() async throws -> [PlaylistRef] {
    let token = try await SpotifyAuth.shared.accessToken()
    var req = URLRequest(url: URL(string: "https://api.spotify.com/v1/me/playlists?limit=50")!, timeoutInterval: 15)
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
      throw err("playlists HTTP \((resp as? HTTPURLResponse)?.statusCode ?? 0) — reconnect Spotify (new scopes)")
    }
    struct Page: Decodable {
      struct Item: Decodable {
        struct Tracks: Decodable { let total: Int? }
        let id: String?
        let name: String?
        let tracks: Tracks?
      }
      let items: [Item]
    }
    let page = try JSONDecoder().decode(Page.self, from: data)
    return page.items.compactMap { p in
      guard let id = p.id, let name = p.name else { return nil }
      return PlaylistRef(id: id, name: name, trackCount: p.tracks?.total ?? 0)
    }
  }

  /// Tracks of one of MY playlists via the migrated /items endpoint —
  /// full pagination, private playlists included. Falls back to the embed
  /// scrape (public-only, first 100) if the API answers 403/404, so other
  /// people's playlists and future purges both stay survivable.
  static func playlistTracks(id: String, name: String) async throws -> (name: String, tags: [TaggedSong]) {
    var out: [TaggedSong] = []
    var offset = 0
    while out.count < 1000 {
      let token = try await SpotifyAuth.shared.accessToken()
      var req = URLRequest(url: URL(string: "https://api.spotify.com/v1/playlists/\(id)/items?limit=50&offset=\(offset)")!, timeoutInterval: 15)
      req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
      let (data, resp) = try await URLSession.shared.data(for: req)
      let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
      if code == 403 || code == 404 {
        // Not ours / endpoint gone — the embed scrape is the survivor path.
        return try await scrapePlaylist(link: "https://open.spotify.com/playlist/\(id)")
      }
      guard code == 200,
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let items = root["items"] as? [[String: Any]]
      else { throw err("playlist items HTTP \(code)") }
      for it in items {
        // Migrated schema defensiveness: the payload may sit under
        // "track", "item", or be the object itself.
        let t = (it["track"] as? [String: Any]) ?? (it["item"] as? [String: Any]) ?? it
        guard let trackId = t["id"] as? String,
              let uri = t["uri"] as? String, uri.hasPrefix("spotify:track:"),
              let title = t["name"] as? String else { continue }
        let artists = ((t["artists"] as? [[String: Any]]) ?? [])
          .compactMap { $0["name"] as? String }.joined(separator: ", ")
        let e = enrich(artist: artists, title: title)
        out.append(TaggedSong(trackId: trackId, uri: uri, name: title, artists: artists,
                              durationMs: t["duration_ms"] as? Double ?? 0,
                              bpm: e.bpm, camelot: e.camelot, markers: [], affinity: e.affinity))
      }
      let total = root["total"] as? Int ?? out.count
      offset += 50
      if offset >= total || items.isEmpty { break }
    }
    guard !out.isEmpty else { throw err("no playable tracks in \(name)") }
    return (name, out)
  }
}
