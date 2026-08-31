// Spotify auth on the phone — PKCE via ASWebAuthenticationSession, the same
// flow the web app uses, redirecting to awdj://spotify-callback (registered
// in the Spotify dashboard 2026-08-21). Client IDs are not secrets; the id
// is entered once and kept in UserDefaults, tokens too (refresh included).

import AuthenticationServices
import CryptoKit
import Foundation

final class SpotifyAuth: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = SpotifyAuth()
  private static let redirect = "awdj://spotify-callback"
  // Playback control + the library surfaces: Liked Songs and the user's OWN
  // playlists (the post-migration /items endpoint serves only your own —
  // which is exactly the product's ask). Scope additions need one re-login.
  private static let scopes = "user-modify-playback-state user-read-playback-state user-library-read playlist-read-private playlist-read-collaborative user-top-read user-read-recently-played"

  // Connected only counts if the stored token was minted with the CURRENT
  // scope set — a scope addition (e.g. playlist reads) silently 403s on old
  // tokens, so stale-scope tokens read as disconnected and prompt a re-login.
  @Published var connected =
    UserDefaults.standard.string(forKey: "awdj.spotify.refresh") != nil
    && UserDefaults.standard.string(forKey: "awdj.spotify.scopes") == SpotifyAuth.scopes

  var clientId: String? {
    get { UserDefaults.standard.string(forKey: "awdj.spotify.clientId") }
    set { UserDefaults.standard.set(newValue, forKey: "awdj.spotify.clientId") }
  }

  // MARK: - PKCE login

  func login(onDone: @escaping (String?) -> Void) {
    guard let clientId, !clientId.isEmpty else {
      onDone("enter your Spotify Client ID first")
      return
    }
    let verifier = Self.randomString(64)
    let challenge = Self.base64url(SHA256.hash(data: Data(verifier.utf8)))
    var comps = URLComponents(string: "https://accounts.spotify.com/authorize")!
    comps.queryItems = [
      .init(name: "client_id", value: clientId),
      .init(name: "response_type", value: "code"),
      .init(name: "redirect_uri", value: Self.redirect),
      .init(name: "code_challenge_method", value: "S256"),
      .init(name: "code_challenge", value: challenge),
      .init(name: "scope", value: Self.scopes),
    ]
    let session = ASWebAuthenticationSession(url: comps.url!, callbackURLScheme: "awdj") { [weak self] url, err in
      guard let self else { return }
      guard err == nil, let url, let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
        .queryItems?.first(where: { $0.name == "code" })?.value
      else {
        onDone("login cancelled or failed")
        return
      }
      Task {
        do {
          try await self.exchange(code: code, verifier: verifier, clientId: clientId)
          UserDefaults.standard.set(Self.scopes, forKey: "awdj.spotify.scopes")
          await MainActor.run {
            self.connected = true
            onDone(nil)
          }
        } catch {
          await MainActor.run { onDone("token exchange failed: \(error.localizedDescription)") }
        }
      }
    }
    session.presentationContextProvider = self
    session.prefersEphemeralWebBrowserSession = false
    session.start()
  }

  private func exchange(code: String, verifier: String, clientId: String) async throws {
    let body = [
      "grant_type=authorization_code",
      "code=\(code)",
      "redirect_uri=\(Self.redirect.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? Self.redirect)",
      "client_id=\(clientId)",
      "code_verifier=\(verifier)",
    ].joined(separator: "&")
    try await tokenRequest(body: body)
  }

  /// In-flight refresh, shared by every caller that hits the expiry window.
  @MainActor private var refreshTask: Task<String, Error>?

  /// Bearer token for API calls, refreshing when stale. The refresh is
  /// SINGLE-FLIGHT: Spotify's PKCE refresh tokens rotate on use, and two
  /// concurrent refreshes (watchdog + reconciliation poll hitting the hourly
  /// expiry together) would both spend the same token — Spotify's reuse
  /// detection can revoke the whole grant, disconnecting mid-run.
  @MainActor func accessToken() async throws -> String {
    let d = UserDefaults.standard
    if let tok = d.string(forKey: "awdj.spotify.access"),
       d.double(forKey: "awdj.spotify.expiresAt") > Date().timeIntervalSince1970 + 60 {
      return tok
    }
    if let inflight = refreshTask { return try await inflight.value }
    guard let refresh = d.string(forKey: "awdj.spotify.refresh"), let clientId else {
      throw NSError(domain: "awdj", code: 401, userInfo: [NSLocalizedDescriptionKey: "not connected to Spotify"])
    }
    let task = Task<String, Error> {
      try await self.tokenRequest(body: "grant_type=refresh_token&refresh_token=\(refresh)&client_id=\(clientId)")
      guard let fresh = d.string(forKey: "awdj.spotify.access") else {
        throw NSError(domain: "awdj", code: 401, userInfo: [NSLocalizedDescriptionKey: "refresh produced no token"])
      }
      return fresh
    }
    refreshTask = task
    defer { refreshTask = nil }
    return try await task.value
  }

  private func tokenRequest(body: String) async throws {
    var req = URLRequest(url: URL(string: "https://accounts.spotify.com/api/token")!)
    req.httpMethod = "POST"
    req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    req.httpBody = Data(body.utf8)
    let (data, resp) = try await URLSession.shared.data(for: req)
    guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
      throw NSError(domain: "awdj", code: (resp as? HTTPURLResponse)?.statusCode ?? 0,
                    userInfo: [NSLocalizedDescriptionKey: String(data: data, encoding: .utf8) ?? "token error"])
    }
    struct Tok: Decodable {
      let access_token: String
      let refresh_token: String?
      let expires_in: Double
    }
    let tok = try JSONDecoder().decode(Tok.self, from: data)
    let d = UserDefaults.standard
    d.set(tok.access_token, forKey: "awdj.spotify.access")
    if let r = tok.refresh_token { d.set(r, forKey: "awdj.spotify.refresh") }
    d.set(Date().timeIntervalSince1970 + tok.expires_in, forKey: "awdj.spotify.expiresAt")
  }

  // MARK: - plumbing

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    ASPresentationAnchor()
  }

  private static func randomString(_ n: Int) -> String {
    let chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    return String((0..<n).map { _ in chars.randomElement()! })
  }

  private static func base64url<D: Digest>(_ digest: D) -> String {
    Data(digest).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
