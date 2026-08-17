export type MarkerType = 'buildup' | 'drop' | 'loop_start' | 'loop_end'

export interface Marker {
  id: string
  type: MarkerType
  /** Position in the track, ms, as heard on Spotify's own stream. */
  ms: number
}

export interface SongTags {
  trackId: string
  uri: string
  name: string
  artists: string
  durationMs: number
  /** Tap-tempo BPM; null until set. Used for grid snap and the jitter threshold. */
  bpm: number | null
  /** Camelot wheel position (e.g. "9A") from key detection; null when unknown.
   *  Harmonic compatibility drives DJ-crate song selection. */
  camelot?: string | null
  markers: Marker[]
  /** Structural segments from the analyzer (allin1): intro/verse/chorus/
   *  break/outro… Energy-aware chain points pick song CHANGES at these
   *  boundaries — leave as a strong section ends, never mid-breakdown. */
  segments?: { label: string; startMs: number; endMs: number }[]
  /** The owned file this song came from — sync-from-disk matches by this. */
  sourceFile?: string
  updatedAt: string
}

export const MARKER_LABEL: Record<MarkerType, string> = {
  buildup: 'BUILDUP',
  drop: 'DROP',
  loop_start: 'LOOP ⟨',
  loop_end: 'LOOP ⟩',
}
