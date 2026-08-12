// Beat-grid quantization. The analyzer snaps every marker to a downbeat, so
// a song's drop marker doubles as a beat-grid anchor: positions k beats before
// the drop are also on the grid. Any computed (non-marker) entry position gets
// snapped so cuts enter on the beat — the first step toward the live-set feel.

/**
 * Snap rawMs to the beat grid anchored at anchorMs (a downbeat-aligned
 * marker). Moves the position at most half a beat; no-op without a BPM.
 */
export function snapToBeat(rawMs: number, anchorMs: number, bpm: number | null | undefined): number {
  if (!bpm || bpm <= 0) return rawMs
  const beatMs = 60_000 / bpm
  const k = Math.round((anchorMs - rawMs) / beatMs)
  return Math.max(0, anchorMs - k * beatMs)
}

/**
 * How long to wait (ms) so a cut leaves the OUTGOING track exactly on its
 * next beat boundary. posMs is the playhead now; anchorMs any on-grid
 * position of the same track. 0 without a BPM (cut immediately), and a
 * boundary hit within 1ms counts as "on it".
 */
export function nextBeatDelayMs(posMs: number, bpm: number | null | undefined, anchorMs: number): number {
  if (!bpm || bpm <= 0) return 0
  const beatMs = 60_000 / bpm
  const phase = ((((posMs - anchorMs) % beatMs) + beatMs) % beatMs)
  return phase < 1 || beatMs - phase < 1 ? 0 : beatMs - phase
}

/** A song's beat-grid anchor: any marker the analyzer downbeat-snapped. */
export function beatAnchorMs(markers: { type: string; ms: number }[]): number {
  return (
    markers.find((m) => m.type === 'drop')?.ms ??
    markers.find((m) => m.type === 'loop_start')?.ms ??
    0
  )
}

/** Tempos within this ratio blend like a DJ; beyond it, cut clean. */
const BLEND_BPM_TOLERANCE = 0.03
/** A real blend needs room to breathe. */
const BLEND_FADE_SEC = 2.4

export interface BlendPlan {
  fadeSec: number
  /** Swap the bass at the cut: incoming enters bass-cut, basses trade at the boundary. */
  bassSwap: boolean
}

/**
 * How should this transition sound? Compatible tempos (both known, within
 * ~3%) earn a long bass-swapped blend — the classic DJ overlap. Everything
 * else keeps its requested fade as a clean cut. Drops are never stretched:
 * their fade is exact-time by design.
 */
export function blendPlan(
  requestedFadeSec: number,
  outgoingBpm: number | null | undefined,
  incomingBpm: number | null | undefined,
  opts: { isDrop?: boolean } = {},
): BlendPlan {
  if (opts.isDrop || !outgoingBpm || !incomingBpm) return { fadeSec: requestedFadeSec, bassSwap: false }
  const ratio = Math.abs(1 - incomingBpm / outgoingBpm)
  if (ratio > BLEND_BPM_TOLERANCE) return { fadeSec: requestedFadeSec, bassSwap: false }
  // Short utility cuts (loop-backs) stay short even between compatible songs.
  if (requestedFadeSec < 0.8) return { fadeSec: requestedFadeSec, bassSwap: false }
  return { fadeSec: Math.max(requestedFadeSec, BLEND_FADE_SEC), bassSwap: true }
}
