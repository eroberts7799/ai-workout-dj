// RouteMatch — Swift port of src/live/route-match.ts (parity law, 2026-09-06).
// "Your history is your route": the phone carries every past GPS track; the
// live run's first few hundred meters identify which one he is on (either
// direction), and from then on the route AHEAD is known. Pure, no network.
import Foundation

struct RoutePoint {
  let lat: Double
  let lon: Double
  let distM: Double
  let altM: Double
}

struct Route {
  let id: String
  let km: Double
  /// How many times this route was run — the habit prior for ties.
  let runs: Int
  let points: [RoutePoint]
}

struct Fix {
  let lat: Double
  let lon: Double
  /// Live odometer, meters (watch distance — authoritative).
  let distM: Double
}

/// A terrain cue projected onto the LIVE run. Mirrors TS AheadCue.
struct AheadCue {
  let type: TerrainCue.Kind
  let liveDistanceM: Double
  let flatEquivRemainingM: Double
  let gainM: Double
  let confidence: Double
  let key: String
}

struct RouteLock {
  let routeId: String
  let reversed: Bool
  let progressM: Double
  let remainingM: Double
  /// Share of lock-eligible candidates agreeing on the position 300m ahead.
  let agreement: Double
}

/// The library file the relay serves: points as [lat, lon, distM, altM].
struct RouteLibraryFile: Decodable {
  struct R: Decodable {
    let id: String
    let km: Double
    let runs: Int
    let points: [[Double]]
  }
  let routes: [R]

  var asRoutes: [Route] {
    routes.map { r in
      Route(id: r.id, km: r.km, runs: r.runs,
            points: r.points.compactMap { p in p.count >= 4 ? RoutePoint(lat: p[0], lon: p[1], distM: p[2], altM: p[3]) : nil })
    }
  }
}

final class RouteMatcher {
  /// Mirrors TS constants (GUESS — the route backtest calibrates).
  static let lockMinTrackM = 500.0
  static let nearM = 30.0
  private static let lostM = 60.0
  private static let lostTravelM = 100.0
  private static let forwardWindowM = 150.0
  private static let backWindowM = 40.0
  private static let gridCellM = 60.0
  private let ky = 110_540.0

  private final class Candidate {
    let route: Route
    let reversed: Bool
    let key: String
    let sm: [ProfilePoint]
    let cumFlatEquivM: [Double]
    let cues: [TerrainCue]
    let grid: [String: [Int]]
    let kx: Double
    var started = false
    var idx = 0
    var progressM = 0.0
    var onRouteM = 0.0
    var offRouteM = 0.0
    init(route: Route, reversed: Bool, key: String, sm: [ProfilePoint], cum: [Double], cues: [TerrainCue], grid: [String: [Int]], kx: Double) {
      self.route = route; self.reversed = reversed; self.key = key; self.sm = sm
      self.cumFlatEquivM = cum; self.cues = cues; self.grid = grid; self.kx = kx
    }
  }

  private var cands: [Candidate] = []
  private var current: Candidate?
  private var lastFix: Fix?

  init(routes: [Route]) {
    for r in routes where r.points.count >= 10 {
      cands.append(candidate(r, reversed: false))
      cands.append(candidate(r, reversed: true))
    }
  }

  private func candidate(_ route: Route, reversed: Bool) -> Candidate {
    let total = route.points[route.points.count - 1].distM
    let pts: [RoutePoint] = reversed
      ? route.points.reversed().map { RoutePoint(lat: $0.lat, lon: $0.lon, distM: total - $0.distM, altM: $0.altM) }
      : route.points
    let r = Route(id: route.id, km: route.km, runs: route.runs, points: pts)
    let profile = pts.map { ProfilePoint(distanceM: $0.distM, altitudeM: $0.altM) }
    let sm = Terrain.smoothProfile(profile)
    var cum = [Double](repeating: 0, count: sm.count)
    if sm.count > 1 {
      for i in 1..<sm.count {
        let dd = sm[i].distanceM - sm[i - 1].distanceM
        if dd <= 0 { cum[i] = cum[i - 1]; continue }
        let grade = (sm[i].altitudeM - sm[i - 1].altitudeM) / dd
        let mult = Terrain.gapMultiplier(grade)
        cum[i] = cum[i - 1] + dd * mult
      }
    }
    let kx = 111_320 * cos(pts[0].lat * .pi / 180)
    var grid: [String: [Int]] = [:]
    for (i, p) in pts.enumerated() { grid[cell(kx, p.lat, p.lon), default: []].append(i) }
    return Candidate(route: r, reversed: reversed, key: "\(route.id)\(reversed ? ":rev" : "")",
                     sm: sm, cum: cum, cues: Terrain.extractTerrainCues(profile), grid: grid, kx: kx)
  }

