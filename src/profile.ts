// Athlete profile — who is wearing the watch.
// One field so far: calibrated max HR, the anchor for every %-of-max zone
// decision (HR-gated crest rewards, effort checks). Get the number from
// analysis/hr_calibration.py (2nd-highest 30s-rolling-median over full
// workout history) — e.g. 2026-08-16 over 2,616 activities: ethan 197,
// john-kubinak 196, noah-roberts 190.

import { DEFAULT_HR_MAX } from './live/rules'

const KEY = 'awdj-hr-max'
const MIN = 120
const MAX = 230

export function getHrMax(): number {
  const v = Number(localStorage.getItem(KEY))
  return Number.isFinite(v) && v >= MIN && v <= MAX ? Math.round(v) : DEFAULT_HR_MAX
}

export function setHrMax(v: number | null): void {
  if (v == null || !Number.isFinite(v)) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, String(Math.round(v)))
}
