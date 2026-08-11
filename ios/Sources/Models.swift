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

struct SessionBundle: Codable {
  let name: String
  let planEndMs: Double
  let cues: [Cue]
  let songs: [SongMeta]
}

/// Crossfade length by cue intent — mirrors the web LocalDeck's taste.
func fadeSeconds(for cue: Cue) -> Double {
  if cue.reason.hasPrefix("loop back") { return 0.25 }
  if cue.reason.hasPrefix("drop lands") { return 0.45 }
  return 1.2
}
