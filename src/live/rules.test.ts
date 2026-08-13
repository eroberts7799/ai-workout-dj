import { describe, expect, test } from 'bun:test'
import { GradeTracker, HrTracker } from './rules'

/** Walk the tracker along a route: [meters, grade] segments at 3 m/s. */
function walk(tracker: GradeTracker, segments: [number, number][]) {
  const events: { dist: number; state: ReturnType<GradeTracker['update']> }[] = []
  let d = 0
  let alt = 100
  for (const [meters, grade] of segments) {
    for (let covered = 0; covered < meters; covered += 3) {
      d += 3
      alt += 3 * grade
      events.push({ dist: d, state: tracker.update(d, alt) })
    }
  }
  return events
}

describe('GradeTracker', () => {
  test('detects the climb and fires exactly one crest at the top', () => {
    const events = walk(new GradeTracker(), [
      [500, 0],
      [900, 0.04], // 36m gain
      [500, 0],
    ])
    const crests = events.filter((e) => e.state.crest)
    expect(crests.length).toBe(1)
    // Crest fires shortly after the 900m mark where the hill tops out.
    expect(crests[0].dist).toBeGreaterThanOrEqual(1400)
    expect(crests[0].dist).toBeLessThanOrEqual(1550)
    // Mid-climb the tracker knows it's climbing at ~4%.
    const mid = events.find((e) => e.dist >= 800)!
    expect(mid.state.climbing).toBe(true)
    expect(mid.state.grade).toBeGreaterThan(0.025)
  })

  test('flat ground never crests', () => {
    const events = walk(new GradeTracker(), [[3000, 0]])
    expect(events.some((e) => e.state.crest)).toBe(false)
    expect(events.some((e) => e.state.climbing)).toBe(false)
  })

  test('a bump below the gain floor is not celebrated', () => {
    // 400m at 4% = 16m gain < 30m floor.
    const events = walk(new GradeTracker(), [
      [500, 0],
      [400, 0.04],
      [500, 0],
    ])
    expect(events.some((e) => e.state.crest)).toBe(false)
  })

  test('two hills, two crests', () => {
    const events = walk(new GradeTracker(), [
      [300, 0],
      [900, 0.04],
      [900, -0.04],
      [300, 0],
      [900, 0.04],
      [900, -0.04],
    ])
    expect(events.filter((e) => e.state.crest).length).toBe(2)
  })

  test('missing altitude data is a no-op', () => {
    const tracker = new GradeTracker()
    for (let i = 1; i <= 100; i++) {
      const s = tracker.update(i * 3, undefined)
      expect(s.crest).toBe(false)
      expect(s.grade).toBe(0)
    }
  })
})

describe('HrTracker', () => {
  test('zones by % of max, smoothed', () => {
    const t = new HrTracker(190)
    let state = t.update(110)
    expect(state.zone).toBe(1) // 110/190 = 58%
    for (let i = 0; i < 40; i++) state = t.update(160)
    expect(state.zone).toBe(4) // 160/190 = 84%
    for (let i = 0; i < 40; i++) state = t.update(175)
    expect(state.zone).toBe(5) // 175/190 = 92%
  })

  test('no data → zone 0; data survives gaps', () => {
    const t = new HrTracker()
    expect(t.update(undefined).zone).toBe(0)
    t.update(150)
    const s = t.update(undefined) // dropout keeps last smoothed value
    expect(s.zone).toBeGreaterThan(0)
  })
})
