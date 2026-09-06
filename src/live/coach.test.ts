import { describe, expect, test } from 'bun:test'
import { CoachEngine, spokenPace, type CoachView } from './coach'
import { LiveEngine, type LiveSample } from './live-engine'
import type { SongTags, WorkoutPlan } from '../conductor/types'

function song(id: string): SongTags {
  return { trackId: id, uri: `spotify:track:${id}`, name: `Song ${id}`, artists: 'T', durationMs: 240_000, bpm: 128, updatedAt: '', markers: [] }
}
const songs = [song('a'), song('b'), song('c')]

/** Drive engine + coach together at 1Hz; hr from a function of t. */
function drive(plan: WorkoutPlan, seconds: number, mps: (i: number) => number, hr: (i: number) => number | null, coach = new CoachEngine()) {
  const engine = new LiveEngine(plan, songs, { paceSecPerKm: 340, hrMax: 190 })
  let d = 0
  for (let i = 1; i <= seconds; i++) {
    d += mps(i)
    const s: LiveSample = { tMs: i * 1000, distanceM: d, hr: hr(i) ?? undefined }
    engine.advance(s)
    const v: CoachView = { ...engine.state, tMs: s.tMs, distanceM: d, hr: hr(i) }
    coach.advance(v)
  }
  return { engine, coach }
}

const intervals: WorkoutPlan = {
  name: 'i',
  steps: [
    { kind: 'warmup', seconds: 120 },
    { kind: 'hard', meters: 800, targetPaceSecPerKm: 240 },
    { kind: 'rest', seconds: 90 },
    { kind: 'hard', meters: 800, targetPaceSecPerKm: 240 },
    { kind: 'cooldown', seconds: 120 },
  ],
}

describe('CoachEngine', () => {
  test('pre-rep cues land 30s and 10s out, nothing inside the drop\'s quiet zone, rep end reports pace vs target', () => {
    const { engine, coach } = drive(intervals, 900, () => 3.5, (i) => (i > 120 && i < 350 ? 172 : 140))
    expect(engine.landings.length).toBe(2)
    const T = engine.landings[0].actualTMs
    const pre30 = coach.cues.find((c) => c.kind === 'pre30')!
    expect(pre30).toBeDefined()
    expect(T - pre30.tMs).toBeGreaterThanOrEqual(23_000)
    expect(T - pre30.tMs).toBeLessThanOrEqual(37_000)
    expect(pre30.text).toContain('800 meters')
    expect(pre30.text).toContain('4:00')
    const pre10 = coach.cues.find((c) => c.kind === 'pre10')!
    expect(T - pre10.tMs).toBeGreaterThanOrEqual(6_000)
    expect(T - pre10.tMs).toBeLessThanOrEqual(13_000)
    for (const L of engine.landings) {
      for (const c of coach.cues) {
        const dt = c.tMs - L.actualTMs
        expect(dt < -6_000 || dt >= 3_000).toBe(true)
      }
    }
    const ends = coach.cues.filter((c) => c.kind === 'repEnd')
    expect(ends.length).toBe(2)
    expect(ends[0].text).toContain('1 of 2')
    // 3.5 m/s = 4:46/km vs a 4:00 target → over target.
    expect(ends[0].text).toContain('4:4')
    expect(ends[0].text).toContain('over')
    expect(coach.cues.some((c) => c.kind === 'halfway')).toBe(true)
    // Never two cues inside the gap.
    for (let i = 1; i < coach.cues.length; i++) {
      if (coach.cues[i].kind === 'repEnd') continue
      expect(coach.cues[i].tMs - coach.cues[i - 1].tMs).toBeGreaterThanOrEqual(8_000)
    }
  })

  test('easy day: no rep chatter, one heart-rate warning per five minutes', () => {
    const easy: WorkoutPlan = { name: 'e', steps: [{ kind: 'easy', seconds: 900 }] }
    const { coach } = drive(easy, 900, () => 3, (i) => (i > 100 ? 175 : 130))
    expect(coach.cues.filter((c) => c.kind === 'pre30' || c.kind === 'pre10' || c.kind === 'halfway').length).toBe(0)
    const hr = coach.cues.filter((c) => c.kind === 'hrHigh')
    expect(hr.length).toBeGreaterThanOrEqual(2)
    expect(hr.length).toBeLessThanOrEqual(3)
    expect(hr[0].text).toContain('easy day')
    expect(hr[1].tMs - hr[0].tMs).toBeGreaterThanOrEqual(300_000)
  })

  test('a morning script replaces the wording, not the timing', () => {
    const coach = new CoachEngine({ script: { opening: 'Five hours of sleep. Completion day.', pre30: ['Rep {n}. {target} is plenty today.'] } })
    const { engine } = drive(intervals, 400, () => 3.5, () => null, coach)
    const opening = coach.cues.find((c) => c.kind === 'opening')!
    expect(opening.tMs).toBeGreaterThanOrEqual(12_000)
    expect(opening.tMs).toBeLessThan(25_000)
    const pre30 = coach.cues.find((c) => c.kind === 'pre30')!
    expect(pre30.text).toBe('Rep 1. 4:00 is plenty today.')
    expect(engine.landings[0].actualTMs - pre30.tMs).toBeLessThanOrEqual(37_000)
  })

  test('spoken pace formatting', () => {
    expect(spokenPace(240)).toBe('4:00')
    expect(spokenPace(205)).toBe('3:25')
    expect(spokenPace(365.4)).toBe('6:05')
  })
})
