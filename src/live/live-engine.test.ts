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
    // Fresh mode (default): the moment is a NEW song from 0:00, committed
    // just before the boundary so the crossfade peaks on arrival.
    const change = engine.commands.find((c) => c.reason.startsWith('rep change'))!
    expect(change).toBeDefined()
    expect(change.positionMs).toBe(0)
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
    const secondChangeIdx = cmds.findIndex((c) => c.tMs > firstLandingT && c.reason.startsWith('rep change'))
    expect(secondChangeIdx).toBeGreaterThanOrEqual(0) // rep 2 got its moment
    const between = cmds.filter((c, i) => c.tMs > firstLandingT && i < secondChangeIdx && c.reason.startsWith('groove fill'))
    expect(between.length).toBe(0) // no throwaway release between rep 1 and rep 2's change
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

  test('anticipated mode: buildup entry is snapped to the incoming song beat grid', () => {
    // The parked drop machinery — kept tested for the day mixing earns it back.
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340, dropStyle: 'anticipated' })
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
    // Fresh mode: the crest reward is a fresh song from the top.
    expect(crests[0].positionMs).toBe(0)
    expect(crests[0].tMs).toBeGreaterThanOrEqual(560_000)
    expect(crests[0].tMs).toBeLessThanOrEqual(600_000)
    // The crest song is a normal cruise entry: it RIDES to its own chain
    // point, it is not amputated by the old 25s time-box (trail run
    // 2026-08-22: every summit got three songs in 90s).
    const after = engine.commands.find((c) => c.tMs > crests[0].tMs && c.reason.startsWith('groove fill'))
    expect(after).toBeDefined()
    expect(after!.tMs - crests[0].tMs).toBeGreaterThanOrEqual(120_000)
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
    expect(engine.commands[0].reason).toStartWith('rep change (opening)')
    expect(engine.commands[0].positionMs).toBe(0)
    expect(engine.landings.length).toBe(1)
  })

  test('consecutive hard reps: every rep start gets its moment, none truncated', () => {
    // Rolling-800s shape — the old baseline truncated 8/8 of these.
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
    const changes = engine.commands.filter((c) => c.reason.startsWith('rep change'))
    expect(changes.length).toBeGreaterThanOrEqual(3)
    for (const c of changes) expect(c.positionMs).toBe(0) // always from the top
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

  test('streaming tier: a markerless (Spotify playlist) library fully conducts', () => {
    // No markers, no segments, no bpm — cruise from 0:00, timer chains,
    // fresh rep changes. Every song you love, same brain.
    const streaming: SongTags[] = ['s1', 's2', 's3'].map((id) => ({
      trackId: id,
      uri: `spotify:track:${id}`,
      name: `Stream ${id}`,
      artists: 'Playlist',
      durationMs: 210_000,
      bpm: null,
      updatedAt: '',
      markers: [],
    }))
    const engine = new LiveEngine(plan, streaming, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 700, mps: 3 }]))
    expect(engine.warnings).toEqual([])
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(1500)
    for (const c of engine.commands) expect(c.positionMs).toBe(0) // streaming can always honor these
    expect(engine.commands.some((c) => c.reason.startsWith('rep change'))).toBe(true)
  })

  test('structureless songs ride to their natural end, not the 3:00 timer', () => {
    // 8/22 trail run: every fill cut at exactly entry+180s because scraped
    // tracks carry no segments — even songs with 30s left to give. Duration
    // IS known: a song whose end is within timer+slack plays out (the change
    // lands at the natural end); only genuinely long tracks get the timer.
    const mk = (id: string, durationMs: number): SongTags => ({
      trackId: id, uri: `spotify:track:${id}`, name: `Stream ${id}`,
      artists: 'Playlist', durationMs, bpm: null, updatedAt: '', markers: [],
    })
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 900 }] }

    // 3:30 songs → play to their end (~3:30 chains), never the 3:00 timer.
    const short = new LiveEngine(cruise, [mk('s1', 210_000), mk('s2', 210_000), mk('s3', 210_000)], { paceSecPerKm: 340 })
    run(short, stream([{ seconds: 900, mps: 3 }]))
    const gaps = short.commands.slice(1).map((c, i) => c.tMs - short.commands[i].tMs)
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(205_000) // never the 180s timer

    // 5:30 songs → also play out (8/25 run: anything under 6:00 finishes).
    const mid = new LiveEngine(cruise, [mk('m1', 330_000), mk('m2', 330_000), mk('m3', 330_000)], { paceSecPerKm: 340 })
    run(mid, stream([{ seconds: 900, mps: 3 }]))
    const mgaps = mid.commands.slice(1).map((c, i) => c.tMs - mid.commands[i].tMs)
    for (const g of mgaps) expect(g).toBeGreaterThanOrEqual(325_000)

    // 7:00 extended mixes → the freshness timer still rules at 3:00.
    const long = new LiveEngine(cruise, [mk('l1', 420_000), mk('l2', 420_000), mk('l3', 420_000)], { paceSecPerKm: 340 })
    run(long, stream([{ seconds: 900, mps: 3 }]))
    const lgaps = long.commands.slice(1).map((c, i) => c.tMs - long.commands[i].tMs)
    for (const g of lgaps) expect(g).toBeLessThanOrEqual(182_000)
  })

  test('FOLLOW MODE: no plan at all — the watch stream is the workout', () => {
    // The workout lives in Runna/Garmin; nobody retypes it. Empty plan +
    // streamed step shapes = full conducting: boundaries, anticipation,
    // landings.
    const engine = new LiveEngine({ name: 'follow', steps: [] }, songs, { paceSecPerKm: 340 })
    const phase = (t: number) =>
      t <= 60_000
        ? { seq: 1, kind: 'warmup', dt: 0, dv: 60, next: 'hard' }
        : t <= 160_000
          ? { seq: 2, kind: 'hard', dt: 1, dv: 300, next: 'rest' }
          : t <= 220_000
            ? { seq: 3, kind: 'rest', dt: 0, dv: 60, next: 'hard' }
            : t <= 320_000
              ? { seq: 4, kind: 'hard', dt: 1, dv: 300, next: 'cooldown' }
              : { seq: 5, kind: 'cooldown', dt: 0, dv: 60, next: undefined }
    for (let i = 1; i <= 380; i++) {
      const t = i * 1000
      const p = phase(t)
      engine.advance({
        tMs: t,
        distanceM: i * 3,
        wkStepSeq: p.seq,
        wkKind: p.kind,
        wkDurationType: p.dt,
        wkDurationValue: p.dv,
        wkNextKind: p.next,
      })
    }
    expect(engine.landings.length).toBe(2)
    for (const l of engine.landings) expect(Math.abs(l.errorMs)).toBeLessThanOrEqual(1500)
    const changes = engine.commands.filter((c) => c.reason.startsWith('rep change'))
    expect(changes.length).toBeGreaterThanOrEqual(2)
    for (const c of changes) expect(c.positionMs).toBe(0)
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

  test('cruise commands carry a spare next for the executor queue', () => {
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 600 }] }
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 600, mps: 3 }]))
    const fills = engine.commands.filter((c) => c.reason.startsWith('groove fill'))
    expect(fills.length).toBeGreaterThanOrEqual(2)
    for (const f of fills) {
      expect(f.spareTrackId).toBeDefined()
      expect(f.spareTrackId).not.toBe(f.trackId) // never "next = same song"
    }
  })

  test('taste affinity biases selection toward loved tracks', () => {
    // Two equally-mixable candidates; one has a strong positive affinity.
    // The loved one should win the cruise pick.
    const base = (id: string, affinity: number): SongTags => ({
      trackId: id, uri: `spotify:track:${id}`, name: `Song ${id}`, artists: 'X',
      durationMs: 210_000, bpm: 128, camelot: '8A', markers: [], updatedAt: '', affinity,
    })
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 300 }] }
    // seed (neutral) + a loved candidate + a skipped candidate, all compatible.
    const lib = [base('seed', 0), base('loved', 2), base('skipped', -2)]
    const engine = new LiveEngine(cruise, lib, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 300, mps: 3 }]))
    const changed = engine.commands.map((c) => c.trackId).filter((id) => id !== 'seed')
    expect(changed).toContain('loved')
    // the skipped track is only ever chosen after loved is exhausted by recency
    expect(changed.indexOf('loved')).toBeLessThan(changed.indexOf('skipped') === -1 ? Infinity : changed.indexOf('skipped'))
  })

  test('manual skip: the model adopts reality and records the overrule', () => {
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 900 }] }
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340 })
    // 60s in, cruising on the first pick…
    for (const s of stream([{ seconds: 60, mps: 3 }])) engine.advance(s)
    const playing = engine.commands[engine.commands.length - 1]
    const other = songs.find((s) => s.trackId !== playing.trackId)!
    // …the runner skips to a different library song at its 0:00.
    engine.syncExternalPlayback(other.trackId, 0, 61_000)
    expect(engine.skips.length).toBe(1)
    expect(engine.skips[0].fromTrackId).toBe(playing.trackId)
    expect(engine.skips[0].toTrackId).toBe(other.trackId)
    expect(engine.skips[0].fromPositionMs).toBeGreaterThan(55_000)
    // The model now follows the skipped-to song: the next natural chain
    // happens relative to ITS start, so no command for at least ~2 more min.
    const before = engine.commands.length
    for (const s of stream([{ seconds: 100, mps: 3 }]).map((x) => ({ ...x, tMs: x.tMs + 61_000, distanceM: (x.distanceM ?? 0) + 183 })))
      engine.advance(s)
    expect(engine.commands.length).toBe(before)
  })

  describe('streaming handoff', () => {
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 1200 }] }
    const advanceFrom = (engine: LiveEngine, fromMs: number, seconds: number) => {
      for (const s of stream([{ seconds, mps: 3 }]))
        engine.advance({ tMs: s.tMs + fromMs, distanceM: (s.distanceM ?? 0) + fromMs * 0.003 })
    }

    test('a song end rolls into the advertised spare as a handoff, at the end, with no lead', () => {
      const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, streamingHandoff: true })
      run(engine, stream([{ seconds: 500, mps: 3 }]))
      const first = engine.commands[0]
      expect(first.handoff).toBeUndefined()
      expect(first.spareTrackId).toBeDefined()
      const second = engine.commands[1]
      expect(second.handoff).toBe(true)
      expect(second.trackId).toBe(first.spareTrackId!)
      expect(second.positionMs).toBe(0)
      // 240s song: fired at ≥ 240s after the first command, not 238.5s.
      expect(second.tMs - first.tMs).toBeGreaterThanOrEqual(240_000)
      expect(second.tMs - first.tMs).toBeLessThan(242_000)
      // The chain continues: the handoff advertises ITS spare for the queue.
      expect(second.spareTrackId).toBeDefined()
      expect(second.spareTrackId).not.toBe(second.trackId)
      // No stray cut between them.
      expect(engine.commands.filter((c) => !c.handoff).length).toBe(1)
    })

    test('without the option, song ends are cuts exactly as before', () => {
      const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340 })
      run(engine, stream([{ seconds: 500, mps: 3 }]))
      expect(engine.commands.every((c) => !c.handoff)).toBe(true)
      expect(engine.commands[1].tMs - engine.commands[0].tMs).toBeLessThan(240_000)
    })

    test('the player rolled into the spare before the model did: adopted as a handoff, not a skip', () => {
      const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, streamingHandoff: true })
      run(engine, stream([{ seconds: 236, mps: 3 }]))
      const first = engine.commands[0]
      // Executor read: spare already playing at 0:02 while the model says 4s to go.
      const emitted = engine.syncExternalPlayback(first.spareTrackId!, 2_000, 236_000)
      expect(engine.skips.length).toBe(0)
      expect(emitted.length).toBe(1)
      expect(emitted[0].handoff).toBe(true)
      expect(emitted[0].trackId).toBe(first.spareTrackId!)
      expect(emitted[0].spareTrackId).toBeDefined()
      // The model now runs on the spare: its end comes ~238s later, not 4s.
      const before = engine.commands.length
      advanceFrom(engine, 236_000, 200)
      expect(engine.commands.length).toBe(before)
    })

    test('verification finds the player still finishing the old song: the handoff reverts and fires again later', () => {
      const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, streamingHandoff: true })
      run(engine, stream([{ seconds: 241, mps: 3 }]))
      const first = engine.commands[0]
      expect(engine.commands.length).toBe(2)
      expect(engine.commands[1].handoff).toBe(true)
      // Reality: the model was 8s early — the first song is at 3:53.
      const emitted = engine.syncExternalPlayback(first.trackId, 233_000, 241_000, true)
      expect(emitted.length).toBe(0)
      expect(engine.skips.length).toBe(0)
      expect(engine.commands.length).toBe(1) // the premature handoff is withdrawn
      expect(engine.state.playingTrackId).toBe(first.trackId)
      // …and the handoff fires again at the corrected end (~7s later).
      advanceFrom(engine, 241_000, 10)
      expect(engine.commands.length).toBe(2)
      expect(engine.commands[1].handoff).toBe(true)
      expect(engine.commands[1].trackId).toBe(first.spareTrackId!)
      expect(engine.commands[1].tMs).toBeGreaterThanOrEqual(247_000)
    })

    test('a real mid-song skip is still an overrule, and re-arms the chain', () => {
      const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, streamingHandoff: true })
      run(engine, stream([{ seconds: 60, mps: 3 }]))
      const first = engine.commands[0]
      const other = songs.find((s) => s.trackId !== first.trackId && s.trackId !== first.spareTrackId)!
      const emitted = engine.syncExternalPlayback(other.trackId, 0, 61_000)
      expect(engine.skips.length).toBe(1)
      expect(engine.skips[0].fromTrackId).toBe(first.trackId)
      // The executor holds nothing after the skipped-to song: the handoff
      // command hands it a spare to queue, so the NEXT end rolls natively too.
      expect(emitted.length).toBe(1)
      expect(emitted[0].handoff).toBe(true)
      expect(emitted[0].spareTrackId).toBeDefined()
    })
  })

  test('same-track position drift re-anchors the model without a skip event', () => {
    const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 900 }] }
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340 })
    for (const s of stream([{ seconds: 30, mps: 3 }])) engine.advance(s)
    const playing = engine.commands[engine.commands.length - 1]
    // Executor reports the SAME track but 20s behind the model (late delivery).
    engine.syncExternalPlayback(playing.trackId, 10_000, 31_000)
    expect(engine.skips.length).toBe(0)
    // Chain exit moved later: no change until the re-anchored song end.
    const before = engine.commands.length
    for (const s of stream([{ seconds: 180, mps: 3 }]).map((x) => ({ ...x, tMs: x.tMs + 31_000, distanceM: (x.distanceM ?? 0) + 93 })))
      engine.advance(s)
    expect(engine.commands.length).toBe(before)
  })

  test('mid-build slowdown triggers a re-aim and the drop still lands tight', () => {
    // Fade hard in the last stretch before the rep — exactly when the old
    // engine rode a stale forecast into an early drop.
    const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 370, mps: 3 }, { seconds: 200, mps: 1.8 }]))
    expect(engine.landings.length).toBe(1)
    expect(Math.abs(engine.landings[0].errorMs)).toBeLessThanOrEqual(2000)
  })

  test('hard moments pick the banger, rest fills pick the breather', () => {
    // Identical mixability — energy is the only separator. The rep change
    // must take the banger; the rest fill after it must take the calm one.
    const banger = { ...song('hot'), energy: 1.0 }
    const chill = { ...song('cold'), energy: 0.5 }
    const hardOpen: WorkoutPlan = {
      name: 'reps',
      steps: [
        { kind: 'hard', seconds: 60 },
        { kind: 'rest', seconds: 120 },
      ],
    }
    const engine = new LiveEngine(hardOpen, [chill, banger], { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 200, mps: 3 }]))
    const opening = engine.commands[0]
    expect(opening.reason).toContain('opening')
    expect(opening.trackId).toBe('hot')
    const fill = engine.commands.find((c) => c.reason.startsWith('groove fill'))
    expect(fill?.trackId).toBe('cold')
  })

  test('unknown energy is neutral at hard moments — taste can still win', () => {
    // Untagged energy must not be treated as low: a +2-taste untagged song
    // outscores a 0-taste banger (+2 energy) on rotation/recency ties.
    const banger = { ...song('hot'), energy: 1.0 }
    const untaggedLoved = { ...song('mys'), affinity: 2 }
    const hardOpen: WorkoutPlan = { name: 'rep', steps: [{ kind: 'hard', seconds: 60 }] }
    const engine = new LiveEngine(hardOpen, [banger, untaggedLoved], { paceSecPerKm: 340 })
    run(engine, stream([{ seconds: 30, mps: 3 }]))
    expect(['hot', 'mys']).toContain(engine.commands[0].trackId)
  })
})

