import { describe, expect, test } from 'bun:test'
import { hardStepStarts, planSetlist, totalDurationMs } from './conductor'
import type { SongTags, WorkoutPlan } from './types'

function song(id: string, opts: Partial<SongTags> & { markers?: SongTags['markers'] } = {}): SongTags {
  return {
    trackId: id,
    uri: `spotify:track:${id}`,
    name: `Song ${id}`,
    artists: 'Test Artist',
    durationMs: 240_000,
    bpm: 128,
    markers: [],
    updatedAt: '2026-08-10T00:00:00Z',
    ...opts,
  }
}

const marker = (type: 'buildup' | 'drop' | 'loop_start' | 'loop_end', ms: number) => ({
  id: `${type}-${ms}`,
  type,
  ms,
})

/** 5min warmup, then 4 × (3min easy + 1min hard), 3min cooldown. */
const intervalPlan: WorkoutPlan = {
  name: 'test intervals',
  steps: [
    { kind: 'warmup', seconds: 300 },
    ...Array.from({ length: 4 }, () => [
      { kind: 'easy' as const, seconds: 180 },
      { kind: 'hard' as const, seconds: 60 },
    ]).flat(),
    { kind: 'cooldown', seconds: 180 },
  ],
}

const fullSong = (id: string) =>
  song(id, {
    markers: [
      marker('loop_start', 30_000),
      marker('loop_end', 60_000),
      marker('buildup', 75_000),
      marker('drop', 95_000),
    ],
  })

describe('hardStepStarts', () => {
  test('finds every hard-step start time', () => {
    expect(hardStepStarts(intervalPlan)).toEqual([
      480_000, // 5min warmup + 3min easy
      720_000,
      960_000,
      1_200_000,
    ])
  })

  test('totalDurationMs sums the plan', () => {
    expect(totalDurationMs(intervalPlan)).toBe(1_440_000)
  })
})

