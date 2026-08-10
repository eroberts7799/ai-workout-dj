// Text format for time-based workout plans, one instruction per line:
//   warmup 5:00
//   4x easy 3:00 hard 1:00     <- repeats the pair 4 times
//   cooldown 3:00
import type { WorkoutPlan, WorkoutStep } from '../conductor/types'

const KINDS = new Set(['warmup', 'easy', 'hard', 'rest', 'cooldown'])

export function parsePlan(name: string, text: string): { plan: WorkoutPlan; errors: string[] } {
  const errors: string[] = []
  const steps: WorkoutStep[] = []

  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim().toLowerCase()
    if (!line || line.startsWith('#')) continue
    const repeatMatch = line.match(/^(\d+)x\s+(.*)$/)
    const repeat = repeatMatch ? Number(repeatMatch[1]) : 1
    const body = repeatMatch ? repeatMatch[2] : line

    const tokens = body.split(/\s+/)
    const group: WorkoutStep[] = []
    let ok = tokens.length > 0 && tokens.length % 2 === 0
    for (let t = 0; ok && t < tokens.length; t += 2) {
      const kind = tokens[t]
      const seconds = parseTime(tokens[t + 1])
      if (!KINDS.has(kind) || seconds === null) ok = false
      else group.push({ kind: kind as WorkoutStep['kind'], seconds })
    }
    if (!ok) {
      errors.push(`line ${i + 1}: could not parse "${raw.trim()}" (expected: [Nx] kind mm:ss [kind mm:ss …])`)
      continue
    }
    for (let r = 0; r < repeat; r++) steps.push(...group.map((s) => ({ ...s })))
  }

  if (steps.length === 0 && errors.length === 0) errors.push('empty plan')
  return { plan: { name, steps }, errors }
}

function parseTime(s: string): number | null {
  const m = s.match(/^(\d+):([0-5]\d)$/)
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const secs = s.match(/^(\d+)s$/)
  if (secs) return Number(secs[1])
  return null
}
