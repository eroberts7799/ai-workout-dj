// CoachEngine — the second channel. The music is the emotion channel; this
// is the intent channel: a voice that knows what's coming because it reads
// the same anticipation clock the DJ does (ETA to the next hard step, HR
// zone, route lock, terrain ahead). Deterministic templates, a strict cue
// budget, and one rule above all: the voice never lands on a drop.
//
// Pure logic: advance(view) returns cues to speak. Ported to Swift
// same-session (parity law). A morning-written script (Claude, 05:00 job)
// can replace any slot's wording; the timing stays here.
import type { LiveEngine } from './live-engine'

export interface CoachCue {
  tMs: number
  kind: string
  text: string
}

/** Lines written for THIS session (v1 script). Per-rep arrays index by the
 *  rep number (0-based); `{pace}`, `{target}`, `{hr}`, `{n}`, `{total}`,
 *  `{delta}` are filled in at speak time. */
export interface CoachScript {
  opening?: string
  pre30?: string[]
  repEnd?: string[]
  halfway?: string[]
  final?: string
  hrHigh?: string
  crest?: string
}

export type CoachView = LiveEngine['state'] & {
  tMs: number
  distanceM: number | null
  hr: number | null
}

/** Minimum silence between any two cues. A coach who talks every ten
 *  seconds is a nag (GUESS — field feedback calibrates). */
const MIN_GAP_MS = 8_000
/** The drop's quiet zone: nothing from T−6s to T+3s around a landing. */
const QUIET_BEFORE_MS = 6_000
const QUIET_AFTER_MS = 3_000
const HR_HIGH_ZONE = 4
const HR_HIGH_HOLD_SAMPLES = 30
const HR_HIGH_COOLDOWN_MS = 300_000

export function spokenPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm - m * 60)
  return `${m}:${s < 10 ? '0' : ''}${s}`
}

function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
}

export class CoachEngine {
  readonly cues: CoachCue[] = []
  private readonly script: CoachScript
  private lastCueT = -Infinity
  private lastLandingT = -Infinity
  private startT: number | null = null
  private openingSaid = false
  private pre30Rep = -1
  private pre10Rep = -1
  private halfwayRep = -1
  private driftRep = -1
  private repEntryT: number | null = null
  private repEntryDist: number | null = null
  private inHard = false
  private awaitingRecovery = false
  private hrHighRun = 0
  private lastHrHighT = -Infinity
  private lastCrestT = -Infinity
  private lastTerrainKey: string | null = null
  private routeSaid = false
  private finalSaid = false

  constructor(opts: { script?: CoachScript } = {}) {
    this.script = opts.script ?? {}
  }

  private say(t: number, kind: string, text: string): CoachCue {
    const cue = { tMs: t, kind, text }
    this.cues.push(cue)
    this.lastCueT = t
    return cue
  }

  private canSpeak(t: number, v: CoachView): boolean {
    if (t - this.lastCueT < MIN_GAP_MS) return false
    if (v.etaToHardMs != null && v.etaToHardMs > 0 && v.etaToHardMs <= QUIET_BEFORE_MS) return false
    if (t - this.lastLandingT < QUIET_AFTER_MS) return false
    return true
  }