  private func cell(_ kx: Double, _ lat: Double, _ lon: Double) -> String {
    "\(Int(floor(lon * kx / Self.gridCellM))),\(Int(floor(lat * ky / Self.gridCellM)))"
  }

  private func meters(_ kx: Double, _ aLat: Double, _ aLon: Double, _ bLat: Double, _ bLon: Double) -> Double {
    let dx = (aLon - bLon) * kx
    let dy = (aLat - bLat) * ky
    return (dx * dx + dy * dy).squareRoot()
  }

  /// Nearest route point (forward window when started, direction-aware grid
  /// search otherwise) and the runner's CONTINUOUS progress by projection
  /// onto the segment through it. Mirrors TS `nearest`.
  private func nearest(_ c: Candidate, _ fix: Fix, heading: (Double, Double)?) -> (Int, Double, Double) {
    let pts = c.route.points
    var best = -1
    var bestD = Double.infinity
    if c.started {
      let from = c.progressM - Self.backWindowM
      let to = c.progressM + Self.forwardWindowM
      var i = max(0, c.idx - 3)
      while i < pts.count && pts[i].distM <= to {
        if pts[i].distM >= from {
          let d = meters(c.kx, fix.lat, fix.lon, pts[i].lat, pts[i].lon)
          if d < bestD { bestD = d; best = i }
        }
        i += 1
      }
    } else {
      let cx = Int(floor(fix.lon * c.kx / Self.gridCellM))
      let cy = Int(floor(fix.lat * ky / Self.gridCellM))
      for dx in -1...1 {
        for dy in -1...1 {
          guard let arr = c.grid["\(cx + dx),\(cy + dy)"] else { continue }
          for i in arr {
            let d = meters(c.kx, fix.lat, fix.lon, pts[i].lat, pts[i].lon)
            if d > Self.nearM || d >= bestD { continue }
            if let h = heading, i + 1 < pts.count {
              let rx = (pts[i + 1].lon - pts[i].lon) * c.kx
              let ry = (pts[i + 1].lat - pts[i].lat) * ky
              if rx * h.0 + ry * h.1 <= 0 { continue }
            }
            bestD = d
            best = i
          }
        }
      }
    }
    if best < 0 { return (-1, .infinity, c.progressM) }
    var progress = pts[best].distM
    var residual = bestD
    for (a, b) in [(best - 1, best), (best, best + 1)] {
      if a < 0 || b >= pts.count { continue }
      let ax = pts[a].lon * c.kx, ay = pts[a].lat * ky
      let bx = pts[b].lon * c.kx, by = pts[b].lat * ky
      let px = fix.lon * c.kx, py = fix.lat * ky
      let vx = bx - ax, vy = by - ay
      let len2 = vx * vx + vy * vy
      if len2 <= 0 { continue }
      let tt = max(0, min(1, ((px - ax) * vx + (py - ay) * vy) / len2))
      let qx = ax + tt * vx, qy = ay + tt * vy
      let d = ((px - qx) * (px - qx) + (py - qy) * (py - qy)).squareRoot()
      if d < residual {
        residual = d
        progress = pts[a].distM + tt * (pts[b].distM - pts[a].distM)
      }
    }
    return (best, residual, progress)
  }

