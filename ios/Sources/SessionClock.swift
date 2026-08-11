// Pausable workout clock + cue dispatch — direct port of the tested
// TypeScript runner (src/conduct/runner.ts).
import Foundation

final class SessionClock {
  private let now: () -> Double
  private var startedAt: Double?
  private var pausedAt: Double?
  private var pausedTotal: Double = 0

  init(now: @escaping () -> Double = { Date().timeIntervalSince1970 * 1000 }) {
    self.now = now
  }

  func start() {
    startedAt = now()
    pausedAt = nil
    pausedTotal = 0
  }

  func pause() {
    if startedAt != nil && pausedAt == nil { pausedAt = now() }
  }

  func resume() {
    if let p = pausedAt {
      pausedTotal += now() - p
      pausedAt = nil
    }
  }

  var running: Bool { startedAt != nil && pausedAt == nil }

  func seek(to ms: Double) {
    let n = now()
    startedAt = n - ms
    pausedTotal = 0
    if pausedAt != nil { pausedAt = n }
  }

  func nowMs() -> Double {
    guard let s = startedAt else { return 0 }
    return (pausedAt ?? now()) - s - pausedTotal
  }
}

/// Cues whose fire time falls in (prevMs, nowMs]. Each fires exactly once.
func dueCues(_ cues: [Cue], prevMs: Double, nowMs: Double, leadMs: Double) -> [Cue] {
  cues.filter { c in
    let fireAt = c.atMs - leadMs
    return fireAt > prevMs && fireAt <= nowMs
  }
}
