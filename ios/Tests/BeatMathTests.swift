// Port-parity tests for BeatMath — mirrors src/conductor/beat.test.ts.
import XCTest
@testable import AwdjPlayer

final class BeatMathTests: XCTestCase {
  func testNextGridDelayBarBoundaries() {
    // 120bpm → 500ms beats, 2000ms bars, anchor 30_000.
    XCTAssertEqual(BeatMath.nextGridDelayMs(posMs: 30_500, bpm: 120, anchorMs: 30_000, beatsPerUnit: 4), 1500, accuracy: 1e-6)
    XCTAssertEqual(BeatMath.nextGridDelayMs(posMs: 30_000 + 3 * 2000, bpm: 120, anchorMs: 30_000, beatsPerUnit: 4), 0)
    // Mid-beat on the 1-beat grid.
    XCTAssertEqual(BeatMath.nextGridDelayMs(posMs: 30_200, bpm: 120, anchorMs: 30_000, beatsPerUnit: 1), 300, accuracy: 1e-6)
    // Positions before the anchor phase correctly; no bpm → cut now.
    XCTAssertEqual(BeatMath.nextGridDelayMs(posMs: 29_600, bpm: 120, anchorMs: 30_000, beatsPerUnit: 1), 400, accuracy: 1e-6)
    XCTAssertEqual(BeatMath.nextGridDelayMs(posMs: 1234, bpm: nil, anchorMs: 0, beatsPerUnit: 1), 0)
  }

  func testTempoLockRate() {
    XCTAssertEqual(BeatMath.tempoLockRate(outgoingBpm: 136, incomingBpm: 140), 136.0 / 140.0, accuracy: 1e-9)
    XCTAssertEqual(BeatMath.tempoLockRate(outgoingBpm: 120, incomingBpm: 140), 0.96) // clamped
    XCTAssertEqual(BeatMath.tempoLockRate(outgoingBpm: nil, incomingBpm: 140), 1)
  }

  func testBlendPlan() {
    let blend = BeatMath.blendPlan(requestedFadeSec: 1.2, outgoingBpm: 124, incomingBpm: 126, isDrop: false)
    XCTAssertEqual(blend.fadeSec, 2.4)
    XCTAssertTrue(blend.bassSwap)
    let clash = BeatMath.blendPlan(requestedFadeSec: 1.2, outgoingBpm: 124, incomingBpm: 90, isDrop: false)
    XCTAssertEqual(clash.fadeSec, 1.2)
    XCTAssertFalse(clash.bassSwap)
    let drop = BeatMath.blendPlan(requestedFadeSec: 0.45, outgoingBpm: 124, incomingBpm: 125, isDrop: true)
    XCTAssertFalse(drop.bassSwap)
    let loopback = BeatMath.blendPlan(requestedFadeSec: 0.25, outgoingBpm: 124, incomingBpm: 124, isDrop: false)
    XCTAssertEqual(loopback.fadeSec, 0.25)
    XCTAssertFalse(loopback.bassSwap)
  }

  func testDeckOptsMapping() {
    XCTAssertFalse(BeatMath.deckOpts(for: "drop lands (crest reward) (X)").onBeat)
    let loop = BeatMath.deckOpts(for: "loop back (X)")
    XCTAssertTrue(loop.onBeat)
    XCTAssertFalse(loop.barGrid)
    // Song chains use the radio handoff — the song ENDS, then the next
    // begins (DJ blend machinery parked until the craft earns it back).
    let fill = BeatMath.deckOpts(for: "groove fill (X)")
    XCTAssertTrue(fill.radio)
    XCTAssertFalse(fill.tempoLock)
    XCTAssertFalse(BeatMath.deckOpts(for: "buildup toward next rep (X)").radio)
    XCTAssertFalse(BeatMath.deckOpts(for: "drop lands (opening) (X)").radio)
    XCTAssertFalse(BeatMath.deckOpts(for: "buildup toward the effort (X)").barGrid)
  }

  func testBeatAnchorPrefersDrop() {
    let markers = [Marker(type: "loop_start", ms: 30_000), Marker(type: "drop", ms: 95_000)]
    XCTAssertEqual(BeatMath.beatAnchorMs(markers: markers), 95_000)
    XCTAssertEqual(BeatMath.beatAnchorMs(markers: [Marker(type: "loop_start", ms: 30_000)]), 30_000)
    XCTAssertEqual(BeatMath.beatAnchorMs(markers: []), 0)
  }
}
