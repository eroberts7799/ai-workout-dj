import { describe, expect, test } from 'bun:test'
import type { SongTags, WorkoutPlan } from '../conductor/types'
import { loadSessionLog, nominalDurationMs, simulate, syntheticSamples } from './simulate'

function song(id: string): SongTags {
  return {
    trackId: id,
    uri: `spotify:track:${id}`,
    name: `Song ${id}`,
    artists: 'Test',
    durationMs: 240_000,
    bpm: 128,
    updatedAt: '2026-08-11T00:00:00Z',
    markers: [
      { id: 'l1', type: 'loop_start', ms: 30_000 },
      { id: 'l2', type: 'loop_end', ms: 60_000 },
      { id: 'b', type: 'buildup', ms: 75_000 },
      { id: 'd', type: 'drop', ms: 95_000 },
    ],
  }
}

const songs = [song('aaa'), song('bbb'), song('ccc')]

/** The real target workout: warmup, 4× (easy 400m, hard 800m), cooldown. */
const plan: WorkoutPlan = {
  name: 'intervals',
  steps: [
    { kind: 'warmup', seconds: 180 },
    ...Array.from({ length: 4 }, () => [
      { kind: 'easy' as const, meters: 400 },
      { kind: 'hard' as const, meters: 800 },
    ]).flat(),
    { kind: 'cooldown', seconds: 120 },
  ],
}

const scenario = { easyPaceSecPerKm: 390, hardPaceSecPerKm: 285 }

describe('syntheticSamples', () => {
  test('1Hz stream, monotonic time and distance, covers the whole plan', () => {
    const s = syntheticSamples(plan, scenario)
    expect(s[0].tMs).toBe(1000)
    for (let i = 1; i < s.length; i++) {
      expect(s[i].tMs - s[i - 1].tMs).toBe(1000)
      expect(s[i].distanceM!).toBeGreaterThan(s[i - 1].distanceM!)
    }
    // 4×(400+800) = 4800m of distance steps must be covered.
    expect(s[s.length - 1].distanceM!).toBeGreaterThanOrEqual(4800)
    // Duration ≈ nominal + 20s tail (within a minute of slack).
    const nominal = nominalDurationMs(plan, scenario)
    expect(Math.abs(s[s.length - 1].tMs - (nominal + 20_000))).toBeLessThanOrEqual(60_000)
  })

  test('hard steps are run faster than easy steps', () => {
    const s = syntheticSamples(plan, scenario)
    // Speed during the first hard rep (after warmup 180s + 400m easy ≈ 156s)
    const at = (tMs: number) => s.find((x) => x.tMs === tMs)!
    const easySpeed = at(60_000).distanceM! - at(50_000).distanceM!
    const hardMid = 180_000 + 156_000 + 60_000 // safely inside the first 800m hard
    const hardSpeed = at(hardMid).distanceM! - at(hardMid - 10_000).distanceM!
    expect(hardSpeed).toBeGreaterThan(easySpeed * 1.2)
  })

  test('fatigue stretches the run', () => {
    const fresh = syntheticSamples(plan, scenario)
    const tired = syntheticSamples(plan, { ...scenario, fatiguePct: 15 })
    expect(tired[tired.length - 1].tMs).toBeGreaterThan(fresh[fresh.length - 1].tMs)
  })
})

describe('simulate', () => {
  test('4 hard reps → 4 landings, each within 5s, spans mirror the plan', () => {
    const r = simulate(plan, songs, syntheticSamples(plan, scenario))
    expect(r.landings.length).toBe(4)
    for (const l of r.landings) expect(Math.abs(l.errorMs)).toBeLessThanOrEqual(5000)
    expect(r.stepSpans.length).toBe(plan.steps.length)
    // Spans are contiguous from t=0.
    expect(r.stepSpans[0].startMs).toBe(0)
    for (let i = 1; i < r.stepSpans.length; i++) {
      expect(r.stepSpans[i].startMs).toBe(r.stepSpans[i - 1].endMs)
    }
  })

  test('noisy, fatiguing runner still gets bounded landings', () => {
    const r = simulate(plan, songs, syntheticSamples(plan, { ...scenario, fatiguePct: 12, noisePct: 6 }))
    expect(r.landings.length).toBe(4)
    for (const l of r.landings) expect(Math.abs(l.errorMs)).toBeLessThanOrEqual(8000)
  })

  test('trace records the engine mind: pace adapts, ETA counts down to hard', () => {
    const r = simulate(plan, songs, syntheticSamples(plan, scenario))
    const preHard = r.trace.filter((p) => p.mode === 'build')
    expect(preHard.length).toBeGreaterThan(0)
    // Engine's EMA pace should converge near the easy pace during the easy km.
    const late = r.trace.find((p) => p.tMs === 170_000)!
    expect(Math.abs(late.paceSecPerKm - scenario.easyPaceSecPerKm)).toBeLessThanOrEqual(30)
  })
})

describe('loadSessionLog', () => {
  test('new format: samples pass through, sorted', () => {
    const log = loadSessionLog({
      plan: { name: 'x', steps: [{ kind: 'easy', seconds: 60 }] },
      samples: [
        { tMs: 2000, distanceM: 6, hr: 130 },
        { tMs: 1000, distanceM: 3, hr: 128 },
      ],
    })
    expect(log.plan?.name).toBe('x')
    expect(log.samples.map((s) => s.tMs)).toEqual([1000, 2000])
    expect(log.samples[0].distanceM).toBe(3)
  })

  test('old format: hr entries become time-only samples', () => {
    const log = loadSessionLog({ hr: [{ atMs: 1000, hr: 120 }, { atMs: 2000, hr: 125 }] })
    expect(log.samples.length).toBe(2)
    expect(log.samples[1]).toEqual({ tMs: 2000, hr: 125 })
    expect(log.plan).toBeNull()
  })
})
