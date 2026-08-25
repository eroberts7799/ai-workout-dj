// SpotifyRemote — the phone conducts its own Spotify app via the Web API.
// A port of the web conductor's battle-tested playOnTarget semantics:
// resolve the phone's Spotify device by type/name, transfer if inactive,
// play-with-retry (device ids churn). Failures are SOFT by design: on a
// trail, airplane mode or a dead zone means the current (downloaded) track
// simply plays out and the next command lands when signal returns —
// "we'll just stop the music" is the agreed behavior. Recording never
// depends on any of this.

import Foundation

final class SpotifyRemote {
  static let shared = SpotifyRemote()
  private var deviceId: String?

  private func api(_ path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> (Int, Data) {
    let token = try await SpotifyAuth.shared.accessToken()
    var req = URLRequest(url: URL(string: "https://api.spotify.com/v1\(path)")!, timeoutInterval: 4)
    req.httpMethod = method
    req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    if let json {
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = try JSONSerialization.data(withJSONObject: json)
    }
    let (data, resp) = try await URLSession.shared.data(for: req)
    return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
  }

  /// This phone's Spotify app, by device type (the web port resolved by
  /// name; on the phone itself, the Smartphone-type device IS us).
  private func resolveDevice(force: Bool) async throws -> String {
    if let deviceId, !force { return deviceId }
    let (code, data) = try await api("/me/player/devices")
    guard code == 200 else { throw NSError(domain: "awdj", code: code) }
    struct Devices: Decodable {
      struct D: Decodable {
        let id: String?
        let type: String
        let is_active: Bool
        let name: String
      }
      let devices: [D]
    }
    let list = try JSONDecoder().decode(Devices.self, from: data).devices
    let phone = list.first(where: { $0.type == "Smartphone" && $0.is_active })
      ?? list.first(where: { $0.type == "Smartphone" })
      ?? list.first(where: { $0.is_active })
    guard let id = phone?.id else {
      throw NSError(domain: "awdj", code: 404, userInfo: [NSLocalizedDescriptionKey: "open Spotify and press play once — no device visible"])
    }
    deviceId = id
    return id
  }

  /// Play tracks from positionMs on this phone's Spotify. Soft-fails.
  /// A second uri in the list is the engine's spare: it gives the runner's
  /// "next" button somewhere real to land (a single-uri context made next
  /// RESTART the song — 8/25 easy run).
  func play(uris: [String], positionMs: Double) async -> String? {
    do {
      var id = try await resolveDevice(force: false)
      var (code, _) = try await api(
        "/me/player/play?device_id=\(id)", method: "PUT",
        json: ["uris": uris, "position_ms": Int(max(0, positionMs))]
      )
      if code == 404 || code == 403 {
        // Device id churned or went inactive — re-resolve, transfer, retry.
        id = try await resolveDevice(force: true)
        _ = try await api("/me/player", method: "PUT", json: ["device_ids": [id], "play": false])
        (code, _) = try await api(
          "/me/player/play?device_id=\(id)", method: "PUT",
          json: ["uris": uris, "position_ms": Int(max(0, positionMs))]
        )
      }
      return (200...299).contains(code) ? nil : "spotify HTTP \(code)"
    } catch {
      return "spotify offline (\((error as NSError).code)) — music pauses at song end"
    }
  }

  /// What is ACTUALLY playing — the reconciliation read that lets the
  /// engine notice manual skips. nil when unknown (offline, nothing playing).
  func playerState() async -> (trackId: String, progressMs: Double, isPlaying: Bool)? {
    do {
      let (code, data) = try await api("/me/player")
      guard code == 200 else { return nil } // 204 = nothing playing
      struct State: Decodable {
        struct Item: Decodable { let id: String? }
        let item: Item?
        let progress_ms: Double?
        let is_playing: Bool?
      }
      let s = try JSONDecoder().decode(State.self, from: data)
      guard let id = s.item?.id else { return nil }
      return (trackId: id, progressMs: s.progress_ms ?? 0, isPlaying: s.is_playing ?? false)
    } catch {
      return nil
    }
  }

  func pause() async {
    _ = try? await api("/me/player/pause", method: "PUT")
  }
}
