// Beat math — Swift port of src/conductor/beat.ts (the TS side + its tests
// stay the source of truth; this mirrors it decision-for-decision).
import Foundation

enum BeatMath {
  /// Delay (ms) to the outgoing track's next grid boundary of `beatsPerUnit`
  /// beats (1 = beat, 4 = bar). Anchored at any downbeat-snapped position.
  static func nextGridDelayMs(posMs: Double, bpm: Double?, anchorMs: Double, beatsPerUnit: Double) -> Double {
    guard let bpm, bpm > 0 else { return 0 }
    let unitMs = (60_000 / bpm) * max(1, beatsPerUnit)
    let phase = (((posMs - anchorMs).truncatingRemainder(dividingBy: unitMs)) + unitMs).truncatingRemainder(dividingBy: unitMs)
    return (phase < 1 || unitMs - phase < 1) ? 0 : unitMs - phase
  }

  /// Playback rate that tempo-locks the incoming track to the outgoing one
  /// during a blend. Clamped to ±4% (inaudible as pitch); 1 when unknown.
  static func tempoLockRate(outgoingBpm: Double?, incomingBpm: Double?) -> Double {
    guard let o = outgoingBpm, let i = incomingBpm, o > 0, i > 0 else { return 1 }
    return min(1.04, max(0.96, o / i))
  }

  /// Tempos within this ratio blend like a DJ; beyond it, cut clean.
  static let blendBpmTolerance = 0.03
  static let blendFadeSec = 2.4

  struct BlendPlan {
    let fadeSec: Double
    let bassSwap: Bool
  }

  /// Mirrors blendPlan in beat.ts: compatible tempos earn a long bass-swapped
  /// blend; drops are never stretched; short utility cuts stay short.
  static func blendPlan(requestedFadeSec: Double, outgoingBpm: Double?, incomingBpm: Double?, isDrop: Bool) -> BlendPlan {
    guard !isDrop, let o = outgoingBpm, let i = incomingBpm, o > 0, i > 0 else {
      return BlendPlan(fadeSec: requestedFadeSec, bassSwap: false)
    }
    if abs(1 - i / o) > blendBpmTolerance { return BlendPlan(fadeSec: requestedFadeSec, bassSwap: false) }
    if requestedFadeSec < 0.8 { return BlendPlan(fadeSec: requestedFadeSec, bassSwap: false) }
    return BlendPlan(fadeSec: max(requestedFadeSec, blendFadeSec), bassSwap: true)
  }

  struct DeckOpts {
    let onBeat: Bool
    let barGrid: Bool
    let tempoLock: Bool
    /// Song chains end like songs: long fade-out, then the next one enters.
    var radio: Bool = false
  }

  /// Mirrors deckOptsFor in local-deck.ts: song chains use the radio
  /// handoff; buildups cut on the beat; drops fire exact-time.
  static func deckOpts(for reason: String) -> DeckOpts {
    if reason.hasPrefix("drop lands") { return DeckOpts(onBeat: false, barGrid: false, tempoLock: false) }
    if reason.hasPrefix("loop back") { return DeckOpts(onBeat: true, barGrid: false, tempoLock: false) }
    if reason.hasPrefix("buildup") { return DeckOpts(onBeat: true, barGrid: false, tempoLock: false) }
    return DeckOpts(onBeat: false, barGrid: false, tempoLock: false, radio: true)
  }

  /// Camelot-wheel harmony (mirrors camelotCompatible in beat.ts): same
  /// number, or ±1 on the same ring. Unknown keys never block.
  static func camelotCompatible(_ a: String?, _ b: String?) -> Bool {
    guard let a, let b else { return true }
    let re = try! NSRegularExpression(pattern: "^(\\d{1,2})([ABab])$")
    func parse(_ s: String) -> (Int, String)? {
      guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
            let nr = Range(m.range(at: 1), in: s), let lr = Range(m.range(at: 2), in: s),
            let n = Int(s[nr]) else { return nil }
      return (n, s[lr].uppercased())
    }
    guard let pa = parse(a), let pb = parse(b) else { return true }
    if pa.0 == pb.0 { return true }
    let diff = min(abs(pa.0 - pb.0), 12 - abs(pa.0 - pb.0))
    return diff == 1 && pa.1 == pb.1
  }

  /// Mirrors mixScore in beat.ts: tempo within 3% = 2 pts, known-compatible
  /// keys = 1 pt.
  static func mixScore(fromBpm: Double?, fromKey: String?, toBpm: Double?, toKey: String?) -> Int {
    var s = 0
    if let f = fromBpm, let t = toBpm, f > 0, abs(1 - t / f) <= 0.03 { s += 2 }
    if fromKey != nil, toKey != nil, camelotCompatible(fromKey, toKey) { s += 1 }
    return s
  }

  /// A song's beat-grid anchor: any marker the analyzer downbeat-snapped.
  static func beatAnchorMs(markers: [Marker]) -> Double {
    markers.first(where: { $0.type == "drop" })?.ms
      ?? markers.first(where: { $0.type == "loop_start" })?.ms
      ?? 0
  }
}
