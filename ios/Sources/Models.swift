// Session bundle — exported by the web app's Conduct tab, imported here.
// The conductor (TypeScript) stays the single source of choreography truth;
// the phone executes its cue schedule.
import Foundation

struct SongMeta: Codable, Identifiable {
  let trackId: String
  let name: String
  let artists: String
  let durationMs: Double
  let bpm: Double?
  var id: String { trackId }
}

struct Cue: Codable {
  let atMs: Double
  let trackId: String
  let positionMs: Double
  let reason: String
}

/// A tagged structural marker inside a song (from the web Tagger).
struct Marker: Codable {
  let type: String // "buildup" | "drop" | "loop_start" | "loop_end"
  let ms: Double
}

/// Full tags for one song — what the LiveEngine picks loops and drops from.
struct TaggedSong: Codable, Identifiable {
  let trackId: String
  let uri: String
  let name: String
  let artists: String
  let durationMs: Double
  let bpm: Double?
  let camelot: String?
  let markers: [Marker]
  var id: String { trackId }
}

/// One workout step: time-based (seconds) or distance-based (meters).
struct WorkoutStep: Codable {
  let kind: String // warmup | easy | hard | rest | cooldown
  let seconds: Double?
  let meters: Double?
}

struct SessionBundle: Codable {
  let name: String
  let planEndMs: Double
  let cues: [Cue]
  let songs: [SongMeta]
  // LIVE-mode payload (newer web exports; absent in older bundles).
  let plan: [WorkoutStep]?
  let tags: [TaggedSong]?
  /// Calibrated max HR from the athlete's history (bundles from 2026-08-16
  /// on) — the zone anchor for the HR rules port. See ios/PARITY.md.
  let hrMax: Double?
  /// Built-in demo bundles: trackId → bundled audio resource filename.
  let files: [String: String]?
}

/// Crossfade length by cue intent — mirrors the web LocalDeck's taste.
func fadeSeconds(for cue: Cue) -> Double {
  if cue.reason.hasPrefix("loop back") { return 0.25 }
  if cue.reason.hasPrefix("drop lands") { return 0.45 }
  return 1.2
}
