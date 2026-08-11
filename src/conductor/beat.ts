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
