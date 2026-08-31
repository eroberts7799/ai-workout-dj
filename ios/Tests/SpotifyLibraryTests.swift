// Free-play crate assembly — the pure parts.
import XCTest
@testable import AwdjPlayer

private func song(_ id: String) -> TaggedSong {
  TaggedSong(trackId: id, uri: "spotify:track:\(id)", name: id, artists: "a",
             durationMs: 200_000, bpm: nil, camelot: nil, markers: [])
}

final class SpotifyLibraryTests: XCTestCase {
  func testMergeCrateDedupesFirstOccurrenceWins() {
    let tops = [song("a"), song("b")]
    let recent = [song("b"), song("c")]
    let liked = [song("a"), song("c"), song("d")]
    let crate = SpotifyLibrary.mergeCrate([tops, recent, liked])
    XCTAssertEqual(crate.map { $0.trackId }, ["a", "b", "c", "d"])
  }

  func testMergeCrateEmptySourcesSurvive() {
    XCTAssertEqual(SpotifyLibrary.mergeCrate([[], [song("x")], []]).count, 1)
    XCTAssertTrue(SpotifyLibrary.mergeCrate([]).isEmpty)
  }
}