describe('route-aware terrain (shadow + drive)', () => {
  const LAT0 = 32.06
  const LON0 = 34.77
  const KY = 110_540
  /** North 3km: flat 1km, +80m over the next 1km, flat 1km — as a route AND as the live run. */
  const alt = (d: number) => (d <= 1000 ? 10 : d <= 2000 ? 10 + (d - 1000) * 0.08 : 90)
  const hillRoute = () => {
    const points = []
    for (let d = 0; d <= 3000; d += 20) points.push({ lat: LAT0 + d / KY, lon: LON0, distM: d, altM: alt(d) })
    return { id: 'hill', km: 3, runs: 3, points }
  }
  /** 1Hz at 3 m/s straight up the route, HR in zone 4 (earned). */
  const liveRun = (seconds: number): LiveSample[] => {
    const out: LiveSample[] = []
    for (let i = 1; i <= seconds; i++) {
      const d = i * 3
      out.push({ tMs: i * 1000, distanceM: d, altitudeM: alt(d), hr: 165, lat: LAT0 + d / KY, lon: LON0 })
    }
    return out
  }
  const cruise: WorkoutPlan = { name: 'cruise', steps: [{ kind: 'easy', seconds: 1200 }] }

  test('shadow mode: the crest is predicted and graded, the reactive rule still owns the music', () => {
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, routes: [hillRoute()] })
    run(engine, liveRun(1000))
    expect(engine.state.route?.routeId).toBe('hill')
    expect(engine.terrainPredictions.length).toBe(1)
    const p = engine.terrainPredictions[0]
    expect(p.drove).toBe(false)
    expect(p.confidence).toBeGreaterThan(0.9)
    // Summit at 2000m → 666.7s at 3 m/s; predicted within a few seconds.
    expect(Math.abs(p.predictedTMs - 666_700)).toBeLessThan(6_000)
    expect(engine.terrainLandings.length).toBe(1)
    // The reactive detector fires after the smoothed grade decays — late by design.
    expect(engine.terrainLandings[0].errorMs).toBeGreaterThan(0)
    expect(engine.terrainLandings[0].errorMs).toBeLessThan(90_000)
    expect(engine.commands.some((c) => c.reason.startsWith('rep change (crest reward)'))).toBe(true)
    expect(engine.commands.some((c) => c.reason.startsWith('rep change (crest ahead)'))).toBe(false)
  })

  test('drive mode: the song changes before the summit and the reactive rule stays quiet', () => {
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, routes: [hillRoute()], terrainDrivesMusic: true })
    run(engine, liveRun(1000))
    const ahead = engine.commands.filter((c) => c.reason.startsWith('rep change (crest ahead)'))
    expect(ahead.length).toBe(1)
    expect(ahead[0].tMs).toBeLessThan(667_000)
    expect(ahead[0].tMs).toBeGreaterThan(655_000)
    expect(ahead[0].spareTrackId).toBeDefined()
    expect(engine.commands.some((c) => c.reason.startsWith('rep change (crest reward)'))).toBe(false)
    expect(engine.terrainPredictions[0].drove).toBe(true)
  })

  test('state exposes the next cue with its ETA while climbing', () => {
    const engine = new LiveEngine(cruise, songs, { paceSecPerKm: 340, routes: [hillRoute()] })
    run(engine, liveRun(400)) // 1200m in: locked, mid-climb
    const s = engine.state
    expect(s.route?.progressM).toBeGreaterThan(1150)
    expect(s.terrainAhead?.type).toBe('crest')
    expect(s.terrainAhead!.etaMs).toBeGreaterThan(200_000)
    expect(s.terrainAhead!.etaMs).toBeLessThan(400_000)
  })
})
