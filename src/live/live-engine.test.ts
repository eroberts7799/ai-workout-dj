import { describe, expect, test } from 'bun:test'
import { LiveEngine, type LiveSample, type PlayCommand } from './live-engine'
import type { SongTags, WorkoutPlan } from '../conductor/types'

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

/** 1Hz sample stream over piecewise-constant speeds: [{seconds, mps}]. */
function stream(phases: { seconds: number; mps: number }[]): LiveSample[] {
  const out: LiveSample[] = []
  let t = 0
  let d = 0
  for (const p of phases) {
    for (let i = 0; i < p.seconds; i++) {
      t += 1000
      d += p.mps
      out.push({ tMs: t, distanceM: d })
    }
  }
  return out
}

function run(engine: LiveEngine, samples: LiveSample[]): PlayCommand[] {
  for (const s of samples) engine.advance(s)
  return engine.commands
}

/** Distance plan: 1min warmup, 1km easy, 400m hard, then easy. */
const plan: WorkoutPlan = {
  name: 'track',
  steps: [
    { kind: 'warmup', seconds: 60 },
    { kind: 'easy', meters: 1000 },
    { kind: 'hard', meters: 400 },
    { kind: 'easy', meters: 600 },
  ],
}

describe('LiveEngine', () => {
  test('constant pace: drop lands within 1.5s of the real hard-step start', () => {
    // 3 m/s → 1km easy takes 333.3s; hard starts at t = 60 + 333.3 = 393.3s
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 700, mps: 3 }]))
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(1500)
    const build = engine.commands.find((c) => c.reason.startsWith('buildup'))
    expect(build).toBeDefined()
  })

  test('slowing runner: commit happens later, landing still within 4s', () => {
    // Slow to 2 m/s halfway through the easy km — ETA stretches, engine must adapt.
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 200, mps: 3 }, { seconds: 500, mps: 2 }]))
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(4000)
  })

  test('slower runner loops the groove more times than a faster one', () => {
    const fast = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(fast, stream([{ seconds: 600, mps: 3.4 }]))
    const slow = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(slow, stream([{ seconds: 900, mps: 2.2 }]))
    const loops = (e: LiveEngine) => e.commands.filter((c) => c.reason.startsWith('loop back')).length
    expect(loops(slow)).toBeGreaterThan(loops(fast))
  })

  test('hard step end returns to groove; playback never runs off the end of a track', () => {
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    const cmds = run(engine, stream([{ seconds: 900, mps: 3 }]))
    const afterRide = cmds.filter((c) => c.reason.startsWith('groove fill'))
    expect(afterRide.length).toBeGreaterThanOrEqual(2) // initial + post-hard
    for (let i = 0; i < cmds.length; i++) {
      const end = i + 1 < cmds.length ? cmds[i + 1].tMs : 900_000
      const playedTo = cmds[i].positionMs + (end - cmds[i].tMs)
      expect(playedTo).toBeLessThanOrEqual(240_000 + 1500)
    }
  })

  test('buildup entry is snapped to the incoming song beat grid', () => {
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 700, mps: 3 }]))
    const build = engine.commands.find((c) => c.reason.startsWith('buildup'))!
    // 128bpm → 468.75ms beats anchored at the 95s drop: offset must be integral beats.
    const beatMs = 60_000 / 128
    const beats = (95_000 - build.positionMs) / beatMs
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(1e-6)
    // Landing still within tolerance despite the ≤ half-beat shift.
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(1500)
  })

  test('crest reward: topping a real hill in zone 4 fires a drop, once', () => {
    // Long all-easy distance plan; hill from 800m→1200m at 4% (16m gain).
    const easyPlan: WorkoutPlan = { name: 'hills', steps: [{ kind: 'easy', meters: 3000 }] }
    const engine = new LiveEngine(easyPlan, songs, { paceSecPerKm: 340 })
    let d = 0
    let alt = 100
    for (let i = 1; i <= 900; i++) {
      d += 3
      if (d > 800 && d <= 1200) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 160 })
    }
    const crests = engine.commands.filter((c) => c.reason.includes('crest reward'))
    expect(crests.length).toBe(1)
    // Fires near the top of the hill (1200m ≈ t=400s), enters at the drop itself.
    expect(crests[0].positionMs).toBe(95_000)
    expect(crests[0].tMs).toBeGreaterThanOrEqual(395_000)
    expect(crests[0].tMs).toBeLessThanOrEqual(430_000)
    // And the groove returns afterwards (crest ride is time-boxed).
    const after = engine.commands.find((c) => c.tMs > crests[0].tMs && c.reason.startsWith('groove fill'))
    expect(after).toBeDefined()
  })

  test('crest with lazy heart rate earns nothing', () => {
    const easyPlan: WorkoutPlan = { name: 'hills', steps: [{ kind: 'easy', meters: 3000 }] }
    const engine = new LiveEngine(easyPlan, songs, { paceSecPerKm: 340 })
    let d = 0
    let alt = 100
    for (let i = 1; i <= 900; i++) {
      d += 3
      if (d > 800 && d <= 1200) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 100 }) // zone 1
    }
    expect(engine.commands.some((c) => c.reason.includes('crest reward'))).toBe(false)
  })

  test('crest near an imminent hard step defers to the planned drop', () => {
    // Hill crests ~1200m; hard step starts at 1300m — ETA ≈ 33s < 45s guard.
    const nearPlan: WorkoutPlan = {
      name: 'hill-into-effort',
      steps: [
        { kind: 'easy', meters: 1300 },
        { kind: 'hard', meters: 400 },
        { kind: 'easy', meters: 1300 },
      ],
    }
    const engine = new LiveEngine(nearPlan, songs, { paceSecPerKm: 340 })
    let d = 0
    let alt = 100
    for (let i = 1; i <= 1000; i++) {
      d += 3
      if (d > 800 && d <= 1200) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 160 })
    }
    expect(engine.commands.some((c) => c.reason.includes('crest reward'))).toBe(false)
    expect(engine.landings.length).toBe(1) // the hard step still got its drop
  })

  test('time-only plans work without distance data', () => {
    const timePlan: WorkoutPlan = {
      name: 't',
      steps: [
        { kind: 'easy', seconds: 120 },
        { kind: 'hard', seconds: 60 },
        { kind: 'cooldown', seconds: 60 },
      ],
    }
    const engine = new LiveEngine(timePlan, songs)
    const samples: LiveSample[] = Array.from({ length: 240 }, (_, i) => ({ tMs: (i + 1) * 1000 }))
    for (const s of samples) engine.advance(s)
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(1500)
  })
})
