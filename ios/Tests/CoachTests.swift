// Port-parity tests for CoachEngine — mirrors src/live/coach.test.ts.
import XCTest
@testable import AwdjPlayer

private func song(_ id: String) -> TaggedSong {
  TaggedSong(trackId: id, uri: "spotify:track:\(id)", name: "Song \(id)", artists: "T", durationMs: 240_000, bpm: 128, camelot: nil, markers: [])
}
private let songs = [song("a"), song("b"), song("c")]

private func drive(_ plan: [WorkoutStep], seconds: Int, mps: (Int) -> Double, hr: (Int) -> Double?, coach: CoachEngine = CoachEngine()) -> (LiveEngine, CoachEngine) {
  let engine = LiveEngine(plan: plan, songs: songs, paceSecPerKm: 340, hrMax: 190)
  var d = 0.0
  for i in 1...seconds {
    d += mps(i)
    var s = LiveSample(tMs: Double(i) * 1000, distanceM: d)
    s.hr = hr(i)
    engine.advance(s)
    coach.advance(engine.coachView(tMs: s.tMs, distanceM: d, hr: hr(i)))
  }
  return (engine, coach)
}

private let intervals: [WorkoutStep] = [
  WorkoutStep(kind: "warmup", seconds: 120, meters: nil),
  WorkoutStep(kind: "hard", seconds: nil, meters: 800, targetPaceSecPerKm: 240),
  WorkoutStep(kind: "rest", seconds: 90, meters: nil),
  WorkoutStep(kind: "hard", seconds: nil, meters: 800, targetPaceSecPerKm: 240),
  WorkoutStep(kind: "cooldown", seconds: 120, meters: nil),
]

final class CoachTests: XCTestCase {
  func testPreRepCuesQuietZoneAndRepEndReport() {
    let (engine, coach) = drive(intervals, seconds: 900, mps: { _ in 3.5 }, hr: { i in (i > 120 && i < 350) ? 172 : 140 })
    XCTAssertEqual(engine.landings.count, 2)
    let T = engine.landings[0].actualTMs
    guard let pre30 = coach.cues.first(where: { $0.kind == "pre30" }) else { return XCTFail("no pre30") }
    XCTAssertGreaterThanOrEqual(T - pre30.tMs, 23_000)
    XCTAssertLessThanOrEqual(T - pre30.tMs, 37_000)
    XCTAssertTrue(pre30.text.contains("800 meters"))
    XCTAssertTrue(pre30.text.contains("4:00"))
    guard let pre10 = coach.cues.first(where: { $0.kind == "pre10" }) else { return XCTFail("no pre10") }
    XCTAssertGreaterThanOrEqual(T - pre10.tMs, 6_000)
    XCTAssertLessThanOrEqual(T - pre10.tMs, 13_000)
    for L in engine.landings {
      for c in coach.cues {
        let dt = c.tMs - L.actualTMs
        XCTAssertTrue(dt < -6_000 || dt >= 3_000, "cue inside the quiet zone: \(c.kind) at \(dt)")
      }
    }
    let ends = coach.cues.filter { $0.kind == "repEnd" }
    XCTAssertEqual(ends.count, 2)
    XCTAssertTrue(ends[0].text.contains("1 of 2"))
    XCTAssertTrue(ends[0].text.contains("4:4"))
    XCTAssertTrue(ends[0].text.contains("over"))
    XCTAssertTrue(coach.cues.contains { $0.kind == "halfway" })
    for i in 1..<coach.cues.count where coach.cues[i].kind != "repEnd" {
      XCTAssertGreaterThanOrEqual(coach.cues[i].tMs - coach.cues[i - 1].tMs, 8_000)
    }
  }

  func testEasyDayOnlyHeartRateWarnings() {
    let easy = [WorkoutStep(kind: "easy", seconds: 900, meters: nil)]
    let (_, coach) = drive(easy, seconds: 900, mps: { _ in 3 }, hr: { i in i > 100 ? 175 : 130 })
    XCTAssertEqual(coach.cues.filter { ["pre30", "pre10", "halfway"].contains($0.kind) }.count, 0)
    let hr = coach.cues.filter { $0.kind == "hrHigh" }
    XCTAssertGreaterThanOrEqual(hr.count, 2)
    XCTAssertLessThanOrEqual(hr.count, 3)
    XCTAssertTrue(hr[0].text.contains("easy day"))
    XCTAssertGreaterThanOrEqual(hr[1].tMs - hr[0].tMs, 300_000)
  }

  func testMorningScriptReplacesWordingNotTiming() {
    var script = CoachScript()
    script.opening = "Five hours of sleep. Completion day."
    script.pre30 = ["Rep {n}. {target} is plenty today."]
    let (engine, coach) = drive(intervals, seconds: 400, mps: { _ in 3.5 }, hr: { _ in nil }, coach: CoachEngine(script: script))
    guard let opening = coach.cues.first(where: { $0.kind == "opening" }) else { return XCTFail("no opening") }
    XCTAssertGreaterThanOrEqual(opening.tMs, 12_000)
    XCTAssertLessThan(opening.tMs, 25_000)
    guard let pre30 = coach.cues.first(where: { $0.kind == "pre30" }) else { return XCTFail("no pre30") }
    XCTAssertEqual(pre30.text, "Rep 1. 4:00 is plenty today.")
    XCTAssertLessThanOrEqual(engine.landings[0].actualTMs - pre30.tMs, 37_000)
  }

  func testSpokenPace() {
    XCTAssertEqual(spokenPace(240), "4:00")
    XCTAssertEqual(spokenPace(205), "3:25")
    XCTAssertEqual(spokenPace(365.4), "6:05")
  }
}
