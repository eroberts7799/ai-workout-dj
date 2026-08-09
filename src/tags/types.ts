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
  markers: Marker[]
  updatedAt: string
}

export const MARKER_LABEL: Record<MarkerType, string> = {
  buildup: 'BUILDUP',
  drop: 'DROP',
  loop_start: 'LOOP ⟨',
  loop_end: 'LOOP ⟩',
}
