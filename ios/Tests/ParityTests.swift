// Cross-platform parity guard. The TS engine generates parity-fixture.json
// (bun scripts/gen-parity-fixture.ts); this suite replays every case against
// the Swift port. If the two brains drift, this goes red — no more field
// failures from a stale port (see: the 2026-08-13 morning run).
import XCTest
@testable import AwdjPlayer

final class ParityTests: XCTestCase {
  private func fixture() throws -> [String: Any] {
    guard let url = Bundle(for: Self.self).url(forResource: "parity-fixture", withExtension: "json") else {
      XCTFail("parity-fixture.json missing from test bundle — regenerate with `bun scripts/gen-parity-fixture.ts` and rerun xcodegen")
      return [:]
    }
    let data = try Data(contentsOf: url)
    return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
  }

  private func dbl(_ v: Any?) -> Double? {
    if let d = v as? Double { return d }
    if let i = v as? Int { return Double(i) }
    return nil
  }

  func testGridDelayParity() throws {
    for c in try fixture()["gridCases"] as? [[String: Any]] ?? [] {
      let got = BeatMath.nextGridDelayMs(posMs: dbl(c["posMs"])!, bpm: dbl(c["bpm"]), anchorMs: dbl(c["anchorMs"])!, beatsPerUnit: dbl(c["beatsPerUnit"])!)
      XCTAssertEqual(got, dbl(c["expect"])!, accuracy: 0.001, "grid case \(c)")
    }
  }

  func testTempoLockParity() throws {
    for c in try fixture()["rateCases"] as? [[String: Any]] ?? [] {
      let got = BeatMath.tempoLockRate(outgoingBpm: dbl(c["out"]), incomingBpm: dbl(c["inn"]))
      XCTAssertEqual(got, dbl(c["expect"])!, accuracy: 1e-9, "rate case \(c)")
    }
  }

  func testBlendPlanParity() throws {
    for c in try fixture()["blendCases"] as? [[String: Any]] ?? [] {
      let expect = c["expect"] as! [String: Any]
      let got = BeatMath.blendPlan(requestedFadeSec: dbl(c["fade"])!, outgoingBpm: dbl(c["out"]), incomingBpm: dbl(c["inn"]), isDrop: c["isDrop"] as! Bool)
      XCTAssertEqual(got.fadeSec, dbl(expect["fadeSec"])!, accuracy: 1e-9, "blend case \(c)")
      XCTAssertEqual(got.bassSwap, expect["bassSwap"] as! Bool, "blend case \(c)")
    }
  }

  func testCamelotParity() throws {
    for c in try fixture()["camelotCases"] as? [[String: Any]] ?? [] {
      let got = BeatMath.camelotCompatible(c["a"] as? String, c["b"] as? String)
      XCTAssertEqual(got, c["expect"] as! Bool, "camelot case \(c)")
    }
  }

  func testMixScoreParity() throws {
    for c in try fixture()["mixScoreCases"] as? [[String: Any]] ?? [] {
      let f = c["f"] as! [String: Any]
      let t = c["t"] as! [String: Any]
      let got = BeatMath.mixScore(fromBpm: dbl(f["bpm"]), fromKey: f["camelot"] as? String, toBpm: dbl(t["bpm"]), toKey: t["camelot"] as? String)
      XCTAssertEqual(got, c["expect"] as! Int, "mixScore case \(c)")
    }
  }

  func testEngineConstantsParity() throws {
    let k = try fixture()["constants"] as? [String: Any] ?? [:]
    XCTAssertEqual(dbl(k["maxFillRideMs"])!, 180_000, "maxFillRideMs drifted — update LiveEngine.swift or regenerate fixture")
    XCTAssertEqual(dbl(k["defaultHrMax"])!, 190)
    XCTAssertEqual(dbl(k["bassHz"])!, 180)
    XCTAssertEqual(dbl(k["bassCutDb"])!, -15)
    // Not yet ported to Swift (tracked parity debt, ios/PARITY.md):
    // minClimbGainM, crestMinEtaMs, crestRideMs — assert here when ported.
  }
}
