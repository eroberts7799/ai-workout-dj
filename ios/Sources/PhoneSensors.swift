// PhoneSensors — the phone conducts itself. GPS distance + barometric
// altitude at 1Hz, no watch, no relay, no cell signal: built for trail runs
// where LTE dies but the crests are the whole point. The engine's
// GradeTracker only needs altitude DELTAS, so the barometer's relative
// altitude is ideal (falls back to GPS altitude on baro-less devices).

import CoreLocation
import CoreMotion
import Foundation

final class PhoneSensors: NSObject, CLLocationManagerDelegate {
  private let location = CLLocationManager()
  private let altimeter = CMAltimeter()
  private var lastLocation: CLLocation?
  private var baroAltitudeM: Double?
  private var gpsAltitudeM: Double?
  private var hasBaro = false
  private(set) var distanceM: Double = 0
  /// Latest credible GPS fix — the route matcher's input. In LIVE mode the
  /// watch owns distance/altitude and the phone contributes only this.
  private(set) var latestFix: (lat: Double, lon: Double, at: Date)?
  private var startedAt: Date?
  private var timer: Timer?

  /// Called at 1Hz with (timerMs, distanceM, altitudeM?).
  var onTick: ((Double, Double, Double?) -> Void)?

  func start() {
    location.delegate = self
    location.desiredAccuracy = kCLLocationAccuracyBest
    location.activityType = .fitness
    location.allowsBackgroundLocationUpdates = true
    location.pausesLocationUpdatesAutomatically = false
    location.requestWhenInUseAuthorization()
    location.startUpdatingLocation()
    hasBaro = CMAltimeter.isRelativeAltitudeAvailable()
    if hasBaro {
      altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
        if let d = data { self?.baroAltitudeM = d.relativeAltitude.doubleValue }
      }
    }
    distanceM = 0
    lastLocation = nil
    startedAt = Date()
    let t = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self, let s = self.startedAt else { return }
      let alt = self.hasBaro ? self.baroAltitudeM : self.gpsAltitudeM
      self.onTick?(Date().timeIntervalSince(s) * 1000, self.distanceM, alt)
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  func stop() {
    timer?.invalidate()
    timer = nil
    location.stopUpdatingLocation()
    if hasBaro { altimeter.stopRelativeAltitudeUpdates() }
    startedAt = nil
    latestFix = nil
  }

  /// A fix no older than `maxAgeS` — stale fixes (tunnel, pocket, indoors)
  /// must not pin the matcher to an old position.
  func freshFix(maxAgeS: TimeInterval = 5) -> (lat: Double, lon: Double)? {
    guard let f = latestFix, Date().timeIntervalSince(f.at) <= maxAgeS else { return nil }
    return (f.lat, f.lon)
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    for l in locations {
      // Trail GPS is jumpy under canopy — only accumulate credible fixes.
      guard l.horizontalAccuracy >= 0, l.horizontalAccuracy <= 30 else { continue }
      latestFix = (lat: l.coordinate.latitude, lon: l.coordinate.longitude, at: l.timestamp)
      if let last = lastLocation {
        let d = l.distance(from: last)
        if d >= 1 {
          distanceM += d
          lastLocation = l
        }
      } else {
        lastLocation = l
      }
      if l.verticalAccuracy >= 0 { gpsAltitudeM = l.altitude }
    }
  }
}
