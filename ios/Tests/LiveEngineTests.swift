// Port-parity tests for the Swift LiveEngine — the same invariants the
// TypeScript engine proves in src/live/live-engine.test.ts. If these hold,
// the phone conducts like the browser does.
import XCTest
@testable import AwdjPlayer

private func song(_ id: String) -> TaggedSong {
  TaggedSong(
    trackId: id,
    uri: "spotify:track:\(id)",
    name: "Song \(id)",
    artists: "Test",
    durationMs: 240_000,
    bpm: 128,
    camelot: nil,
    markers: [
      Marker(type: "loop_start", ms: 30_000),
      Marker(type: "loop_end", ms: 60_000),
      Marker(type: "buildup", ms: 75_000),
      Marker(type: "drop", ms: 95_000),
    ]
  )
}

private let songs = [song("aaa"), song("bbb"), song("ccc")]

/// 1Hz sample stream over piecewise-constant speeds.
private func stream(_ phases: [(seconds: Int, mps: Double)]) -> [LiveSample] {
  var out: [LiveSample] = []
  var t: Double = 0
  var d: Double = 0
  for p in phases {
    for _ in 0..<p.seconds {
      t += 1000
      d += p.mps
      out.append(LiveSample(tMs: t, distanceM: d))
    }
  }
  return out
}

/// Distance plan: 1min warmup, 1km easy, 400m hard, then easy.
private let plan: [WorkoutStep] = [
  WorkoutStep(kind: "warmup", seconds: 60, meters: nil),
  WorkoutStep(kind: "easy", seconds: nil, meters: 1000),
  WorkoutStep(kind: "hard", seconds: nil, meters: 400),
  WorkoutStep(kind: "easy", seconds: nil, meters: 600),
]