describe('planSetlist', () => {
  const songs = [fullSong('aaa'), fullSong('bbb'), fullSong('ccc')]

  test('every hard step gets a drop landing exactly on it', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    for (const target of hardStepStarts(intervalPlan)) {
      const cue = cues
        .filter((c) => c.atMs <= target && c.reason.startsWith('drop lands'))
        .sort((a, b) => b.atMs - a.atMs)[0]
      expect(cue).toBeDefined()
      // The invariant: drop marker time === entry position + elapsed since entry.
      const dropMs = 95_000
      expect(cue.positionMs + (target - cue.atMs)).toBe(dropMs)
    }
  })

  test('buildup is entered at buildup start when there is room', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    const first = cues.find((c) => c.reason.startsWith('drop lands'))!
    // lead = drop − buildup = 20s, so entry at 480s − 20s with position at the buildup marker.
    expect(first.atMs).toBe(480_000 - 20_000)
    expect(first.positionMs).toBe(75_000)
  })

  test('consecutive entry cues alternate tracks (loop-backs exempt — same track by design)', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    const entries = cues.filter((c) => !c.reason.startsWith('loop back'))
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].trackId).not.toBe(entries[i - 1].trackId)
    }
  })

  /** THE prime directive: music never stops. Simulate playback over the cue
   *  list and assert no moment between t=0 and plan end lacks a playing track. */
  function totalSilenceMs(cues: { atMs: number; trackId: string; positionMs: number }[], planEnd: number): number {
    if (cues.length === 0) return planEnd
    let silence = cues[0].atMs // before the first cue
    for (let i = 0; i < cues.length; i++) {
      const dur = 240_000 // all test songs are 4:00
      const end = cues[i].atMs + (dur - cues[i].positionMs)
      const next = i + 1 < cues.length ? cues[i + 1].atMs : planEnd
      if (end < next) silence += next - end
    }
    return silence
  }

  test('zero silence across the whole plan (loops loop, songs chain, cooldown covered)', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    expect(totalSilenceMs(cues, 1_440_000)).toBe(0)
  })

  test('zero silence even with a single song (repeats rather than stopping)', () => {
    const { cues } = planSetlist(intervalPlan, [fullSong('solo')])
    expect(totalSilenceMs(cues, 1_440_000)).toBe(0)
  })

  test('drop songs are never loop-interrupted before their drop lands', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    const targets = hardStepStarts(intervalPlan)
    for (const target of targets) {
      const entry = cues
        .filter((c) => c.atMs <= target && c.reason.startsWith('drop lands'))
        .sort((a, b) => b.atMs - a.atMs)[0]
      // no cue of any kind may interrupt between drop entry and the drop landing
      const interrupters = cues.filter((c) => c.atMs > entry.atMs && c.atMs < target)
      expect(interrupters).toEqual([])
    }
  })

  test('cues are sorted and in-bounds', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    expect(cues.length).toBeGreaterThan(0)
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].atMs).toBeGreaterThanOrEqual(0)
      expect(cues[i].positionMs).toBeGreaterThanOrEqual(0)
      expect(cues[i].positionMs).toBeLessThan(240_000)
      if (i > 0) expect(cues[i].atMs).toBeGreaterThanOrEqual(cues[i - 1].atMs)
    }
  })

  test('easy stretches get groove fills that actually loop', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    const fills = cues.filter((c) => c.reason.startsWith('groove fill'))
    expect(fills.length).toBeGreaterThan(0)
    for (const f of fills) expect(f.positionMs).toBe(30_000) // loop_start
    // the first fill (t=0) must loop its 30s section rather than play past it
    const loopBacks = cues.filter((c) => c.reason.startsWith('loop back') && c.atMs < 460_000)
    expect(loopBacks.length).toBeGreaterThan(3)
    for (const lb of loopBacks) expect(lb.positionMs).toBe(30_000)
  })

  test('fills start after the hard step ends, not on the drop moment', () => {
    const { cues } = planSetlist(intervalPlan, songs)
    // hard step 480-540s: nothing new may start inside it except its own drop entry
    const inside = cues.filter((c) => c.atMs > 480_000 && c.atMs < 540_000)
    expect(inside).toEqual([])
  })

  test('single droppable song: reused rather than silent, no crash', () => {
    const { cues, warnings } = planSetlist(intervalPlan, [fullSong('solo')])
    const drops = cues.filter((c) => c.reason.startsWith('drop lands'))
    expect(drops.length).toBe(4)
    expect(warnings).toEqual([])
  })

  test('no drop markers: warns instead of throwing', () => {
    const { cues, warnings } = planSetlist(intervalPlan, [song('x')])
    expect(cues.filter((c) => c.reason.startsWith('drop lands'))).toEqual([])
    expect(warnings.some((w) => w.includes('No songs with drop markers'))).toBe(true)
  })

  test('no hard steps: warns instead of throwing', () => {
    const easyPlan: WorkoutPlan = { name: 'recovery', steps: [{ kind: 'easy', seconds: 1800 }] }
    const { warnings } = planSetlist(easyPlan, [fullSong('aaa')])
    expect(warnings.some((w) => w.includes('no hard steps'))).toBe(true)
  })

  test('distance steps resolve via pace and drops still land exactly', () => {
    const distPlan: WorkoutPlan = {
      name: 'track workout',
      steps: [
        { kind: 'warmup', seconds: 300 },
        { kind: 'easy', meters: 1000 }, // at 6:00/km → 360s
        { kind: 'hard', meters: 400 }, //  → 144s
      ],
    }
    const { cues, warnings } = planSetlist(distPlan, songs, { paceSecPerKm: 360 })
    const targets = hardStepStarts(distPlan, 360)
    expect(targets).toEqual([(300 + 360) * 1000])
    const drop = cues.filter((c) => c.reason.startsWith('drop lands')).pop()!
    expect(drop.positionMs + (targets[0] - drop.atMs)).toBe(95_000)
    expect(warnings.some((w) => w.includes('assumed 6:00/km'))).toBe(true)
    expect(totalSilenceMs(cues, totalDurationMs(distPlan, 360))).toBe(0)
  })

  test('back-to-back hard steps truncate the buildup but never miss the drop', () => {
    const tightPlan: WorkoutPlan = {
      name: 'tight',
      steps: [
        { kind: 'warmup', seconds: 60 },
        { kind: 'hard', seconds: 10 },
        { kind: 'hard', seconds: 10 },
      ],
    }
    const { cues } = planSetlist(tightPlan, [fullSong('aaa'), fullSong('bbb')])
    const targets = hardStepStarts(tightPlan)
    const drops = cues.filter((c) => c.reason.startsWith('drop lands'))
    expect(drops.length).toBe(2)
    for (let i = 0; i < targets.length; i++) {
      expect(drops[i].positionMs + (targets[i] - drops[i].atMs)).toBe(95_000)
    }
  })

  test('an all-easy plan (long run) still gets wall-to-wall music', () => {
    const easyPlan: WorkoutPlan = { name: 'lsd', steps: [{ kind: 'easy', seconds: 3180 }] }
    const { cues } = planSetlist(easyPlan, [fullSong('aaa'), fullSong('bbb'), fullSong('ccc')])
    expect(cues.length).toBeGreaterThan(0)
    expect(cues[0].atMs).toBe(0)
    // Coverage: no silence — consecutive cue gaps never exceed a track's length.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].atMs - cues[i - 1].atMs).toBeLessThanOrEqual(240_000)
    }
    // And the last cue's natural playback reaches the plan end.
    const last = cues[cues.length - 1]
    expect(last.atMs + (240_000 - last.positionMs)).toBeGreaterThanOrEqual(3_180_000)
  })
})
