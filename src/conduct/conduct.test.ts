import { describe, expect, test } from 'bun:test'
import { parsePlan } from './plan-parse'
import { SessionClock, dueCues } from './runner'
import type { Cue } from '../conductor/types'

describe('parsePlan', () => {
  test('parses lines and Nx groups', () => {
    const { plan, errors } = parsePlan('t', 'warmup 5:00\n4x easy 3:00 hard 1:00\ncooldown 3:00')
    expect(errors).toEqual([])
    expect(plan.steps.length).toBe(1 + 8 + 1)
    expect(plan.steps[1]).toEqual({ kind: 'easy', seconds: 180 })
    expect(plan.steps[2]).toEqual({ kind: 'hard', seconds: 60 })
    expect(plan.steps[9]).toEqual({ kind: 'cooldown', seconds: 180 })
  })

  test('supports seconds shorthand and comments', () => {
    const { plan, errors } = parsePlan('t', '# my session\nhard 45s')
    expect(errors).toEqual([])
    expect(plan.steps).toEqual([{ kind: 'hard', seconds: 45 }])
  })

  test('reports bad lines with line numbers, keeps good ones', () => {
    const { plan, errors } = parsePlan('t', 'easy 3:00\nsprint 1:00\nhard 0:90')
    expect(plan.steps.length).toBe(1)
    expect(errors.length).toBe(2)
    expect(errors[0]).toContain('line 2')
  })
})

describe('SessionClock', () => {
  test('pause freezes workout time, resume continues', () => {
    let t = 1000
    const clock = new SessionClock(() => t)
    clock.start()
    t = 5000
    expect(clock.nowMs()).toBe(4000)
    clock.pause()
    t = 60_000
    expect(clock.nowMs()).toBe(4000)
    clock.resume()
    t = 61_000
    expect(clock.nowMs()).toBe(5000)
  })
})

describe('dueCues', () => {
  const cue = (atMs: number): Cue => ({ atMs, trackId: 'x', uri: 'u', positionMs: 0, reason: 'r' })

  test('fires each cue exactly once across ticks, compensated by leadMs', () => {
    // lead 30ms -> fire times are 970, 1970, 2020
    const cues = [cue(1000), cue(2000), cue(2050)]
    expect(dueCues(cues, 0, 990, 30).map((c) => c.atMs)).toEqual([1000])
    expect(dueCues(cues, 990, 1940, 30)).toEqual([])
    expect(dueCues(cues, 1940, 2100, 30).map((c) => c.atMs)).toEqual([2000, 2050])
    expect(dueCues(cues, 2100, 9999, 30)).toEqual([])
  })

  test('multiple due in one tick fire together', () => {
    const cues = [cue(2000), cue(2050)]
    expect(dueCues(cues, 1900, 2100, 30).length).toBe(2)
  })
})