  advance(v: CoachView): CoachCue[] {
    const before = this.cues.length
    const t = v.tMs
    if (this.startT == null) this.startT = t
    const stepKind = v.step?.kind ?? null
    const talkative = v.hardTotal == null || v.hardTotal > 0
    const startT = this.startT

    // Landing bookkeeping (the drop owns its quiet zone).
    if (v.entered === 'hard') {
      this.lastLandingT = t
      this.inHard = true
      this.repEntryT = t
      this.repEntryDist = v.distanceM
    }
    // Rep end: entered a non-hard step straight out of a hard one.
    if (v.entered != null && v.entered !== 'hard' && this.inHard) {
      this.inHard = false
      const n = v.hardDone
      const elapsed = this.repEntryT != null ? (t - this.repEntryT) / 1000 : null
      const dist = this.repEntryDist != null && v.distanceM != null ? v.distanceM - this.repEntryDist : null
      const pace = elapsed && dist && dist > 50 ? (elapsed / dist) * 1000 : null
      const target = this.lastTarget
      let delta = ''
      if (pace != null && target != null) {
        const d = Math.round(pace - target)
        delta = d <= -3 ? `${-d} seconds under target.` : d >= 3 ? `${d} seconds over.` : 'Right on target.'
      }
      const vars = {
        n: String(n), total: v.hardTotal != null ? String(v.hardTotal) : '',
        pace: pace != null ? spokenPace(pace) : '', target: target != null ? spokenPace(target) : '', delta,
        hr: v.hr != null ? String(Math.round(v.hr)) : '',
      }
      const line = this.script.repEnd?.[n - 1]
      const text = line ? fill(line, vars)
        : `Done. ${v.hardTotal != null ? `${n} of ${v.hardTotal}.` : `Rep ${n}.`}${pace != null ? ` ${spokenPace(pace)} pace.` : ''}${delta ? ` ${delta}` : ''}`
      // Rep ends are worth breaking the gap rule for — but never the quiet zone.
      if (t - this.lastLandingT >= QUIET_AFTER_MS) this.say(t, 'repEnd', text)
      this.awaitingRecovery = v.hr != null
    }
    if (v.step?.kind === 'hard' && v.step.targetPaceSecPerKm != null) this.lastTarget = v.step.targetPaceSecPerKm

    // Opening (script only): a few seconds in, once.
    if (!this.openingSaid && this.script.opening && t - startT >= 12_000 && this.canSpeak(t, v)) {
      this.openingSaid = true
      this.say(t, 'opening', this.script.opening)
    }

    if (talkative) {
      // Pre-rep, 30s out.
      const eta = v.etaToHardMs
      const rep = v.hardDone // the upcoming rep's index
      if (eta != null && eta >= 24_000 && eta <= 36_000 && this.pre30Rep !== rep && this.canSpeak(t, v)) {
        this.pre30Rep = rep
        const nh = v.nextHard
        const what = nh?.meters ? `${Math.round(nh.meters)} meters` : nh?.seconds ? `${Math.round(nh.seconds)} seconds` : 'Effort'
        const target = nh?.targetPaceSecPerKm ?? null
        const vars = { n: String(rep + 1), total: v.hardTotal != null ? String(v.hardTotal) : '', target: target != null ? spokenPace(target) : '', what }
        const line = this.script.pre30?.[rep]
        this.say(t, 'pre30', line ? fill(line, vars)
          : `${what} in 30 seconds.${target != null ? ` Target ${spokenPace(target)}.` : ''} Settle your breathing.`)
      }
      // Ten seconds: short, then silence for the drop.
      if (eta != null && eta >= 7_000 && eta <= 12_000 && this.pre10Rep !== rep && t - this.lastCueT >= 10_000) {
        this.pre10Rep = rep
        this.say(t, 'pre10', 'Ten seconds. Tall and relaxed.')
      }
      // In the rep: halfway, and pace drift against the target.
      if (this.inHard && this.repEntryT != null && v.step?.remainingMs != null) {
        const elapsed = t - this.repEntryT
        const repIdx = v.hardDone
        if (elapsed >= 30_000 && v.step.remainingMs <= elapsed && this.halfwayRep !== repIdx && this.canSpeak(t, v)) {
          this.halfwayRep = repIdx
          const vars = { hr: v.hr != null ? String(Math.round(v.hr)) : '', n: String(repIdx + 1) }
          const line = this.script.halfway?.[repIdx]
          this.say(t, 'halfway', line ? fill(line, vars)
            : `Halfway.${v.hr != null ? ` Heart rate ${Math.round(v.hr)}.` : ''} Hold it.`)
        }
        const target = v.step.targetPaceSecPerKm
        if (target != null && elapsed >= 20_000 && this.driftRep !== repIdx && this.canSpeak(t, v)) {
          const d = v.paceSecPerKm - target
          if (d > target * 0.05) { this.driftRep = repIdx; this.say(t, 'drift', `${Math.round(d)} seconds slow. Pick it up.`) }
          else if (d < -target * 0.07) { this.driftRep = repIdx; this.say(t, 'drift', 'Too fast. Ease off five seconds.') }
        }
      }
      // Recovery after a rep.
      if (this.awaitingRecovery && !this.inHard && v.hrZone <= 2 && v.hr != null && this.canSpeak(t, v)) {
        this.awaitingRecovery = false
        this.say(t, 'recovered', `Recovered. Heart rate ${Math.round(v.hr)}.`)
      }
    }

    // Heart rate high outside efforts — the coach's one job on an easy day.
    if (stepKind !== 'hard' && v.hr != null && v.hrZone >= HR_HIGH_ZONE) this.hrHighRun++
    else this.hrHighRun = 0
    if (this.hrHighRun >= HR_HIGH_HOLD_SAMPLES && t - this.lastHrHighT >= HR_HIGH_COOLDOWN_MS && this.canSpeak(t, v)) {
      this.lastHrHighT = t
      this.hrHighRun = 0
      const vars = { hr: String(Math.round(v.hr!)) }
      this.say(t, 'hrHigh', this.script.hrHigh ? fill(this.script.hrHigh, vars)
        : `Heart rate ${Math.round(v.hr!)}${talkative ? '' : ' on an easy day'}. Back it off.`)
    }

    // Terrain: anticipatory when the route is trusted, reactive otherwise.
    const ta = v.terrainAhead
    if (ta && ta.confidence >= 0.5) {
      const key = `${ta.type}@${Math.round((v.distanceM ?? 0) + (ta.etaMs / 1000) * (1000 / Math.max(120, v.paceSecPerKm)) / 50) * 50}`
      if (ta.type === 'crest' && ta.etaMs >= 18_000 && ta.etaMs <= 26_000 && this.lastTerrainKey !== key && this.canSpeak(t, v)) {
        this.lastTerrainKey = key
        this.lastCrestT = t
        this.say(t, 'crestAhead', this.script.crest ?? 'Crest in about twenty seconds. Drive to the top.')
      } else if (ta.type === 'climbStart' && ta.etaMs >= 12_000 && ta.etaMs <= 20_000 && this.lastTerrainKey !== key && this.canSpeak(t, v)) {
        this.lastTerrainKey = key
        this.say(t, 'climbAhead', 'Climb coming. Short steps, easy arms.')
      }
    }
    if (v.crest && t - this.lastCrestT > 40_000 && (v.etaToHardMs == null || v.etaToHardMs > 45_000) && this.canSpeak(t, v)) {
      this.lastCrestT = t
      this.say(t, 'crest', 'Top of the hill.')
    }

    // Route: a known route, and the final kilometer of it.
    if (v.route && v.route.routeId !== 'self') {
      if (!this.routeSaid && v.pAhead1k >= 0.7 && this.canSpeak(t, v)) {
        this.routeSaid = true
        const km = ((v.route.progressM + v.route.remainingM) / 1000).toFixed(1)
        const left = (v.route.remainingM / 1000).toFixed(1)
        this.say(t, 'route', `On your ${km} k route. ${left} k to go.`)
      }
      if (!this.finalSaid && v.route.remainingM <= 1000 && v.route.remainingM > 200 && v.pAhead1k >= 0.7 && this.canSpeak(t, v)) {
        this.finalSaid = true
        this.say(t, 'final', this.script.final ?? 'Final kilometer.')
      }
    }
    return this.cues.slice(before)
  }

  private lastTarget: number | null = null
}
