// Critic feeder — turns a simulated session's engine decisions into the
// enriched command schedule analysis/render_and_judge.py renders and scores.
// (Rule 9: engine changes ship with a critic verdict, not vibes. The original
// generator lived in a session scratchpad; this commits the pattern.)
//
// Usage: bun scripts/mix-commands.ts out.json [music-dir]
//   music-dir defaults to ~/Downloads/awdj-music (the Beatport crate).
//
// The session simulated is the backtest's worst baseline case — a Rolling-
// 800s interval block (8 consecutive hard reps) — because it exercises every
// new decision: opening groove, next-rep buildups mid-ride, re-aims, drops.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { simulate, syntheticSamples } from '../src/replay/simulate'
import { deckOptsFor } from '../src/audio/local-deck'
import { blendPlan, tempoLockRate } from '../src/conductor/beat'
import type { SongTags, WorkoutPlan } from '../src/conductor/types'

const outPath = process.argv[2] ?? 'mix-commands.json'
const musicDir = process.argv[3] ?? join(homedir(), 'Downloads', 'awdj-music')

const analysis = JSON.parse(readFileSync(join(import.meta.dir, '..', 'analysis', 'crate-analysis.json'), 'utf8'))
const keys = JSON.parse(readFileSync(join(import.meta.dir, '..', 'analysis', 'crate-keys.json'), 'utf8'))

const fileByTrack = new Map<string, string>()
const songs: SongTags[] = analysis.analysis.map((a: any, i: number) => {
  const trackId = `local-${i}`
  fileByTrack.set(trackId, a.sourceFile)
  return {
    trackId,
    uri: `local:${trackId}`,
    name: a.title,
    artists: a.artist,
    durationMs: a.durationMs,
    bpm: a.bpm,
    camelot: keys[a.sourceFile]?.camelot ?? null,
    updatedAt: '',
    markers: a.markers.map((m: any, j: number) => ({ id: `m${j}`, type: m.type, ms: m.ms })),
    segments: a.segments,
  }
})

const plan: WorkoutPlan = {
  name: 'rolling 800s (critic session)',
  steps: [
    { kind: 'warmup', meters: 805 },
    ...Array.from({ length: 8 }, () => ({ kind: 'hard' as const, meters: 805 })),
    { kind: 'rest', seconds: 90 },
    { kind: 'cooldown', meters: 805 },
  ],
}

const samples = syntheticSamples(plan, {
  easyPaceSecPerKm: 370,
  hardPaceSecPerKm: 265,
  fatiguePct: 4,
  noisePct: 2,
  hilly: false,
  withHr: true,
})
// Learned pairings (real-set adjacency) steer selection like they will live.
const weightsPath = join(import.meta.dir, '..', 'analysis', 'selection-weights.json')
const pairBonus = existsSync(weightsPath) ? JSON.parse(readFileSync(weightsPath, 'utf8')).pairs : {}
const result = simulate(plan, songs, samples, { hrMax: 197, pairBonus })

let prevBpm: number | null = null
const commands = result.commands.map((c) => {
  const song = songs.find((s) => s.trackId === c.trackId)!
  const opts = deckOptsFor(c.reason)
  const isDrop = c.reason.startsWith('drop lands')
  // Radio handoff (song chains): long fade-out, no blend — approximate the
  // deck's 6s ending fade for the renderer.
  const bp = opts.radio ? { fadeSec: 6, bassSwap: false } : blendPlan(c.fadeSec, prevBpm, song.bpm, { isDrop })
  const rate = opts.tempoLock ? tempoLockRate(prevBpm, song.bpm) : 1
  prevBpm = song.bpm ?? prevBpm
  const file = fileByTrack.get(c.trackId)!
  return {
    tMs: c.tMs,
    file: existsSync(join(musicDir, file)) ? file : null,
    positionMs: c.positionMs,
    fadeSec: bp.fadeSec,
    rate,
    bassSwap: bp.bassSwap,
    reason: c.reason,
  }
})

const missing = commands.filter((c) => !c.file).length
if (missing > 0) console.error(`WARNING: ${missing}/${commands.length} commands missing audio files in ${musicDir}`)
writeFileSync(outPath, JSON.stringify({ dir: musicDir, commands }, null, 1))
console.log(`${commands.length} commands (${result.landings.length} landings) → ${outPath}`)
