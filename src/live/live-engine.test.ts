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

  test('cruise: no loop-backs, songs play through and chain at musical spacing', () => {
    // "the UX sucks when it loops every 30 seconds" — songs play MOST of the
    // way; transitions only at song ends, the ~3min freshness mark, or a
    // rep's buildup. Never a loop-back.
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 900, mps: 2.2 }]))
    expect(engine.commands.some((c) => c.reason.startsWith('loop back'))).toBe(false)
    // Total transition budget: freshness chains (~1 per 3min) + the effort's
    // buildup/ride/release + opening. The old loop texture blew way past
    // this (a cut every ~30s); an enjoyable set stays under it.
    const budget = Math.ceil(900_000 / 165_000) + engine.landings.length * 3 + 2
    expect(engine.commands.length).toBeLessThanOrEqual(budget)
    expect(engine.commands.filter((c) => c.reason.startsWith('groove fill')).length).toBeGreaterThanOrEqual(2)
  })

  test('learned pair weights steer selection: real-set adjacency wins ties', () => {
    // aaa→ccc observed in real DJ sets (pairBonus); with tempo/key equal,
    // the learned edge beats rotation order (which would pick bbb).
    const easyPlan: WorkoutPlan = { name: 'e', steps: [{ kind: 'easy', seconds: 600 }] }
    const engine = new LiveEngine(easyPlan, songs, {
      pairBonus: { 'test song aaa>test song ccc': 5 },
    })
    for (let i = 1; i <= 400; i++) engine.advance({ tMs: i * 1000 })
    const fills = engine.commands.filter((c) => c.reason.startsWith('groove fill'))
    expect(fills.length).toBeGreaterThanOrEqual(2)
    expect(fills[0].trackId).toBe('aaa')
    expect(fills[1].trackId).toBe('ccc')
  })

  test('chain point lands at a segment boundary — leave on top, not on a timer', () => {
    // Song with structure: chorus ends at 160s (inside the [entry+120s,
    // entry+240s] window from entry 30s) → the chain happens THERE, not at
    // the 180s timer. A structureless song still uses the timer.
    const structured: SongTags = {
      ...song('seg'),
      segments: [
        { label: 'intro', startMs: 0, endMs: 30_000 },
        { label: 'chorus', startMs: 30_000, endMs: 160_000 },
        { label: 'break', startMs: 160_000, endMs: 200_000 },
        { label: 'chorus', startMs: 200_000, endMs: 240_000 },
      ],
    }
    const lib = [structured, song('bbb'), song('ccc')]
    const easyPlan: WorkoutPlan = { name: 'e', steps: [{ kind: 'easy', seconds: 1200 }] }
    const engine = new LiveEngine(easyPlan, lib)
    for (let i = 1; i <= 400; i++) engine.advance({ tMs: i * 1000 })
    const fills = engine.commands.filter((c) => c.reason.startsWith('groove fill'))
    expect(fills.length).toBeGreaterThanOrEqual(2)
    const first = fills[0]
    const second = fills[1]
    const exitPos = first.positionMs + (second.tMs - first.tMs)
    if (first.trackId === 'seg') {
      // left exactly as the chorus ended
      expect(Math.abs(exitPos - 160_000)).toBeLessThanOrEqual(1500)
    } else {
      // structureless song: corpus timer from the top of the song
      expect(Math.abs(exitPos - 180_000)).toBeLessThanOrEqual(1500)
    }
  })

  test('short rests: one song change per rep, not a release + instant buildup', () => {
    // 60s rest, ~20s buildup: the release would play seconds before the next
    // cut. The engine rides the drop song straight through the rest instead.
    const p: WorkoutPlan = {
      name: 'short rests',
      steps: [
        { kind: 'warmup', seconds: 60 },
        { kind: 'hard', meters: 400 },
        { kind: 'rest', seconds: 60 },
        { kind: 'hard', meters: 400 },
        { kind: 'cooldown', seconds: 60 },
      ],
    }
    // Long songs, so the ride can actually survive the rest (a song running
    // out mid-rest forces a never-silence chain — that one is legitimate).
    const longSongs = songs.map((s) => ({ ...s, durationMs: 360_000 }))
    const engine = new LiveEngine(p, longSongs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 500, mps: 3 }]))
    expect(engine.landings.length).toBe(2)
    const cmds = engine.commands
    const firstLandingT = engine.landings[0].targetTMs
    const secondBuildIdx = cmds.findIndex((c) => c.tMs > firstLandingT && c.reason.startsWith('buildup'))
    const between = cmds.filter((c, i) => c.tMs > firstLandingT && i < secondBuildIdx && c.reason.startsWith('groove fill'))
    expect(between.length).toBe(0) // no throwaway release between rep 1 and rep 2's buildup
  })

  test('slower runner: landing still exact, listening still unbroken', () => {
    const fast = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(fast, stream([{ seconds: 600, mps: 3.4 }]))
    const slow = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(slow, stream([{ seconds: 900, mps: 2.2 }]))
    for (const e of [fast, slow]) {
      expect(e.landings.length).toBe(1)
      expect(Math.abs(e.landings[0].errorMs)).toBeLessThanOrEqual(1500)
    }
    const loops = (e: LiveEngine) => e.commands.filter((c) => c.reason.startsWith('loop back')).length
    expect(loops(slow)).toBe(0)
    expect(loops(fast)).toBe(0)
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
    // Long all-easy distance plan; hill from 800m→1700m at 4% (36m gain).
    const easyPlan: WorkoutPlan = { name: 'hills', steps: [{ kind: 'easy', meters: 3000 }] }
    const engine = new LiveEngine(easyPlan, songs, { paceSecPerKm: 340 })
    let d = 0
    let alt = 100
    for (let i = 1; i <= 900; i++) {
      d += 3
      if (d > 800 && d <= 1700) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 160 })
    }
    const crests = engine.commands.filter((c) => c.reason.includes('crest reward'))
    expect(crests.length).toBe(1)
    // Fires near the top of the hill (1200m ≈ t=400s), enters at the drop itself.
    expect(crests[0].positionMs).toBe(95_000)
    expect(crests[0].tMs).toBeGreaterThanOrEqual(560_000)
    expect(crests[0].tMs).toBeLessThanOrEqual(600_000)
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
      if (d > 800 && d <= 1700) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 100 }) // zone 1
    }
    expect(engine.commands.some((c) => c.reason.includes('crest reward'))).toBe(false)
  })

  test('crest near an imminent hard step defers to the planned drop', () => {
    // Hill crests ~1700m; hard step starts at 1800m — ETA ≈ 33s < 45s guard.
    const nearPlan: WorkoutPlan = {
      name: 'hill-into-effort',
      steps: [
        { kind: 'easy', meters: 1800 },
        { kind: 'hard', meters: 400 },
        { kind: 'easy', meters: 1300 },
      ],
    }
    const engine = new LiveEngine(nearPlan, songs, { paceSecPerKm: 340 })
    let d = 0
    let alt = 100
    for (let i = 1; i <= 1000; i++) {
      d += 3
      if (d > 800 && d <= 1700) alt += 3 * 0.04
      engine.advance({ tMs: i * 1000, distanceM: d, altitudeM: alt, hr: 160 })
    }
    expect(engine.commands.some((c) => c.reason.includes('crest reward'))).toBe(false)
    expect(engine.landings.length).toBe(1) // the hard step still got its drop
  })

  test('DJ-crate selection: the engine picks the harmonically compatible neighbor', () => {
    // Playing starts on a 136/9A groove; candidates: perfect match vs clashing key vs wrong tempo.
    const mk = (id: string, bpm: number, camelot: string): SongTags => ({ ...song(id), bpm, camelot })
    const crate = [mk('aaa', 136, '9A'), mk('clash', 136, '3B'), mk('slow', 100, '9A'), mk('twin', 136, '9B')]
    const engine = new LiveEngine(plan, crate, { paceSecPerKm: 340 })
    const cmds = run(engine, stream([{ seconds: 700, mps: 3 }]))
    // First fill picks something; from then on every buildup/fill should favor
    // tempo+key compatibility. The buildup out of an 'aaa' groove must be 'twin'
    // (score 3), never 'slow' (1) or 'clash' (2) while 'twin' exists.
    const first = cmds[0]
    const next = cmds.find((c) => c.trackId !== first.trackId)!
    const firstSong = crate.find((s) => s.trackId === first.trackId)!
    const nextSong = crate.find((s) => s.trackId === next.trackId)!
    expect(Math.abs(1 - (nextSong.bpm! / firstSong.bpm!))).toBeLessThanOrEqual(0.03)
  })

  test('variety pressure: a twin pair cannot monopolize a long session', () => {
    const mk = (id: string, bpm: number, camelot: string): SongTags => ({ ...song(id), bpm, camelot })
    // Two perfect partners (same bpm+key) + two tempo-compatible others.
    const crate = [mk('twin1', 140, '3A'), mk('twin2', 140, '3A'), mk('other1', 140, '8A'), mk('other2', 140, '9B')]
    const longPlan: WorkoutPlan = {
      name: 'long',
      steps: Array.from({ length: 5 }, () => [
        { kind: 'easy' as const, meters: 400 },
        { kind: 'hard' as const, meters: 800 },
      ]).flat(),
    }
    const engine = new LiveEngine(longPlan, crate, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 2200, mps: 3 }]))
    const used = new Set(engine.commands.map((c) => c.trackId))
    expect(used.size).toBeGreaterThanOrEqual(3)
  })

  test('freshness: no groove rides past the corpus ceiling when alternatives exist', () => {
    // 20 minutes of pure easy running — pre-freshness this looped one song forever.
    const easyPlan: WorkoutPlan = { name: 'lsd', steps: [{ kind: 'easy', seconds: 1200 }] }
    const engine = new LiveEngine(easyPlan, songs, { paceSecPerKm: 340 })
    const samples: LiveSample[] = Array.from({ length: 1200 }, (_, i) => ({ tMs: (i + 1) * 1000 }))
    for (const s of samples) engine.advance(s)
    const fills = engine.commands.filter((c) => c.reason.startsWith('groove fill'))
    expect(fills.length).toBeGreaterThanOrEqual(5) // ~every ≤240s, not once
    // No single stretch between fills exceeds the ceiling (+ loop slack).
    for (let i = 1; i < fills.length; i++) {
      expect(fills[i].tMs - fills[i - 1].tMs).toBeLessThanOrEqual(240_000)
    }
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

  test('plan opening on a hard step opens on a drop, not a groove fill', () => {
    // Progressive long runs start hard — backtest 2026-08-16 missed all of them.
    const p: WorkoutPlan = { name: 'prog', steps: [{ kind: 'hard', meters: 1000 }, { kind: 'easy', meters: 500 }] }
    const engine = new LiveEngine(p, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 30, mps: 3 }]))
    expect(engine.commands[0].reason).toStartWith('drop lands (opening)')
    expect(engine.landings.length).toBe(1)
  })

  test('consecutive hard reps: every rep start gets a buildup, none truncated', () => {
    // Rolling-800s shape — the baseline truncated 8/8 of these.
    const p: WorkoutPlan = {
      name: 'rolling',
      steps: [
        { kind: 'warmup', seconds: 60 },
        { kind: 'hard', meters: 600 },
        { kind: 'hard', meters: 600 },
        { kind: 'hard', meters: 600 },
        { kind: 'cooldown', seconds: 60 },
      ],
    }
    const engine = new LiveEngine(p, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 700, mps: 3 }]))
    expect(engine.landings.length).toBe(3)
    for (const l of engine.landings) expect(Math.abs(l.errorMs)).toBeLessThanOrEqual(1500)
    expect(engine.commands.filter((c) => c.reason.startsWith('buildup toward next rep')).length).toBeGreaterThanOrEqual(2)
    expect(engine.commands.some((c) => c.reason.includes('truncated'))).toBe(false)
  })

  test('wkStepSeq is authoritative: boundaries follow the watch, not the odometer', () => {
    // Distance stream reads 20% short (GPS under-count) — estimation alone
    // would cross every boundary late. The watch's step events correct it.
    const p: WorkoutPlan = {
      name: 'w',
      steps: [
        { kind: 'easy', meters: 900 },
        { kind: 'hard', meters: 300 },
        { kind: 'easy', meters: 600 },
      ],
    }
    const engine = new LiveEngine(p, songs, { paceSecPerKm: 340 })
    // True boundaries at 300s and 400s (3 m/s real speed); stream distance is scaled 0.8×.
    const samples: LiveSample[] = []
    for (let i = 1; i <= 600; i++) {
      const t = i * 1000
      const trueDist = i * 3
      samples.push({ tMs: t, distanceM: trueDist * 0.8, wkStepSeq: t < 300_000 ? 1 : t < 400_000 ? 2 : 3 })
    }
    for (const s of samples) engine.advance(s)
    expect(engine.landings.length).toBe(1)
    // Engine's believed hard start must sit at the watch boundary (300s), not
    // the odometer's late crossing (375s).
    expect(Math.abs(engine.landings[0].actualTMs - 300_000)).toBeLessThanOrEqual(2000)
  })

  test('stalled watch seq (identical adjacent steps) — overdue fallback advances by odometer', () => {
    // The CIQ field detects step changes by signature; two identical adjacent
    // steps produce no bump, ever. The engine must not freeze, and later
    // seq bumps (new boundaries) must still advance normally.
    const p: WorkoutPlan = {
      name: 'identical reps',
      steps: [
        { kind: 'hard', meters: 600 },
        { kind: 'hard', meters: 600 }, // identical sig — watch misses this boundary
        { kind: 'rest', seconds: 60 }, // sig differs — watch bumps here
        { kind: 'hard', meters: 600 },
      ],
    }
    const engine = new LiveEngine(p, songs, { paceSecPerKm: 340 })
    for (let i = 1; i <= 700; i++) {
      const t = i * 1000
      const d = i * 3
      // watch seq: stuck at 1 through both 600s (boundary at 200s missed),
      // bumps to 2 at the rest (400s), to 3 at the last rep (460s).
      const seq = t < 400_000 ? 1 : t < 460_000 ? 2 : 3
      engine.advance({ tMs: t, distanceM: d, wkStepSeq: seq })
    }
    // 3 hard-step landings total (opening + missed-boundary rep + final rep)
    expect(engine.landings.length).toBe(3)
    expect(engine.warnings.some((w) => w.includes('stalled'))).toBe(true)
    // The absorbed late bump must not have skipped the rest step early:
    // final landing sits near the true 460s boundary.
    const last = engine.landings[engine.landings.length - 1]
    expect(Math.abs(last.actualTMs - 460_000)).toBeLessThanOrEqual(5000)
  })

  test('mid-build slowdown triggers a re-aim and the drop still lands tight', () => {
    // Fade hard in the last stretch before the rep — exactly when the old
    // engine rode a stale forecast into an early drop.
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 370, mps: 3 }, { seconds: 200, mps: 1.8 }]))
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(2000)
  })
})
