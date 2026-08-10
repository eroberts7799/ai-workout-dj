import { useEffect, useRef, useState } from 'react'
import { LocalDeck } from '../audio/local-deck'
import { loadAudio } from '../audio/local-store'
import { planSetlist, totalDurationMs } from '../conductor/conductor'
import type { Cue, WorkoutPlan } from '../conductor/types'
import type { SdkHandle } from '../spike/sdk-path'
import { playTrack } from '../spike/webapi-path'
import { loadAllTags } from '../tags/store'
import { parsePlan } from './plan-parse'
import { SessionClock, dueCues } from './runner'

/** Crossfade length by cue intent: loop re-entries cut tight, drops punch, fills wash. */
function fadeFor(cue: Cue): number {
  if (cue.reason.startsWith('loop back')) return 0.25
  if (cue.reason.startsWith('drop lands')) return 0.45
  return 1.2
}

// Measured hour-one: SDK path median command latency ~27ms — issue cues that early.
const LEAD_MS = 27
const TICK_MS = 100

const DEFAULT_PLAN = `# time-based interval session (watch auto-pause OFF)
warmup 5:00
4x easy 3:00 hard 1:00
cooldown 3:00`

interface LogEntry {
  plannedAtMs: number
  firedAtMs: number
  cue: Cue
  ok: boolean
  error?: string
}

interface GarminSample {
  receivedAt: number
  event?: string
  hr?: number
  timerMs?: number
  lat?: number
  lon?: number
  altitude?: number
}

