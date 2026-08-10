// Conductor v0.5 — pure library, no I/O, no Spotify.
//
// Input: a time-based workout plan + tagged songs. Output: a cue schedule where
// each hard-step start gets a drop landing exactly on it, easy stretches get
// looping groove sections, and — the prime directive — MUSIC NEVER STOPS:
// a coverage pass guarantees playback for the entire plan, looping sections
// and repeating songs as needed. Time-based plans are fully deterministic, so
// the whole setlist is computed upfront; live re-solving arrives with HR/route.
import type { Cue, Setlist, SongTags, WorkoutPlan } from './types'

const DEFAULT_LEAD_MS = 30_000
const MIN_FILL_MS = 15_000
/** Chain the next song slightly before the current one runs out. */
const PREEMPT_MS = 300

export interface HardStep {
  startMs: number
  endMs: number
}

export function hardSteps(plan: WorkoutPlan): HardStep[] {
  const out: HardStep[] = []
  let t = 0
  for (const step of plan.steps) {
    const end = t + step.seconds * 1000
    if (step.kind === 'hard') out.push({ startMs: t, endMs: end })
    t = end
  }
  return out
}

export function hardStepStarts(plan: WorkoutPlan): number[] {
  return hardSteps(plan).map((h) => h.startMs)
}

export function totalDurationMs(plan: WorkoutPlan): number {
  return plan.steps.reduce((s, x) => s + x.seconds * 1000, 0)
}

interface DropChoice {
  song: SongTags
  dropMs: number
  entryMs: number
}

interface LoopChoice {
  song: SongTags
  loop: { startMs: number; endMs: number }
}

/** Internal cue with intent, so the coverage pass knows what it may loop. */
interface PlannedCue extends Cue {
  kind: 'fill' | 'drop' | 'loop' | 'chain'
}

function dropChoices(song: SongTags): DropChoice[] {
  return song.markers
    .filter((m) => m.type === 'drop')
    .map((d) => {
      const buildups = song.markers
        .filter((m) => m.type === 'buildup' && m.ms < d.ms)
        .sort((a, b) => b.ms - a.ms)
      const entryMs = buildups[0]?.ms ?? Math.max(0, d.ms - DEFAULT_LEAD_MS)
      return { song, dropMs: d.ms, entryMs }
    })
}

export function loopSection(song: SongTags): { startMs: number; endMs: number } | null {
  const starts = song.markers.filter((m) => m.type === 'loop_start').sort((a, b) => a.ms - b.ms)
  for (const s of starts) {
    const end = song.markers.find((m) => m.type === 'loop_end' && m.ms > s.ms)
    if (end) return { startMs: s.ms, endMs: end.ms }
  }
  return null
}

/**
 * Plan the whole session. Guarantees (asserted by tests):
 * - every hard-step start T with an available drop song gets a cue with
 *   positionMs + (T − atMs) === dropMs (the drop lands exactly on T)
 * - drop songs ride through the hard step; groove fills start after it ends
 * - ZERO SILENCE: from t=0 to plan end, some track is always playing —
 *   loop sections loop, and songs repeat when the library is small
 */
export function planSetlist(plan: WorkoutPlan, songs: SongTags[]): Setlist {
  const warnings: string[] = []
  const primary: PlannedCue[] = []
  const droppable = songs.flatMap(dropChoices).filter((c) => c.entryMs < c.dropMs)
  const loopable: LoopChoice[] = songs
    .map((s) => ({ song: s, loop: loopSection(s) }))
    .filter((x): x is LoopChoice => x.loop !== null)

  if (droppable.length === 0) warnings.push('No songs with drop markers — hard steps get no choreography')
  const targets = hardSteps(plan)
  if (targets.length === 0) warnings.push('Plan has no hard steps — nothing to choreograph')
  const planEnd = totalDurationMs(plan)

  let lastTrackId: string | null = null
  let dropIdx = 0
  let loopIdx = 0
  let cursorMs = 0

  for (const target of targets) {
    const pick = pickDrop(droppable, dropIdx, lastTrackId)
    if (!pick) break
    const lead = pick.dropMs - pick.entryMs
    const entryAt = target.startMs - lead
    if (entryAt - cursorMs >= MIN_FILL_MS && loopable.length > 0) {
      const fill = pickLoop(loopable, loopIdx, lastTrackId, pick.song.trackId)
      if (fill) {
        loopIdx++
        primary.push({
          kind: 'fill',
          atMs: cursorMs,
          trackId: fill.song.trackId,
          uri: fill.song.uri,
          positionMs: fill.loop.startMs,
          reason: `groove fill until the next effort (${fill.song.name})`,
        })
        lastTrackId = fill.song.trackId
      }
    }
    if (entryAt < cursorMs) {
      warnings.push(`Hard step at ${fmtMin(target.startMs)}: buildup truncated (${fmtMin(cursorMs)} entry)`)
    }
    const atMs = Math.max(entryAt, cursorMs, 0)
    const positionMs = pick.dropMs - (target.startMs - atMs)
    if (positionMs < 0 || positionMs >= pick.song.durationMs) {
      warnings.push(`Hard step at ${fmtMin(target.startMs)}: skipped ${pick.song.name} (entry out of bounds)`)
      continue
    }
    primary.push({
      kind: 'drop',
      atMs,
      trackId: pick.song.trackId,
      uri: pick.song.uri,
      positionMs,
      reason: `drop lands on the ${fmtMin(target.startMs)} effort (${pick.song.name})`,
    })
    lastTrackId = pick.song.trackId
    dropIdx++
    // The drop song rides through the effort; the next fill starts after it ends.
    cursorMs = target.endMs
  }

  const cues = ensureCoverage(primary, planEnd, songs, loopable, warnings)
  return { cues, warnings }
}

