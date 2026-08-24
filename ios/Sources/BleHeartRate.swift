// BleHeartRate — the watch as a plain BLE heart-rate monitor.
// The relay's HR stream needs LTE; trail mode has none. But Garmin watches
// can Broadcast Heart Rate over BLE (standard Heart Rate Service 0x180D),
// which works with zero signal — the phone receives it like any gym
// treadmill would. Deterministic body signal in every mode: HR gates the
// crest reward ("earned" = zone ≥ 3) and rides into every session log.
//
// Ethan's side: fr570 → Settings > Wrist Heart Rate > Broadcast During
// Activity (or Broadcast Heart Rate) — then this connects by itself.

import CoreBluetooth
import Foundation

final class BleHeartRate: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
  static let shared = BleHeartRate()

  @Published private(set) var bpm: Double?
  @Published private(set) var deviceName: String?
  @Published private(set) var state = "off"

  private var central: CBCentralManager?
  private var peripheral: CBPeripheral?
  private var wanted = false
  private var lastSampleAt: Date?

  private static let hrService = CBUUID(string: "180D")
  private static let hrMeasurement = CBUUID(string: "2A37")
  private static let savedIdKey = "awdj.bleHrPeripheralId"

  /// HR for the current tick — nil once the broadcast goes stale (watch
  /// stopped, strap died), so the engine falls back to no-HR semantics
  /// instead of conducting to a frozen number.
  var currentBpm: Double? {
    guard let at = lastSampleAt, Date().timeIntervalSince(at) < 15 else { return nil }
    return bpm
  }

  func start() {
    wanted = true
    if central == nil {
      central = CBCentralManager(delegate: self, queue: .main)
    } else if central?.state == .poweredOn {
      beginSearch()
    }
  }

  func stop() {
    wanted = false
    if let p = peripheral { central?.cancelPeripheralConnection(p) }
    central?.stopScan()
    peripheral = nil
    bpm = nil
    lastSampleAt = nil
    state = "off"
  }

  /// Standard Heart Rate Measurement (org.bluetooth.characteristic 0x2A37):
  /// flags byte, then uint8 or uint16-LE bpm depending on flags bit 0.
  static func parseHeartRate(_ data: Data) -> Double? {
    let bytes = [UInt8](data)
    guard let flags = bytes.first else { return nil }
    if flags & 0x01 == 0 {
      guard bytes.count >= 2 else { return nil }
      return Double(bytes[1])
    }
    guard bytes.count >= 3 else { return nil }
    return Double(UInt16(bytes[1]) | (UInt16(bytes[2]) << 8))
  }

  private func beginSearch() {
    guard let central, central.state == .poweredOn, wanted else { return }
    // A previously-used broadcaster reconnects without a scan: connect() to a
    // known peripheral is pending until it appears — ideal for long runs.
    if let saved = UserDefaults.standard.string(forKey: Self.savedIdKey),
       let id = UUID(uuidString: saved),
       let known = central.retrievePeripherals(withIdentifiers: [id]).first {
      peripheral = known
      known.delegate = self
      state = "waiting for \(known.name ?? "watch")…"
      central.connect(known)
    }
    // Scan regardless — a new/renamed broadcaster should still be found.
    central.scanForPeripherals(withServices: [Self.hrService])
    if peripheral == nil { state = "scanning for HR broadcast…" }
  }

  // MARK: CBCentralManagerDelegate

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    switch central.state {
    case .poweredOn: beginSearch()
    case .unauthorized: state = "bluetooth permission denied"
    case .poweredOff: state = "bluetooth is off"
    default: break
    }
  }

  func centralManager(_ central: CBCentralManager, didDiscover found: CBPeripheral,
                      advertisementData: [String: Any], rssi RSSI: NSNumber) {
    guard peripheral == nil || peripheral?.identifier == found.identifier else { return }
    central.stopScan()
    peripheral = found
    found.delegate = self
    UserDefaults.standard.set(found.identifier.uuidString, forKey: Self.savedIdKey)
    state = "connecting to \(found.name ?? "HR monitor")…"
    central.connect(found)
  }

  func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
    deviceName = p.name
    state = "connected: \(p.name ?? "HR monitor")"
    p.discoverServices([Self.hrService])
  }

  func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
    bpm = nil
    lastSampleAt = nil
    guard wanted else { return }
    // Broadcast pauses (watch menu, brief range loss) end in reconnects —
    // a pending connect() resumes the moment the broadcast returns.
    state = "reconnecting…"
    central.connect(p)
  }

  // MARK: CBPeripheralDelegate

  func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
    guard let s = p.services?.first(where: { $0.uuid == Self.hrService }) else { return }
    p.discoverCharacteristics([Self.hrMeasurement], for: s)
  }

  func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
    guard let c = service.characteristics?.first(where: { $0.uuid == Self.hrMeasurement }) else { return }
    p.setNotifyValue(true, for: c)
  }

  func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
    guard characteristic.uuid == Self.hrMeasurement, let data = characteristic.value,
          let hr = Self.parseHeartRate(data), hr > 0 else { return }
    bpm = hr
    lastSampleAt = Date()
    state = "connected: \(p.name ?? "HR monitor")"
  }
}