  /// Feed one GPS fix (≈1Hz). Mirrors TS `update`.
  func update(_ fix: Fix) {
    let dLive = lastFix.map { max(0, fix.distM - $0.distM) } ?? 0
    var heading: (Double, Double)?
    if let last = lastFix {
      let kx = 111_320 * cos(fix.lat * .pi / 180)
      let hx = (fix.lon - last.lon) * kx
      let hy = (fix.lat - last.lat) * ky
      if (hx * hx + hy * hy).squareRoot() >= 3 { heading = (hx, hy) }
    }
    lastFix = fix
    for c in cands {
      let (i, res, prog) = nearest(c, fix, heading: heading)
      if !c.started {
        if i >= 0 && res <= Self.nearM {
          c.started = true
          c.idx = i
          c.progressM = prog
          c.onRouteM = 0
          c.offRouteM = 0
        }
        continue
      }
      if i >= 0 && res <= Self.nearM {
        if prog >= c.progressM - Self.backWindowM {
          c.idx = i
          c.progressM = max(c.progressM, prog)
        }
        c.onRouteM += dLive
        c.offRouteM = 0
      } else if i < 0 || res > Self.lostM {
        c.offRouteM += dLive
        if c.offRouteM >= Self.lostTravelM {
          c.started = false
          c.onRouteM = 0
          c.offRouteM = 0
          if current === c { current = nil }
        }
      }
    }
    var best: Candidate?
    for c in cands where c.started && c.onRouteM >= Self.lockMinTrackM {
      if best == nil || better(c, best!) { best = c }
    }
    if let cur = current, cur.started, cur.onRouteM >= Self.lockMinTrackM {
      if let b = best, b !== cur, b.onRouteM > cur.onRouteM + Self.lockMinTrackM { current = b }
    } else {
      current = best
    }
  }

  private func better(_ a: Candidate, _ b: Candidate) -> Bool {
    if a.onRouteM != b.onRouteM { return a.onRouteM > b.onRouteM }
    if a.route.runs != b.route.runs { return a.route.runs > b.route.runs }
    return a.route.km > b.route.km
  }

  var lock: RouteLock? {
    guard let c = current else { return nil }
    let total = c.route.points[c.route.points.count - 1].distM
    return RouteLock(routeId: c.route.id, reversed: c.reversed, progressM: c.progressM, remainingM: total - c.progressM, agreement: agreement())
  }

  private func pointAhead(_ c: Candidate, _ aheadM: Double) -> RoutePoint? {
    let target = c.progressM + aheadM
    let pts = c.route.points
    var i = c.idx
    while i < pts.count {
      if pts[i].distM >= target { return pts[i] }
      i += 1
    }
    return nil
  }

  private func agreement(aheadM: Double = 300) -> Double {
    guard let cur = current else { return 0 }
    guard let mine = pointAhead(cur, aheadM) else { return 1 }
    var eligible = 0
    var agree = 0
    for c in cands where c.started && c.onRouteM >= Self.lockMinTrackM {
      eligible += 1
      if let p = pointAhead(c, aheadM), meters(cur.kx, mine.lat, mine.lon, p.lat, p.lon) <= 40 { agree += 1 }
    }
    return eligible > 0 ? Double(agree) / Double(eligible) : 1
  }

  /// Terrain cues AHEAD on the locked route, projected onto the live odometer.
  func aheadCues() -> [AheadCue] {
    guard let c = current, let fix = lastFix else { return [] }
    let here = flatEquivAt(c, c.progressM)
    let agreement = agreement()
    var out: [AheadCue] = []
    for cue in c.cues where cue.distanceM > c.progressM {
      out.append(AheadCue(
        type: cue.type,
        liveDistanceM: fix.distM + (cue.distanceM - c.progressM),
        flatEquivRemainingM: flatEquivAt(c, cue.distanceM) - here,
        gainM: cue.gainM,
        confidence: cue.confidence * (agreement >= 1 ? 1 : 0.5),
        key: "\(c.key)@\(Int(cue.distanceM.rounded()))"))
    }
    return out
  }

  /// The route's elevation ahead in LIVE-odometer space.
  func aheadProfile(maxM: Double = 2000) -> [ProfilePoint] {
    guard let c = current, let fix = lastFix else { return [] }
    var out: [ProfilePoint] = []
    for p in c.sm {
      if p.distanceM < c.progressM { continue }
      if p.distanceM > c.progressM + maxM { break }
      out.append(ProfilePoint(distanceM: fix.distM + (p.distanceM - c.progressM), altitudeM: p.altitudeM))
    }
    return out
  }

  private func flatEquivAt(_ c: Candidate, _ d: Double) -> Double {
    let sm = c.sm
    let cum = c.cumFlatEquivM
    var lo = 0
    var hi = sm.count - 1
    while lo < hi {
      let mid = (lo + hi) >> 1
      if sm[mid].distanceM < d { lo = mid + 1 } else { hi = mid }
    }
    if lo == 0 { return 0 }
    let a = sm[lo - 1]
    let b = sm[lo]
    let f = min(1, max(0, (d - a.distanceM) / max(1, b.distanceM - a.distanceM)))
    return cum[lo - 1] + f * (cum[lo] - cum[lo - 1])
  }
}