/**
 * The never-silence pass: walk each primary cue's natural playback and insert
 * loop-back cues (fills repeat their groove section) or chained fills (when a
 * track would end) until every moment up to planEnd has music.
 */
function ensureCoverage(
  primary: PlannedCue[],
  planEnd: number,
  songs: SongTags[],
  loopable: LoopChoice[],
  warnings: string[],
): Cue[] {
  const byId = new Map(songs.map((s) => [s.trackId, s]))
  const sorted = [...primary].sort((a, b) => a.atMs - b.atMs)
  const out: PlannedCue[] = []
  let fillRot = 0

  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]
    out.push(c)
    const nextAt = sorted[i + 1]?.atMs ?? planEnd

    let song = byId.get(c.trackId)
    let segStart = c.atMs
    let pos = c.positionMs
    let looping = c.kind === 'fill' // drop cues must ride through their drop — never loop them

    for (;;) {
      if (!song) break
      const trackEndAt = segStart + (song.durationMs - pos)
      const loop = loopSection(song)

      if (looping && loop && pos >= loop.startMs && pos < loop.endMs) {
        const seekAt = segStart + (loop.endMs - pos)
        if (seekAt >= nextAt) break
        out.push({
          kind: 'loop',
          atMs: seekAt,
          trackId: song.trackId,
          uri: song.uri,
          positionMs: loop.startMs,
          reason: `loop back (${song.name})`,
        })
        segStart = seekAt
        pos = loop.startMs
        continue
      }

      if (trackEndAt >= nextAt) break

      // Track will run out before the next planned cue — chain another groove.
      if (loopable.length === 0) {
        warnings.push(`silence risk at ${fmtMin(trackEndAt)} — no loopable songs to chain`)
        break
      }
      let fill: LoopChoice | null = null
      for (let k = 0; k < loopable.length; k++) {
        const cand = loopable[(fillRot + k) % loopable.length]
        if (cand.song.trackId !== song.trackId) {
          fill = cand
          fillRot += k + 1
          break
        }
      }
      if (!fill) {
        fill = loopable[fillRot % loopable.length] // repeating a song beats silence
        fillRot++
      }
      const at = Math.max(trackEndAt - PREEMPT_MS, segStart)
      out.push({
        kind: 'chain',
        atMs: at,
        trackId: fill.song.trackId,
        uri: fill.song.uri,
        positionMs: fill.loop.startMs,
        reason: `keep the music going (${fill.song.name})`,
      })
      song = fill.song
      segStart = at
      pos = fill.loop.startMs
      looping = true
    }
  }

  return out
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ kind: _kind, ...cue }) => cue)
}

function pickLoop(
  loopable: LoopChoice[],
  startIdx: number,
  lastTrackId: string | null,
  upcomingTrackId: string,
): LoopChoice | null {
  for (let i = 0; i < loopable.length; i++) {
    const c = loopable[(startIdx + i) % loopable.length]
    if (c.song.trackId !== lastTrackId && c.song.trackId !== upcomingTrackId) return c
  }
  return loopable.length > 0 ? loopable[startIdx % loopable.length] : null
}

function pickDrop(choices: DropChoice[], startIdx: number, lastTrackId: string | null): DropChoice | null {
  if (choices.length === 0) return null
  for (let i = 0; i < choices.length; i++) {
    const c = choices[(startIdx + i) % choices.length]
    if (c.song.trackId !== lastTrackId) return c
  }
  return choices[startIdx % choices.length]
}

function fmtMin(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}
