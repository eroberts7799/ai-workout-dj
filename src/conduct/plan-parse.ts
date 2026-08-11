// Text format for workout plans, one instruction per line. Amounts are time
// (mm:ss or 45s) or distance (800m, 2km, 1.5km):
//   warmup 5:00
//   4x easy 400m hard 800m     <- repeats the pair 4 times
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
      const amount = parseAmount(tokens[t + 1])
      if (!KINDS.has(kind) || amount === null) ok = false
      else group.push({ kind: kind as WorkoutStep['kind'], ...amount })
    }
    if (!ok) {
      errors.push(`line ${i + 1}: could not parse "${raw.trim()}" (expected: [Nx] kind mm:ss|800m|2km …)`)
      continue
    }
    for (let r = 0; r < repeat; r++) steps.push(...group.map((s) => ({ ...s })))
  }

  if (steps.length === 0 && errors.length === 0) errors.push('empty plan')
  return { plan: { name, steps }, errors }
}

function parseAmount(s: string): { seconds: number } | { meters: number } | null {
  const time = s.match(/^(\d+):([0-5]\d)$/)
  if (time) return { seconds: Number(time[1]) * 60 + Number(time[2]) }
  const secs = s.match(/^(\d+)s$/)
  if (secs) return { seconds: Number(secs[1]) }
  const meters = s.match(/^(\d+(?:\.\d+)?)m$/)
  if (meters) return { meters: Number(meters[1]) }
  const km = s.match(/^(\d+(?:\.\d+)?)km$/)
  if (km) return { meters: Number(km[1]) * 1000 }
  return null
}
