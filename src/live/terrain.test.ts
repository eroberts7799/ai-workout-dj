import { describe, expect, test } from 'bun:test'
import { extractTerrainCues, gapMultiplier, predictArrivalMs, smoothProfile, type ProfilePoint } from './terrain'

/** Synthetic mountain: 2km flat → 1km at +8% (80m gain) → 1km flat. */
function mountain(): ProfilePoint[] {
  const pts: ProfilePoint[] = []
  for (let d = 0; d <= 4000; d += 10) {
    let alt = 10
    if (d > 2000 && d <= 3000) alt = 10 + (d - 2000) * 0.08
    if (d > 3000) alt = 90
    pts.push({ distanceM: d, altitudeM: alt })
  }
  return pts
}

describe('terrain', () => {
  test('mountain profile yields one climbStart and one crest with the real gain', () => {
    const cues = extractTerrainCues(mountain())
    const crests = cues.filter((c) => c.type === 'crest')
    const starts = cues.filter((c) => c.type === 'climbStart')
    expect(crests.length).toBe(1)
    expect(starts.length).toBe(1)
    expect(starts[0].distanceM).toBeGreaterThan(1900)
    expect(starts[0].distanceM).toBeLessThan(2400)
    // Crest fires when smoothed grade decays past the summit — allow lag.
    expect(crests[0].distanceM).toBeGreaterThan(2950)
    expect(crests[0].distanceM).toBeLessThan(3400)
    expect(crests[0].gainM).toBeGreaterThan(60)
    expect(crests[0].confidence).toBeGreaterThan(0.9)
  })

  test('flat profile yields no cues, even with per-sample jitter', () => {
    const flat: ProfilePoint[] = []
    for (let d = 0; d <= 8000; d += 10) {
      // Deterministic ±1m jitter — the corpus's fake-ascent generator.
      flat.push({ distanceM: d, altitudeM: 20 + Math.sin(d * 7.13) })
    }
    expect(extractTerrainCues(flat).length).toBe(0)
  })

  test('jitter on the mountain does not add or lose crests', () => {
    const noisy = mountain().map((p) => ({ ...p, altitudeM: p.altitudeM + Math.sin(p.distanceM * 7.13) }))
    const crests = extractTerrainCues(noisy).filter((c) => c.type === 'crest')
    expect(crests.length).toBe(1)
  })

  test('uphill arrival is slower than flat, downhill barely faster', () => {
    expect(gapMultiplier(0.08)).toBeCloseTo(1.48, 2)
    expect(gapMultiplier(-0.2)).toBe(0.9)
    const flat: ProfilePoint[] = [
      { distanceM: 0, altitudeM: 0 },
      { distanceM: 1000, altitudeM: 0 },
    ]
    const up: ProfilePoint[] = [
      { distanceM: 0, altitudeM: 0 },
      { distanceM: 1000, altitudeM: 80 },
    ]
    const flatMs = predictArrivalMs(flat, 1000, 300)
    const upMs = predictArrivalMs(up, 1000, 300)
    expect(flatMs).toBeCloseTo(300_000, -3)
    expect(upMs / flatMs).toBeGreaterThan(1.4)
  })

  test('smoothing kills jitter but preserves the hill', () => {
    const noisy = mountain().map((p) => ({ ...p, altitudeM: p.altitudeM + Math.sin(p.distanceM * 7.13) }))
    const sm = smoothProfile(noisy)
    const ups = sm.reduce((acc, p, i) => (i > 0 ? acc + Math.max(0, p.altitudeM - sm[i - 1].altitudeM) : acc), 0)
    expect(ups).toBeGreaterThan(70)
    expect(ups).toBeLessThan(100) // raw jitter would push this to 300+
  })
})