export default function ConductPanel({ sdk }: { sdk: SdkHandle }) {
  const [planText, setPlanText] = useState(DEFAULT_PLAN)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [clockMs, setClockMs] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'running' | 'paused' | 'done'>('idle')
  const [log, setLog] = useState<LogEntry[]>([])
  const clockRef = useRef(new SessionClock())
  const prevMsRef = useRef(0)
  const cuesRef = useRef<Cue[]>([])
  const planRef = useRef<WorkoutPlan | null>(null)
  const deckRef = useRef<LocalDeck | null>(null)
  const [engine, setEngine] = useState<'local' | 'spotify'>('spotify')
  const engineRef = useRef<'local' | 'spotify'>('spotify')
  const [garmin, setGarmin] = useState<GarminSample | null>(null)
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(false)
  armedRef.current = armed
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const handledStartRef = useRef(0)
  const hrLogRef = useRef<{ atMs: number; hr: number }[]>([])

  // Live Garmin feed: poll the receiver once a second, always.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('/api/garmin')
        const sample = (await res.json()) as GarminSample | null
        setGarmin(sample)
        if (!sample) return
        const fresh = Date.now() - sample.receivedAt < 5_000
        // Exact-sync auto-start: watch timer started → session starts, backdated.
        if (
          fresh &&
          armedRef.current &&
          phaseRef.current === 'idle' &&
          sample.event === 'timerStart' &&
          sample.receivedAt !== handledStartRef.current
        ) {
          handledStartRef.current = sample.receivedAt
          const offset = (sample.timerMs ?? 0) + (Date.now() - sample.receivedAt)
          void startFromGarmin(offset)
        }
        if (fresh && phaseRef.current === 'running' && typeof sample.hr === 'number') {
          hrLogRef.current.push({ atMs: clockRef.current.nowMs(), hr: sample.hr })
        }
      } catch {
        // receiver not reachable — fine, feed is optional
      }
    }, 1_000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const songs = Object.values(loadAllTags())
  const { plan, errors } = parsePlan('session', planText)
  const setlist = planSetlist(plan, songs)

  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(async () => {
      const clock = clockRef.current
      const now = clock.nowMs()
      setClockMs(now)
      const due = dueCues(cuesRef.current, prevMsRef.current - LEAD_MS, now - LEAD_MS, 0)
      prevMsRef.current = now
      for (const cue of due) {
        // Mid-run failure policy: log and keep playing — never interrupt the run.
        try {
          if (engineRef.current === 'local' && deckRef.current?.has(cue.trackId)) {
            deckRef.current.play(cue.trackId, cue.positionMs, fadeFor(cue))
          } else {
            await playTrack(sdk.deviceId, cue.uri, cue.positionMs)
          }
          setLog((prev) => [...prev, { plannedAtMs: cue.atMs, firedAtMs: now, cue, ok: true }])
        } catch (e) {
          setLog((prev) => [...prev, { plannedAtMs: cue.atMs, firedAtMs: now, cue, ok: false, error: String(e) }])
        }
      }
      if (planRef.current && now >= totalDurationMs(planRef.current)) {
        setPhase('done')
      }
    }, TICK_MS)
    return () => clearInterval(t)
  }, [phase, sdk])

  /** Common session prep: lock in cues + pick the engine. */
  async function prepareSession(): Promise<boolean> {
    if (errors.length > 0 || setlist.cues.length === 0) return false
    cuesRef.current = setlist.cues
    planRef.current = plan
    setLog([])
    hrLogRef.current = []
    prevMsRef.current = -1

    // Engine choice: if every cued track has attached local audio, use the
    // real-DJ deck (crossfades); otherwise fall back to Spotify jump-cuts.
    const neededIds = [...new Set(setlist.cues.map((c) => c.trackId))]
    const deck = (deckRef.current ??= new LocalDeck())
    let allLocal = true
    for (const id of neededIds) {
      if (deck.has(id)) continue
      const data = await loadAudio(id)
      if (data) {
        await deck.load(id, data)
      } else {
        allLocal = false
        break
      }
    }
    engineRef.current = allLocal ? 'local' : 'spotify'
    setEngine(engineRef.current)
    return true
  }

  function beginAt(offsetMs: number) {
    clockRef.current = new SessionClock()
    clockRef.current.start()
    setPhase('running')
    scrubTo(offsetMs) // establishes clock offset AND correct playback state
  }

  /** Manual start: 3-2-1-GO countdown (start the watch on GO). */
  async function startSession() {
    if (!(await prepareSession())) return
    setCountdown(3)
    const tick = (n: number) => {
      if (n === 0) {
        setCountdown(null)
        beginAt(0)
        return
      }
      setCountdown(n)
      setTimeout(() => tick(n - 1), 1000)
    }
    tick(3)
  }

  /** Garmin start: the watch's timer already started offsetMs ago — sync to it. */
  async function startFromGarmin(offsetMs: number) {
    if (!(await prepareSession())) return
    beginAt(offsetMs)
  }

  function togglePause() {
    const clock = clockRef.current
    if (phase === 'running') {
      clock.pause()
      // workout paused = music paused
      if (engineRef.current === 'local') void deckRef.current?.pause()
      else void sdk.player.pause()
      setPhase('paused')
    } else if (phase === 'paused') {
      clock.resume()
      if (engineRef.current === 'local') void deckRef.current?.resume()
      else void sdk.player.resume()
      setPhase('running')
    }
  }

  /** Test scrubber: jump anywhere in the workout; playback state re-syncs to
   *  whatever the setlist says should be playing at that moment. */
  function scrubTo(ms: number) {
    clockRef.current.seekTo(ms)
    setClockMs(ms)
    prevMsRef.current = ms // skip cues in between — we re-establish state directly
    const past = cuesRef.current.filter((c) => c.atMs <= ms).sort((a, b) => b.atMs - a.atMs)[0]
    if (past) {
      const song = loadAllTags()[past.trackId]
      const dur = song?.durationMs ?? 240_000
      const pos = Math.max(0, Math.min(past.positionMs + (ms - past.atMs), dur - 5000))
      if (engineRef.current === 'local' && deckRef.current?.has(past.trackId)) {
        deckRef.current.play(past.trackId, pos, 0.2)
      } else {
        playTrack(sdk.deviceId, past.uri, pos).catch(() => {})
      }
    }
  }

  function stopSession() {
    setPhase('done')
  }

  function downloadSessionLog() {
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), plan, cues: cuesRef.current, log, hr: hrLogRef.current },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `session-log-${Date.now()}.json`
    a.click()
  }

  const nextCue = setlist.cues.find((c) => c.atMs > clockMs)

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Workout plan</h2>
        <textarea
          value={planText}
          onChange={(e) => setPlanText(e.target.value)}
          rows={6}
          style={{ width: '100%', boxSizing: 'border-box', background: '#161b22', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 6, padding: 8, font: 'inherit' }}
        />
        {errors.map((e) => (
          <p key={e} className="bad">{e}</p>
        ))}
        <p className="muted">
          {songs.length} tagged song(s) available · plan {Math.round(totalDurationMs(plan) / 60_000)}min
        </p>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Setlist ({setlist.cues.length} cues)</h2>
        {setlist.warnings.map((w) => (
          <p key={w} className="warn">{w}</p>
        ))}
        <table>
          <thead>
            <tr><th>at</th><th>action</th></tr>
          </thead>
          <tbody>
            {setlist.cues.map((c, i) => (
              <tr key={i} style={{ opacity: phase !== 'idle' && c.atMs <= clockMs ? 0.5 : 1 }}>
                <td>{fmtClock(c.atMs)}</td>
                <td style={{ textAlign: 'left' }}>{c.reason} — enter at {fmtClock(c.positionMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Session</h2>
        {phase === 'idle' && (
          <>
            <button onClick={() => void startSession()} disabled={errors.length > 0 || setlist.cues.length === 0}>
              3-2-1-GO (start watch on GO)
            </button>
            <label style={{ marginLeft: 12 }}>
              <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} style={{ width: 'auto' }} />{' '}
              Arm Garmin auto-start
            </label>
          </>
        )}
        <p className="muted">
          {garmin && Date.now() - garmin.receivedAt < 10_000
            ? `⌚ Garmin live: ${garmin.hr ?? '—'} bpm · timer ${garmin.timerMs != null ? fmtClock(garmin.timerMs) : '—'}${garmin.altitude != null ? ` · ${Math.round(garmin.altitude)}m` : ''}`
            : armed
              ? '⌚ Waiting for the watch… (Connect IQ field must be installed and posting)'
              : ''}
        </p>
        {countdown !== null && <span style={{ fontSize: 40, marginLeft: 12 }}>{countdown}</span>}
        {(phase === 'running' || phase === 'paused') && (
          <>
            <p className={engine === 'local' ? 'ok' : 'warn'}>
              {engine === 'local'
                ? '🎧 Local DJ engine — real crossfades'
                : 'Spotify engine — jump cuts (attach owned audio files in the Tagger for crossfades)'}
            </p>
            <div style={{ fontSize: 40 }}>{fmtClock(clockMs)}</div>
            <input
              type="range"
              min={0}
              max={totalDurationMs(plan)}
              value={Math.min(clockMs, totalDurationMs(plan))}
              onChange={(e) => scrubTo(Number(e.target.value))}
              style={{ padding: 0, margin: '8px 0' }}
              title="Scrub anywhere in the workout (testing)"
            />
            {nextCue && (
              <p className="muted">
                next: {fmtClock(nextCue.atMs)} — {nextCue.reason}
              </p>
            )}
            <button onClick={togglePause}>{phase === 'paused' ? 'Resume' : 'Pause'}</button>
            <button onClick={stopSession}>Stop choreography</button>
          </>
        )}
        {phase === 'done' && (
          <>
            <p className="ok">Session complete — {log.filter((l) => l.ok).length}/{log.length} cues fired cleanly.</p>
            <button onClick={downloadSessionLog}>Download session log</button>
            <button onClick={() => { setPhase('idle'); setClockMs(0) }}>Reset</button>
          </>
        )}
        {log.some((l) => !l.ok) && (
          <p className="warn">{log.filter((l) => !l.ok).length} cue(s) failed — playback degraded gracefully, see log.</p>
        )}
      </div>
    </>
  )
}

function fmtClock(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}
