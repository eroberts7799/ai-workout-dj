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

/// Analyzer structure segment (allin1): intro/verse/chorus/break/outro…
struct SongSegment: Codable {
  let label: String
  let startMs: Double
  let endMs: Double
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
  /// Optional structure — energy-aware chain points (bundles from 2026-08-17).
  var segments: [SongSegment]? = nil
  /// Per-user taste bonus (−2..+2) from lifetime listening history. Mirrors
  /// SongTags.affinity — selection-only, never a transition/timing input.
  var affinity: Double? = nil
  /// Perceived intensity 0..1 (tag table; observed 0.5–1.0). Mirrors
  /// SongTags.energy — moment fit, selection-only.
  var energy: Double? = nil
  var id: String { trackId }
}

/// One workout step: time-based (seconds) or distance-based (meters).
struct WorkoutStep: Codable {
  let kind: String // warmup | easy | hard | rest | cooldown
  let seconds: Double?
  let meters: Double?
  /// Prescribed pace (Runna/Garmin speed band midpoint) — coaching only.
  var targetPaceSecPerKm: Double? = nil
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
  /// Learned pairing weights mined from real DJ sets ("<norm>><norm>" →
  /// count; bundles from 2026-08-17 on).
  var pairBonus: [String: Double]? = nil
  /// Which output this library plays through ("spotify" | "ownedFiles").
  /// A FACT recorded at adoption/import time, never derived: the 9/2
  /// shakeout died three times on heuristics guessing this field.
  var source: String? = nil
  /// Built-in demo bundles: trackId → bundled audio resource filename.
  let files: [String: String]?
}

/// Crossfade length by cue intent — mirrors the web LocalDeck's taste.
func fadeSeconds(for cue: Cue) -> Double {
  if cue.reason.hasPrefix("loop back") { return 0.25 }
  if cue.reason.hasPrefix("drop lands") { return 0.45 }
  return 1.2
}
