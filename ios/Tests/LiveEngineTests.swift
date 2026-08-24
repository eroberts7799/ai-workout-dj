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
    // Fresh mode (default): the moment is a NEW song from 0:00.
    let change = engine.commands.first { $0.reason.hasPrefix("rep change") }
    XCTAssertNotNil(change)
    XCTAssertEqual(change?.positionMs, 0)
  }

  func testSlowingRunnerStillLandsWithin4s() {
    let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340)
    for s in stream([(200, 3), (500, 2)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 1)
    XCTAssertLessThanOrEqual(abs(engine.landings[0].errorMs), 4000)
  }

  func testLearnedPairWeightsSteerSelection() {
    let easyPlan = [WorkoutStep(kind: "easy", seconds: 600, meters: nil)]
    let engine = LiveEngine(plan: easyPlan, songs: songs, pairBonus: ["test song aaa>test song ccc": 5])
    for i in 1...400 { engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: nil)) }
    let fills = engine.commands.filter { $0.reason.hasPrefix("groove fill") }
    XCTAssertGreaterThanOrEqual(fills.count, 2)
    XCTAssertEqual(fills[0].trackId, "aaa")
    XCTAssertEqual(fills[1].trackId, "ccc")
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
      XCTAssertLessThanOrEqual(abs(exitPos - 180_000), 1500)
    }
  }

  func testShortRestsOneChangePerRepNotReleasePlusBuildup() {
    let p: [WorkoutStep] = [
      WorkoutStep(kind: "warmup", seconds: 60, meters: nil),
      WorkoutStep(kind: "hard", seconds: nil, meters: 400),
      WorkoutStep(kind: "rest", seconds: 60, meters: nil),
      WorkoutStep(kind: "hard", seconds: nil, meters: 400),
      WorkoutStep(kind: "cooldown", seconds: 60, meters: nil),
    ]
    let longSongs = songs.map { s -> TaggedSong in
      var c = s
      c = TaggedSong(trackId: s.trackId, uri: s.uri, name: s.name, artists: s.artists, durationMs: 360_000, bpm: s.bpm, camelot: s.camelot, markers: s.markers)
      return c
    }
    let engine = LiveEngine(plan: p, songs: longSongs, paceSecPerKm: 340)
    for s in stream([(500, 3)]) { engine.advance(s) }
    XCTAssertEqual(engine.landings.count, 2)
    let firstLandingT = engine.landings[0].targetTMs
    let cmds = engine.commands
    guard let secondChangeIdx = cmds.firstIndex(where: { $0.tMs > firstLandingT && $0.reason.hasPrefix("rep change") }) else {
      return XCTFail("no second rep change")
    }
    let between = cmds.enumerated().filter { $0.offset < secondChangeIdx && $0.element.tMs > firstLandingT && $0.element.reason.hasPrefix("groove fill") }
    XCTAssertEqual(between.count, 0)
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
    XCTAssertTrue(engine.commands.first?.reason.hasPrefix("rep change (opening)") ?? false)
    XCTAssertEqual(engine.commands.first?.positionMs, 0)
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
    let changes = engine.commands.filter { $0.reason.hasPrefix("rep change") }
    XCTAssertGreaterThanOrEqual(changes.count, 3)
    for c in changes { XCTAssertEqual(c.positionMs, 0) }
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

  func testCrestRewardFiresOnceOnARealHillFreshFromTheTop() {
    // Mirrors TS: all-easy plan, 4% climb from 800m→1700m (36m gain ≥ the
    // 30m data-tuned bar) → exactly one crest change, from 0:00, groove after.
    let easyPlan = [WorkoutStep(kind: "easy", seconds: nil, meters: 3000)]
    let engine = LiveEngine(plan: easyPlan, songs: songs, paceSecPerKm: 340)
    var d = 0.0
    var alt = 100.0
    for i in 1...900 {
      d += 3
      if d > 800 && d <= 1700 { alt += 3 * 0.04 }
      engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: d, altitudeM: alt, hr: 160))
    }
    let crests = engine.commands.filter { $0.reason.contains("crest reward") }
    XCTAssertEqual(crests.count, 1)
    XCTAssertEqual(crests[0].positionMs, 0)
    XCTAssertGreaterThanOrEqual(crests[0].tMs, 560_000)
    XCTAssertLessThanOrEqual(crests[0].tMs, 600_000)
    // The crest song rides to its own chain point — not the old 25s time-box.
    let after = engine.commands.first { $0.tMs > crests[0].tMs && $0.reason.hasPrefix("groove fill") }
    XCTAssertNotNil(after)
    XCTAssertGreaterThanOrEqual(after!.tMs - crests[0].tMs, 120_000)
  }

  func testLazyHeartRateEarnsNoCrest() {
    // Same hill, HR present but zone < 3 → no reward. Mirrors TS.
    let easyPlan = [WorkoutStep(kind: "easy", seconds: nil, meters: 3000)]
    let engine = LiveEngine(plan: easyPlan, songs: songs, paceSecPerKm: 340, hrMax: 190)
    var d = 0.0
    var alt = 100.0
    for i in 1...900 {
      d += 3
      if d > 800 && d <= 1700 { alt += 3 * 0.04 }
      engine.advance(LiveSample(tMs: Double(i) * 1000, distanceM: d, altitudeM: alt, hr: 95))
    }
    XCTAssertTrue(engine.commands.filter { $0.reason.contains("crest reward") }.isEmpty)
  }

  func testFollowModeConductsWithNoPlanAtAll() {
    // Mirrors TS: empty plan + streamed step shapes = full conducting.
    let engine = LiveEngine(plan: [], songs: songs, paceSecPerKm: 340)
    func phase(_ t: Double) -> (seq: Double, kind: String, dt: Double, dv: Double, next: String?) {
      if t <= 60_000 { return (1, "warmup", 0, 60, "hard") }
      if t <= 160_000 { return (2, "hard", 1, 300, "rest") }
      if t <= 220_000 { return (3, "rest", 0, 60, "hard") }
      if t <= 320_000 { return (4, "hard", 1, 300, "cooldown") }
      return (5, "cooldown", 0, 60, nil)
    }
    for i in 1...380 {
      let t = Double(i) * 1000
      let p = phase(t)
      engine.advance(LiveSample(
        tMs: t, distanceM: Double(i) * 3, wkStepSeq: p.seq,
        wkKind: p.kind, wkDurationType: p.dt, wkDurationValue: p.dv, wkNextKind: p.next
      ))
    }
    XCTAssertEqual(engine.landings.count, 2)
    for l in engine.landings { XCTAssertLessThanOrEqual(abs(l.errorMs), 1500) }
    let changes = engine.commands.filter { $0.reason.hasPrefix("rep change") }
    XCTAssertGreaterThanOrEqual(changes.count, 2)
    for c in changes { XCTAssertEqual(c.positionMs, 0) }
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

  func testStructurelessSongsRideToNaturalEndNotTheTimer() {
    // Mirrors TS: scraped tracks (no segments) whose end is within
    // timer+slack play out; long extended mixes still get the 3:00 timer.
    func mk(_ id: String, _ durationMs: Double) -> TaggedSong {
      TaggedSong(trackId: id, uri: "spotify:track:\(id)", name: "Stream \(id)",
                 artists: "Playlist", durationMs: durationMs, bpm: nil, camelot: nil, markers: [])
    }
    let cruise = [WorkoutStep(kind: "easy", seconds: 900, meters: nil)]

    let short = LiveEngine(plan: cruise, songs: [mk("s1", 210_000), mk("s2", 210_000), mk("s3", 210_000)], paceSecPerKm: 340)
    for s in stream([(seconds: 900, mps: 3)]) { short.advance(s) }
    let gaps = zip(short.commands.dropFirst(), short.commands).map { $0.tMs - $1.tMs }
    for g in gaps { XCTAssertGreaterThanOrEqual(g, 205_000) }

    let long = LiveEngine(plan: cruise, songs: [mk("l1", 360_000), mk("l2", 360_000), mk("l3", 360_000)], paceSecPerKm: 340)
    for s in stream([(seconds: 900, mps: 3)]) { long.advance(s) }
    let lgaps = zip(long.commands.dropFirst(), long.commands).map { $0.tMs - $1.tMs }
    for g in lgaps { XCTAssertLessThanOrEqual(g, 182_000) }
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
