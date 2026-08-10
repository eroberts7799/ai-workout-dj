// Conductor v0 — pure library, no I/O, no Spotify.
//
// Input: a time-based workout plan + tagged songs. Output: a cue schedule where
// each hard-step start gets a drop landing exactly on it, with the preceding
// buildup entered early enough to telegraph the effort. Easy/rest stretches get
// groove (loop) sections. Time-based plans are fully deterministic, so v0
// computes the whole setlist upfront; live re-solving arrives with HR/route.
import type { Cue, Setlist, SongTags, WorkoutPlan } from './types'

interface DropChoice {
  song: SongTags
  dropMs: number
  /** Entry point in the track: buildup start if tagged (and earlier than the drop), else a default lead. */
  entryMs: number
}

const DEFAULT_LEAD_MS = 30_000
const MIN_FILL_MS = 15_000

/** Hard-step start times, ms from workout t=0 — the "hills" of a time-based plan. */
export function hardStepStarts(plan: WorkoutPlan): number[] {
  const out: number[] = []
  let t = 0
  for (const step of plan.steps) {
    if (step.kind === 'hard') out.push(t)
    t += step.seconds * 1000
  }
  return out
}

export function totalDurationMs(plan: WorkoutPlan): number {
  return plan.steps.reduce((s, x) => s + x.seconds * 1000, 0)
}

function dropChoices(song: SongTags): DropChoice[] {
  const drops = song.markers.filter((m) => m.type === 'drop')
  return drops.map((d) => {
    const buildups = song.markers
      .filter((m) => m.type === 'buildup' && m.ms < d.ms)
      .sort((a, b) => b.ms - a.ms)
    const entryMs = buildups[0]?.ms ?? Math.max(0, d.ms - DEFAULT_LEAD_MS)
    return { song, dropMs: d.ms, entryMs }
  })
}

function loopSection(song: SongTags): { startMs: number; endMs: number } | null {
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
 * - cues are sorted, non-negative, and never enter a track out of bounds
 * - the same song is never used for two consecutive cues
 */
export function planSetlist(plan: WorkoutPlan, songs: SongTags[]): Setlist {
  const warnings: string[] = []
  const cues: Cue[] = []
  const droppable = songs.flatMap(dropChoices).filter((c) => c.entryMs < c.dropMs)
  const loopable = songs.map((s) => ({ song: s, loop: loopSection(s) })).filter((x) => x.loop !== null)

  if (droppable.length === 0) warnings.push('No songs with drop markers — hard steps get no choreography')

  let lastTrackId: string | null = null
  let dropIdx = 0
  let loopIdx = 0

  const targets = hardStepStarts(plan)
  if (targets.length === 0) warnings.push('Plan has no hard steps — nothing to choreograph')

  // Interleave: groove fill from workout start, then per hard step: buildup entry → drop on target.
  let cursorMs = 0
  for (const target of targets) {
    // Fill easy stretch before this target if there's meaningful room.
    const pick = pickDrop(droppable, dropIdx, lastTrackId)
    if (!pick) break
    const lead = pick.dropMs - pick.entryMs
    const entryAt = target - lead
    if (entryAt - cursorMs >= MIN_FILL_MS && loopable.length > 0) {
      const fill = pickLoop(loopable, loopIdx, lastTrackId, pick.song.trackId)
      if (fill) {
        loopIdx++
        cues.push({
          atMs: cursorMs,
          trackId: fill.song.trackId,
          uri: fill.song.uri,
          positionMs: fill.loop!.startMs,
          reason: `groove fill until the next effort (${fill.song.name})`,
        })
        lastTrackId = fill.song.trackId
      }
    }
    if (entryAt < cursorMs) {
      // Not enough room for the full buildup — enter late, drop still lands on target.
      warnings.push(`Hard step at ${fmtMin(target)}: buildup truncated (${fmtMin(cursorMs)} entry)`)
    }
    const atMs = Math.max(entryAt, cursorMs, 0)
    const positionMs = pick.dropMs - (target - atMs)
    if (positionMs < 0 || positionMs >= pick.song.durationMs) {
      warnings.push(`Hard step at ${fmtMin(target)}: skipped ${pick.song.name} (entry out of bounds)`)
      continue
    }
    cues.push({
      atMs,
      trackId: pick.song.trackId,
      uri: pick.song.uri,
      positionMs,
      reason: `drop lands on the ${fmtMin(target)} effort (${pick.song.name})`,
    })
    lastTrackId = pick.song.trackId
    dropIdx++
    cursorMs = target
  }

  return { cues: cues.sort((a, b) => a.atMs - b.atMs), warnings }
}

function pickLoop(
  loopable: { song: SongTags; loop: { startMs: number; endMs: number } | null }[],
  startIdx: number,
  lastTrackId: string | null,
  upcomingTrackId: string,
): { song: SongTags; loop: { startMs: number; endMs: number } | null } | null {
  for (let i = 0; i < loopable.length; i++) {
    const c = loopable[(startIdx + i) % loopable.length]
    if (c.song.trackId !== lastTrackId && c.song.trackId !== upcomingTrackId) return c
  }
  return null // no distinct fill available — skip the fill rather than stutter
}

function pickDrop(choices: DropChoice[], startIdx: number, lastTrackId: string | null): DropChoice | null {
  if (choices.length === 0) return null
  for (let i = 0; i < choices.length; i++) {
    const c = choices[(startIdx + i) % choices.length]
    if (c.song.trackId !== lastTrackId) return c
  }
  // Only one distinct song available — reuse is better than silence.
  return choices[startIdx % choices.length]
}

function fmtMin(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}
