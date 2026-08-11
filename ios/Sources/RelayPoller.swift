// Polls the public relay for live watch data — the phone talking to the
// watch with no Mac anywhere. Feeds both the UI line and the SessionEngine.
import Foundation

struct GarminSample {
  let hr: Double?
  let timerMs: Double?
  let distanceM: Double?
  let event: String?
  let receivedAt: Double
}

@MainActor
final class RelayPoller: ObservableObject {
  @Published var line = "⌚ waiting for watch…"
  @Published var fresh = false

  /// Set by the session screen; called on every fresh sample.
  var onSample: ((GarminSample) -> Void)?

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
    guard fresh else {
      line = "⌚ waiting for watch…"
      return
    }
    let sample = GarminSample(
      hr: obj["hr"] as? Double,
      timerMs: obj["timerMs"] as? Double,
      distanceM: obj["distance"] as? Double,
      event: obj["event"] as? String,
      receivedAt: receivedAt
    )
    let hr = sample.hr.map { String(Int($0)) } ?? "—"
    let dist = sample.distanceM.map { String(format: "%.2fkm", $0 / 1000) } ?? "—"
    line = "⌚ \(hr) bpm · \(Self.clock(sample.timerMs ?? 0)) · \(dist)"
    onSample?(sample)
  }

  static func clock(_ ms: Double) -> String {
    let s = Int(ms / 1000)
    return String(format: "%d:%02d", s / 60, s % 60)
  }
}
