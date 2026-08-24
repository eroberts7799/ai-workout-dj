// Heart Rate Measurement (0x2A37) parser — the one pure piece of the BLE
// receiver, so the one piece a simulator can prove. Wire format per the
// Bluetooth spec: flags byte, then uint8 or uint16-LE bpm on flags bit 0.
import XCTest
@testable import AwdjPlayer

final class BleHeartRateTests: XCTestCase {
  func testEightBitHeartRate() {
    XCTAssertEqual(BleHeartRate.parseHeartRate(Data([0x00, 72])), 72)
  }

  func testGarminStyleFlagsWithSensorContactBits() {
    // Broadcast watches set contact-detected bits (0x06); bit 0 still says
    // the value is 8-bit — other flag bits must not change the parse.
    XCTAssertEqual(BleHeartRate.parseHeartRate(Data([0x06, 143])), 143)
  }

  func testSixteenBitHeartRate() {
    XCTAssertEqual(BleHeartRate.parseHeartRate(Data([0x01, 0xB4, 0x00])), 180)
    // Little-endian: 0x012C = 300 — proves byte order, not just low byte.
    XCTAssertEqual(BleHeartRate.parseHeartRate(Data([0x01, 0x2C, 0x01])), 300)
  }

  func testTruncatedAndEmptyPayloadsAreNil() {
    XCTAssertNil(BleHeartRate.parseHeartRate(Data()))
    XCTAssertNil(BleHeartRate.parseHeartRate(Data([0x00])))
    XCTAssertNil(BleHeartRate.parseHeartRate(Data([0x01, 0xB4]))) // 16-bit flag, one byte
  }
}
