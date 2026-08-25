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

  private static let tagTable: [String: [String: Double?]] = {
    guard let url = Bundle.main.url(forResource: "track-tags", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
    var out: [String: [String: Double?]] = [:]
    for (k, v) in raw {
      out[k] = ["bpm": v["bpm"] as? Double, "energy": v["energy"] as? Double]
    }
    return out
  }()

  private static let camelotTable: [String: String] = {
    guard let url = Bundle.main.url(forResource: "track-tags", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
    var out: [String: String] = [:]
    for (k, v) in raw {
      if let c = v["camelot"] as? String { out[k] = c }
    }
    return out
  }()

  static func enrich(artist: String, title: String) -> (bpm: Double?, camelot: String?) {
    let key = "\(norm(artist))|\(norm(title))"
    return (tagTable[key]?["bpm"] ?? nil, camelotTable[key])
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
                        bpm: e.bpm, camelot: e.camelot, markers: [])
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
                              durationMs: t.duration_ms, bpm: e.bpm, camelot: e.camelot, markers: []))
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
}
