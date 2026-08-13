// Generates the cross-platform parity fixture: the TS engine computes truth
// cases, the Swift test suite replays them against BeatMath and fails if the
// two brains have drifted. Born from the 2026-08-13 morning-run failure —
// the phone ran a stale port because parity lived in a human's head.
//
// Run after ANY change to src/conductor/beat.ts or engine constants:
//   bun scripts/gen-parity-fixture.ts
import { blendPlan, camelotCompatible, mixScore, nextGridDelayMs, snapToBeat, tempoLockRate } from '../src/conductor/beat'

const gridCases = [
  { posMs: 30_500, bpm: 120, anchorMs: 30_000, beatsPerUnit: 4 },
  { posMs: 36_000, bpm: 120, anchorMs: 30_000, beatsPerUnit: 4 },
  { posMs: 30_200, bpm: 120, anchorMs: 30_000, beatsPerUnit: 1 },
  { posMs: 29_600, bpm: 120, anchorMs: 30_000, beatsPerUnit: 1 },
  { posMs: 61_007, bpm: 128, anchorMs: 95_000, beatsPerUnit: 1 },
  { posMs: 1234, bpm: null, anchorMs: 0, beatsPerUnit: 1 },
].map((c) => ({ ...c, expect: nextGridDelayMs(c.posMs, c.bpm, c.anchorMs, c.beatsPerUnit) }))

const rateCases = [
  { out: 136, inn: 140 },
  { out: 120, inn: 140 },
  { out: 140, inn: 120 },
  { out: null, inn: 140 },
].map((c) => ({ ...c, expect: tempoLockRate(c.out, c.inn) }))

const blendCases = [
  { fade: 1.2, out: 124, inn: 126, isDrop: false },
  { fade: 3.0, out: 124, inn: 124, isDrop: false },
  { fade: 1.2, out: 124, inn: 90, isDrop: false },
  { fade: 0.45, out: 124, inn: 125, isDrop: true },
  { fade: 0.25, out: 124, inn: 124, isDrop: false },
  { fade: 1.2, out: null, inn: 124, isDrop: false },
].map((c) => ({ ...c, expect: blendPlan(c.fade, c.out, c.inn, { isDrop: c.isDrop }) }))

const camelotCases = [
  ['9A', '9A'], ['9A', '9B'], ['9A', '10A'], ['12A', '1A'], ['9A', '10B'], ['9A', '3A'], [null, '9A'],
].map(([a, b]) => ({ a, b, expect: camelotCompatible(a as string | null, b as string | null) }))

const mixScoreCases = [
  { f: { bpm: 136, camelot: '9A' }, t: { bpm: 136, camelot: '9A' } },
  { f: { bpm: 136, camelot: '9A' }, t: { bpm: 136, camelot: '3B' } },
  { f: { bpm: 136, camelot: '9A' }, t: { bpm: 90, camelot: '9A' } },
  { f: { bpm: 136, camelot: null }, t: { bpm: 136, camelot: '9A' } },
  { f: { bpm: null, camelot: null }, t: { bpm: 136, camelot: '9A' } },
].map((c) => ({ ...c, expect: mixScore(c.f, c.t) }))

const snapCases = [
  { raw: 61_007, anchor: 95_000, bpm: 128 },
  { raw: 10_000, anchor: 95_000, bpm: 128 },
  { raw: 1234, anchor: 95_000, bpm: null },
].map((c) => ({ ...c, expect: snapToBeat(c.raw, c.anchor, c.bpm) }))

// Engine constants that MUST match across platforms (grep both sides).
const constants = {
  maxFillRideMs: 180_000,
  minClimbGainM: 30,
  crestMinEtaMs: 45_000,
  crestRideMs: 25_000,
  defaultHrMax: 190,
  bassHz: 180,
  bassCutDb: -15,
}

const fixture = { generatedBy: 'scripts/gen-parity-fixture.ts', gridCases, rateCases, blendCases, camelotCases, mixScoreCases, snapCases, constants }
await Bun.write('ios/Tests/parity-fixture.json', JSON.stringify(fixture, null, 1))
console.log('wrote ios/Tests/parity-fixture.json —', gridCases.length + rateCases.length + blendCases.length + camelotCases.length + mixScoreCases.length + snapCases.length, 'cases + constants')