final class LiveEngineTests: XCTestCase {
  func testConstantPaceDropLandsWithin1500ms() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(700, 3)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 1500)
    XCTAssertTrue(engine.commands.contains { $0.reason.hasPrefix("buildup") })
  }

  func testSlowingRunnerStillLandsWithin4s() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(200, 3), (500, 2)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 4000)
  }

  func testChainPointLandsAtSegmentBoundary() {
    // Mirrors TS: chorus ends at 160s inside the [entry+120s, entry+240s]
    // window (entry 30s) → chain there, not at the 180s timer.
    var structured = song("seg")
    structured.segments = [
      SongSegment(label: "intro", startMs: 0, endMs: 30_000),
      SongSegment(label: "chorus", startMs: 30_000, endMs: 160_000),
      SongSegment(label: "break", startMs: 160_000, endMs: 200_000),
      SongSegment(label: "chorus", startMs: 200_000, endMs: 240_000),
    ]
    let lib = [structured, song("bbb"), song("ccc")]
    let easyPlan = [WorkoutStep(kind: "easy", seconds: 1200, meters: nil)]
    let engine = LiveEngine(plan: easyPlan, songs: lib)
    for i in 1...400 { engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: nil)) }
    let fills = engine.commands.filter { $0.reason.hasPrefix("groove fill") }
    XCTAssertGreaterThanOrEqual(fills.count, 2)
    let exitPos = fills[0].positionMs + (fills[1].tMs - fills[0].tMs)
    if fills[0].trackId == "seg" {
      XCTAssertLessThanOrEqual(abs(exitPos - 160_000), 1500)
    } else {
      XCTAssertLessThanOrEqual(abs(exitPos - 210_000), 1500)
    }
  }

  func testCruiseNeverLoopsAndStaysUnderTransitionBudget() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(900, 2.2)]) { engine.advance(s) }
    XCTAssertFalse(engine.commands.contains { $0.reason.hasPrefix("loop back") })
    let budget = Int(ceil(900_000.0 / 165_000.0)) + engine.landings.count * 3 + 2
    XCTAssertLessThanOrEqual(engine.commands.count, budget)
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 1500)
  }

  func testNeverRunsOffTrackEnd() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(900, 3)]) { engine.advance(s) }
    let cmds = engine.commands
    XCTAssertGreaterThanOrEqual(cmds.filter { $0.reason.hasPrefix("groove fill") }.count, 2)
    for i in 0..<cmds.count {
      let end = i + 1 < cmds.count ? cmds[i + 1].tMs : 900_000
      let playedTo = cmds[i].positionMs + (end - cmds[i].tMs)
      XCTAssertLessThanOrEqual(playedTo, 240_000 + 1500)
    }
  }

  func testTimeOnlyPlansWorkWithoutDistance() {
    let timePlan: [WorkoutStep] = [
      WorkoutStep(kind: "easy", seconds: 120, meters: nil),
      WorkoutStep(kind: "hard", seconds: 60, meters: nil),
      WorkoutStep(kind: "cooldown", seconds: 60, meters: nil),
    ]
    let engine = LiveEngine(plan: timePlan, songs: songs)
    for i in 1...240 { engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: nil)) }
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 1500)
  }

  func testSyntheticRunnerCoversPlanAndLandsAllReps() {
    let intervalPlan: [WorkoutStep] = [
      WorkoutStep(kind: "warmup", seconds: 180, meters: nil),
      WorkoutStep(kind: "easy", seconds: nil, meters: 400),
      WorkoutStep(kind: "hard", seconds: nil, meters: 800),
      WorkoutStep(kind: "easy", seconds: nil, meters: 400),
      WorkoutStep(kind: "hard", seconds: nil, meters: 800),
      WorkoutStep(kind: "cooldown", seconds: 120, meters: nil),
    ]
    let samples = syntheticSamples(plan: intervalPlan, scenario: RunScenario())
    XCTAssertGreaterThanOrEqual(samples.last!.distanceM!, 2400)
    let engine = LiveEngine(plan: intervalPlan, songs: songs)
    for s in samples { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 2)
    for l in engine.landings { XCTAssertLessThanOrEqual(abs(l.errorMs), 8000) }
  }

  func testFreshnessNoSingleSongMonopolizesAnEasyRun() {
    // The 2026-08-13 morning-run bug: all-easy plan, one song looped forever.
    let easyPlan = [WorkoutStep(kind: "easy", seconds: 1200, meters: nil)]
    let engine = LiveEngine(plan: easyPlan, songs: songs)
    for i in 1...1200 { engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: nil)) }
    let fills = engine.commands.filter { $0.reason.hasPrefix("groove fill") }
    XCTAssertGreaterThanOrEqual(fills.count, 5)
    for i in 1..<fills.count {
      XCTAssertLessThanOrEqual(fills[i].tMs - fills[i - 1].tMs, 240_000)
    }
    XCTAssertGreaterThanOrEqual(Set(engine.commands.map { $0.trackId }).count, 2)
  }

  func testHardOpeningPlanOpensOnADrop() {
    let p: [WorkoutStep] = [
      WorkoutStep(kind: "hard", seconds: nil, meters: 1000),
      WorkoutStep(kind: "easy", seconds: nil, meters: 500),
    ]
    let engine = LiveEngine(plan: p, songs: songs, paceSecPerKm: 340)
    for s in stream([(30, 3)]) { engine.advance(s) }
    XCTAssertTrue(engine.commands.first?.reason.hasPrefix("drop lands (opening)") ?? false)
    XCTAssertEqual(engine.landings.count, 1)
  }

  func testConsecutiveHardRepsGetBuildupsNotTruncatedCuts() {
    let p: [WorkoutStep] = [
      WorkoutStep(kind: "warmup", seconds: 60, meters: nil),
      WorkoutStep(kind: "hard", seconds: nil, meters: 600),
      WorkoutStep(kind: "hard", seconds: nil, meters: 600),
      WorkoutStep(kind: "hard", seconds: nil, meters: 600),
      WorkoutStep(kind: "cooldown", seconds: 60, meters: nil),
    ]
    let engine = LiveEngine(plan: p, songs: songs, paceSecPerKm: 340)
    for s in stream([(700, 3)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 3)
    for l in engine.landings { XCTAssertLessThanOrEqual(abs(l.errorMs), 1500) }
    XCTAssertGreaterThanOrEqual(engine.commands.filter { $0.reason.hasPrefix("buildup toward next rep") }.count, 2)
    XCTAssertFalse(engine.commands.contains { $0.reason.contains("truncated") })
  }

  func testWkStepSeqIsAuthoritativeOverTheOdometer() {
    // Distance stream reads 20% short — the watch's step events correct it.
    let p: [WorkoutStep] = [
      WorkoutStep(kind: "easy", seconds: nil, meters: 900),
      WorkoutStep(kind: "hard", seconds: nil, meters: 300),
      WorkoutStep(kind: "easy", seconds: nil, meters: 600),
    ]
    let engine = LiveEngine(plan: p, songs: songs, paceSecPerKm: 340)
    for i in 1...600 {
      let t = Double(i) * 1000
      let trueDist = Double(i) * 3
      let seq: Double = t < 300_000 ? 1 : (t < 400_000 ? 2 : 3)
      engine.advance(LiveSample(tMs: t, distanceM: trueDist * 0.8, wkStepSeq: seq))
    }
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].actualTMs - 300_000), 2000)
  }

  func testStalledWatchSeqOverdueFallbackAdvances() {
    let p: [WorkoutStep] = [
      WorkoutStep(kind: "hard", seconds: nil, meters: 600),
      WorkoutStep(kind: "hard", seconds: nil, meters: 600), // identical sig — watch misses
      WorkoutStep(kind: "rest", seconds: 60, meters: nil),
      WorkoutStep(kind: "hard", seconds: nil, meters: 600),
    ]
    let engine = LiveEngine(plan: p, songs: songs, paceSecPerKm: 340)
    for i in 1...700 {
      let t = Double(i) * 1000
      let d = Double(i) * 3
      let seq: Double = t < 400_000 ? 1 : (t < 460_000 ? 2 : 3)
      engine.advance(LiveSample(tMs: t, distanceM: d, wkStepSeq: seq))
    }
    XCTAssertEqual(engine.landings.count, 3)
    XCTAssertTrue(engine.warnings.contains { $0.contains("stalled") })
    XCTAssertLessThanOrEqual(abs(engine.landings.last!.actualTMs - 460_000), 5000)
  }

  func testMidBuildSlowdownReaimsAndLandsTight() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(370, 3), (200, 1.8)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 1)
    // Cruise-mode commits fire closer in (fresher pace), so a re-aim may not
    // even be needed — the contract is the tight landing, same as TS.
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 2000)
  }

  func testBundleDecodesLivePayloadAndTolerantOfOldFormat() throws {
    let newJson = """
    {"name":"x","planEndMs":60000,"cues":[],"songs":[],
     "plan":[{"kind":"easy","meters":400}],
     "tags":[{"trackId":"t","uri":"u","name":"n","artists":"a","durationMs":1000,"bpm":128,
              "markers":[{"type":"drop","ms":500}]}]}
    """
    let b = try JSONDecoder().decode(SessionBundle.self, from: Data(newJson.utf8))
    XCTAssertEqual(b.plan?.count, 1)
    XCTAssertEqual(b.tags?.first?.markers.first?.type, "drop")

    let oldJson = #"{"name":"x","planEndMs":60000,"cues":[],"songs":[]}"#
    let old = try JSONDecoder().decode(SessionBundle.self, from: Data(oldJson.utf8))
    XCTAssertNil(old.plan)
    XCTAssertNil(old.tags)
  }
}
