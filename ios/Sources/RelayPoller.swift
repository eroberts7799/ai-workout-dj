// Polls the public relay for live watch data — the phone talking to the
// watch with no Mac anywhere. The same feed the conductor will use here.
import Foundation

@MainActor
final class RelayPoller: ObservableObject {
  @Published var line = "⌚ waiting for watch…"
  @Published var fresh = false

  private let url = URL(string: "https://awdj-relay.vercel.app/api/garmin?k=awdj-7g2k9x")!
  private var task: Task<Void, Never>?

  init() {
    task = Task { [weak self] in
      while !Task.isCancelled {
        await self?.poll()
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
    }
  }

  private func poll() async {
    guard let (data, _) = try? await URLSession.shared.data(from: url),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return }
    let receivedAt = (obj["receivedAt"] as? Double) ?? 0
    let ageSec = (Date().timeIntervalSince1970 * 1000 - receivedAt) / 1000
    fresh = ageSec < 10
    if fresh {
      let hr = (obj["hr"] as? Double).map { String(Int($0)) } ?? "—"
      let timerMs = (obj["timerMs"] as? Double) ?? 0
      let dist = (obj["distance"] as? Double).map { String(format: "%.2fkm", $0 / 1000) } ?? "—"
      line = "⌚ \(hr) bpm · \(Self.clock(timerMs)) · \(dist)"
    } else {
      line = "⌚ waiting for watch…"
    }
  }

  private static func clock(_ ms: Double) -> String {
    let s = Int(ms / 1000)
    return String(format: "%d:%02d", s / 60, s % 60)
  }
}
