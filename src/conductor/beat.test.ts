import { describe, expect, test } from 'bun:test'
import { beatAnchorMs, blendPlan, nextBeatDelayMs, snapToBeat } from './beat'

describe('snapToBeat', () => {
  const beat = 60_000 / 128 // 468.75ms

  test('snaps to the grid anchored at the drop, ≤ half a beat away', () => {
    for (const raw of [10_000, 33_333, 61_007, 94_500]) {
      const snapped = snapToBeat(raw, 95_000, 128)
      const beats = (95_000 - snapped) / beat
      expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-9)
      expect(Math.abs(snapped - raw)).toBeLessThanOrEqual(beat / 2 + 1e-9)
    }
  })

  test('on-grid positions do not move', () => {
    expect(snapToBeat(95_000 - 10 * beat, 95_000, 128)).toBeCloseTo(95_000 - 10 * beat, 6)
  })

  test('no bpm → no-op; never negative', () => {
    expect(snapToBeat(1234, 95_000, null)).toBe(1234)
    expect(snapToBeat(100, 95_000 % 468, 128)).toBeGreaterThanOrEqual(0)
  })
})

describe('nextBeatDelayMs', () => {
  const beat = 60_000 / 120 // 500ms — friendly numbers

  test('mid-beat waits out the remainder', () => {
    // anchor 30_000; pos 30_200 → 300ms to the next boundary
    expect(nextBeatDelayMs(30_200, 120, 30_000)).toBeCloseTo(300, 6)
  })

  test('exactly on a boundary cuts now', () => {
    expect(nextBeatDelayMs(30_000 + 7 * beat, 120, 30_000)).toBe(0)
  })

  test('positions before the anchor still phase correctly', () => {
    expect(nextBeatDelayMs(29_600, 120, 30_000)).toBeCloseTo(400, 6)
  })

  test('never longer than one beat; 0 without bpm', () => {
    for (let pos = 0; pos < 5000; pos += 137) {
      const d = nextBeatDelayMs(pos, 120, 30_000)
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(beat)
    }
    expect(nextBeatDelayMs(1234, null, 0)).toBe(0)
  })
})

describe('blendPlan', () => {
  test('compatible tempos earn a long bass-swapped blend', () => {
    expect(blendPlan(1.2, 124, 126)).toEqual({ fadeSec: 2.4, bassSwap: true })
    expect(blendPlan(3.0, 124, 124)).toEqual({ fadeSec: 3.0, bassSwap: true }) // longer request kept
  })

  test('incompatible tempos cut clean at the requested fade', () => {
    expect(blendPlan(1.2, 124, 90)).toEqual({ fadeSec: 1.2, bassSwap: false })
  })

  test('drops are never stretched; unknown bpm means no blend', () => {
    expect(blendPlan(0.45, 124, 125, { isDrop: true })).toEqual({ fadeSec: 0.45, bassSwap: false })
    expect(blendPlan(1.2, null, 124)).toEqual({ fadeSec: 1.2, bassSwap: false })
  })

  test('short utility cuts stay short even between twins', () => {
    expect(blendPlan(0.25, 124, 124)).toEqual({ fadeSec: 0.25, bassSwap: false })
  })
})

describe('beatAnchorMs', () => {
  test('prefers a drop, falls back to loop_start, then 0', () => {
    expect(beatAnchorMs([{ type: 'loop_start', ms: 30_000 }, { type: 'drop', ms: 95_000 }])).toBe(95_000)
    expect(beatAnchorMs([{ type: 'loop_start', ms: 30_000 }, { type: 'loop_end', ms: 60_000 }])).toBe(30_000)
    expect(beatAnchorMs([])).toBe(0)
  })
})
