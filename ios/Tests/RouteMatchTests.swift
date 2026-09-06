// Port-parity tests for RouteMatcher — mirrors src/live/route-match.test.ts.
import XCTest
@testable import AwdjPlayer

private let LAT0 = 32.06
private let LON0 = 34.77
private let KY = 110_540.0
private let KX = 111_320.0 * cos(LAT0 * .pi / 180)

private func route(_ id: String, _ legs: [(dx: Double, dy: Double)], alt: (Double) -> Double, runs: Int = 1) -> Route {
  var pts: [RoutePoint] = [RoutePoint(lat: LAT0, lon: LON0, distM: 0, altM: alt(0))]
  var x = 0.0, y = 0.0, d = 0.0
  for leg in legs {
    let len = (leg.dx * leg.dx + leg.dy * leg.dy).squareRoot()
    let steps = Int(len / 20)
    for _ in 1...steps {
      x += leg.dx / Double(steps)
      y += leg.dy / Double(steps)
      d += len / Double(steps)
      pts.append(RoutePoint(lat: LAT0 + y / KY, lon: LON0 + x / KX, distM: (d * 10).rounded() / 10, altM: alt(d)))
    }
  }
  return Route(id: id, km: d / 1000, runs: runs, points: pts)
}

private func fixes(_ legs: [(dx: Double, dy: Double)], offsetM: Double = 0, startD: Double = 0, latShiftM: Double = 0) -> [Fix] {
  var out: [Fix] = []
  var x = 0.0, y = 0.0, d = startD
  for leg in legs {
    let len = (leg.dx * leg.dx + leg.dy * leg.dy).squareRoot()
    let steps = Int(len / 5)
    let nx = -leg.dy / len, ny = leg.dx / len
    for _ in 1...steps {
      x += leg.dx / Double(steps)
      y += leg.dy / Double(steps)
      d += len / Double(steps)
      out.append(Fix(lat: LAT0 + (y + ny * offsetM + latShiftM) / KY, lon: LON0 + (x + nx * offsetM) / KX, distM: d))
    }
  }
  return out
}

private let flat: (Double) -> Double = { _ in 10 }
private let north2k = [(dx: 0.0, dy: 2000.0)]

final class RouteMatchTests: XCTestCase {
  func testLocksAfterMinimumTravelAndTracksProgress() {
    let m = RouteMatcher(routes: [route("r", north2k, alt: flat)])
    var lockedAt: Double?
    for f in fixes(north2k, offsetM: 8) {
      m.update(f)
      if m.lock != nil, lockedAt == nil { lockedAt = f.distM }
    }
    XCTAssertNotNil(lockedAt)
    XCTAssertGreaterThanOrEqual(lockedAt!, RouteMatcher.lockMinTrackM)
    XCTAssertLessThan(lockedAt!, RouteMatcher.lockMinTrackM + 40)
    XCTAssertEqual(m.lock?.routeId, "r")
    XCTAssertEqual(m.lock?.reversed, false)
    XCTAssertLessThan(abs(m.lock!.progressM - 2000), 25)
  }

  func testSameRouteBackwardsLocksReversed() {
    let m = RouteMatcher(routes: [route("r", north2k, alt: flat)])
    for f in fixes([(dx: 0, dy: -2000)], latShiftM: 2000) { m.update(f) }
    XCTAssertNotNil(m.lock)
    XCTAssertEqual(m.lock?.reversed, true)
    XCTAssertLessThan(abs(m.lock!.progressM - 2000), 25)
  }

  func testLeavingTheRouteDropsTheLock() {
    let m = RouteMatcher(routes: [route("r", north2k, alt: flat)])
    for f in fixes([(dx: 0, dy: 1000)]) { m.update(f) }
    XCTAssertNotNil(m.lock)
    var dropAt: Double?
    for f in fixes([(dx: 400, dy: 0)], startD: 1000, latShiftM: 1000) {
      m.update(f)
      if m.lock == nil, dropAt == nil { dropAt = f.distM }
    }
    XCTAssertNotNil(dropAt)
    XCTAssertLessThan(dropAt! - 1000, 200)
  }

  func testSharedPrefixTheBranchDecides() {
    let A = route("A", [(dx: 0, dy: 1000), (dx: 1000, dy: 0)], alt: flat, runs: 2)
    let B = route("B", [(dx: 0, dy: 1000), (dx: -1000, dy: 0)], alt: flat, runs: 9)
    let m = RouteMatcher(routes: [A, B])
    for f in fixes([(dx: 0, dy: 1000)]) { m.update(f) }
    XCTAssertEqual(m.lock?.routeId, "B")
    for f in fixes([(dx: 600, dy: 0)], startD: 1000, latShiftM: 1000) { m.update(f) }
    XCTAssertEqual(m.lock?.routeId, "A")
    XCTAssertLessThan(abs(m.lock!.progressM - 1600), 30)
  }

  func testAheadCuesProjectTheCrestOntoTheLiveOdometer() {
    let alt: (Double) -> Double = { d in d <= 1000 ? 10 : d <= 2000 ? 10 + (d - 1000) * 0.08 : 90 }
    let m = RouteMatcher(routes: [route("hill", [(dx: 0, dy: 3000)], alt: alt)])
    for f in fixes([(dx: 0, dy: 800)], startD: 300) { m.update(f) }
    XCTAssertNotNil(m.lock)
    guard let crest = m.aheadCues().first(where: { $0.type == .crest }) else { return XCTFail("no crest cue") }
    XCTAssertGreaterThan(crest.liveDistanceM, 2250)
    XCTAssertLessThan(crest.liveDistanceM, 2550)
    XCTAssertGreaterThan(crest.confidence, 0.9)
    XCTAssertGreaterThan(crest.flatEquivRemainingM, crest.liveDistanceM - 1100)
    let profile = m.aheadProfile(maxM: 2500)
    XCTAssertGreaterThanOrEqual(profile.first!.distanceM, 1090)
    XCTAssertGreaterThan(profile.last!.altitudeM, 80)
  }
}
