import { useEffect, useRef, useState } from 'react'
import { LocalDeck } from '../audio/local-deck'
import { loadAudio } from '../audio/local-store'
import { beatAnchorMs } from '../conductor/beat'
import { planSetlist, totalDurationMs } from '../conductor/conductor'
import type { Cue, WorkoutPlan } from '../conductor/types'
import type { SdkHandle } from '../spike/sdk-path'
import { listDevices, pausePlayback, playTrack, transferTo, type ConnectDevice } from '../spike/webapi-path'
import { loadAllTags } from '../tags/store'
import { LiveEngine, type PlayCommand } from '../live/live-engine'
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

export const RELAY_BASE = 'https://awdj-relay.vercel.app'
export const RELAY_KEY = 'awdj-7g2k9x'

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
  distance?: number
  cadence?: number
}

export default function ConductPanel({ sdk }: { sdk: SdkHandle }) {
  const [planText, setPlanText] = useState(DEFAULT_PLAN)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [clockMs, setClockMs] = useState(0)
  const [phase, setPhase] = useState<'idle' | 'running' | 'paused' | 'done'>('idle')
  const [log, setLog] = useState<LogEntry[]>([])
  const [status, setStatus] = useState('')
  const clockRef = useRef(new SessionClock())
  const prevMsRef = useRef(0)
  const cuesRef = useRef<Cue[]>([])
  const planRef = useRef<WorkoutPlan | null>(null)
  const deckRef = useRef<LocalDeck | null>(null)
  const [engine, setEngine] = useState<'local' | 'spotify'>('spotify')
  const engineRef = useRef<'local' | 'spotify'>('spotify')
  const [garmin, setGarmin] = useState<GarminSample | null>(null)
  const [outputs, setOutputs] = useState<ConnectDevice[]>([])
  const [output, setOutput] = useState<string>('browser')
  const outputRef = useRef<string>('browser')
  outputRef.current = output
  const [liveMode, setLiveMode] = useState(false)
  const liveModeRef = useRef(false)
  liveModeRef.current = liveMode
  const liveRef = useRef<LiveEngine | null>(null)
  // Latest-render handlers for the once-created poll closure (stale-closure escape).
  const handlersRef = useRef<{
    startFromGarmin: (offset: number) => Promise<void>
    startLive: () => Promise<void>
    executeLive: (c: PlayCommand) => Promise<void>
  } | null>(null)
  const [armed, setArmed] = useState(false)
  const armedRef = useRef(false)
  armedRef.current = armed
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const handledStartRef = useRef(0)
  const [cloudState, setCloudState] = useState<'' | 'uploading' | 'uploaded' | 'failed'>('')
  const uploadedRef = useRef(false)
  const hrLogRef = useRef<{ atMs: number; hr: number }[]>([])
  // Raw watch stream (timer-clocked) — recorded so the run can be replayed
  // through the LiveEngine in the Replay Lab afterwards.
  const samplesRef = useRef<{ tMs: number; distanceM?: number; hr?: number; altitude?: number; cadence?: number }[]>([])
  const lastRecordedRef = useRef(0)

  // Live Garmin feed: poll the public relay once a second, always.
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const res = await fetch('https://awdj-relay.vercel.app/api/garmin?k=awdj-7g2k9x')
        const sample = (await res.json()) as GarminSample | null
        setGarmin(sample)
        if (!sample) return
        const fresh = Date.now() - sample.receivedAt < 5_000
        // Exact-sync auto-start: watch timer started → session starts, backdated.
        // LIVE mode: every fresh sample advances the engine — the watch's own
        // timer and distance ARE the session clock, so pauses come free.
        if (liveModeRef.current && phaseRef.current === 'running' && fresh && sample.timerMs != null) {
          setClockMs(sample.timerMs)
          const cmds =
            liveRef.current?.advance({
              tMs: sample.timerMs,
              distanceM: sample.distance,
              hr: sample.hr,
              altitudeM: sample.altitude,
            }) ?? []
          for (const c of cmds) void handlersRef.current?.executeLive(c)
        }
        if (fresh && sample.event && sample.receivedAt !== handledStartRef.current) {
          handledStartRef.current = sample.receivedAt
          if (armedRef.current && phaseRef.current === 'idle' && sample.event === 'timerStart') {
            if (liveModeRef.current) {
              void handlersRef.current?.startLive()
            } else {
              const offset = (sample.timerMs ?? 0) + (Date.now() - sample.receivedAt)
              void handlersRef.current?.startFromGarmin(offset)
            }
          } else if (phaseRef.current === 'running' && sample.event === 'timerPause') {
            // Watch paused → freeze the choreography clock and silence the music.
            clockRef.current.pause()
            if (engineRef.current === 'local') void deckRef.current?.pause()
            else pauseOnTarget()
            setPhase('paused')
          } else if (phaseRef.current === 'paused' && sample.event === 'timerResume') {
            if (liveModeRef.current) {
              // Live engine follows the watch timer; just unmute and continue.
              if (engineRef.current === 'local') void deckRef.current?.resume()
              setPhase('running')
            } else {
              // Watch resumed → re-sync to the watch's timer and re-establish
              // exactly what should be playing.
              clockRef.current.resume()
              const offset = (sample.timerMs ?? 0) + (Date.now() - sample.receivedAt)
              scrubTo(offset)
              setPhase('running')
            }
          }
        }
        if (fresh && phaseRef.current === 'running' && typeof sample.hr === 'number') {
          hrLogRef.current.push({ atMs: clockRef.current.nowMs(), hr: sample.hr })
        }
        if (fresh && phaseRef.current === 'running' && sample.timerMs != null && sample.receivedAt !== lastRecordedRef.current) {
          lastRecordedRef.current = sample.receivedAt
          samplesRef.current.push({ tMs: sample.timerMs, distanceM: sample.distance, hr: sample.hr, altitude: sample.altitude, cadence: sample.cadence })
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

  // The data flywheel: every finished session auto-uploads its log so it
  // becomes a replayable test case in the cloud (Replay Lab reads from there).
  useEffect(() => {
    if (phase !== 'done' || uploadedRef.current) return
    uploadedRef.current = true
    setCloudState('uploading')
    const payload = {
      exportedAt: new Date().toISOString(),
      source: liveModeRef.current ? 'web-live' : 'web',
      plan: planRef.current ?? plan,
      cues: cuesRef.current,
      log,
      hr: hrLogRef.current,
      samples: samplesRef.current,
    }
    fetch(`${RELAY_BASE}/api/sessions?k=${RELAY_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then((r) => setCloudState(r.ok ? 'uploaded' : 'failed'))
      .catch(() => setCloudState('failed'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  // Distance-based plans want the live engine — flip it on automatically.
  useEffect(() => {
    if (plan.steps.some((s) => s.meters != null)) setLiveMode(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planText])

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
            // Non-drop cuts wait for the outgoing track's beat; drops are exact.
            deckRef.current.play(cue.trackId, cue.positionMs, fadeFor(cue), { onBeat: !cue.reason.startsWith('drop lands') })
          } else {
            await playOnTarget(cue.uri, cue.positionMs)
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
    samplesRef.current = []
    uploadedRef.current = false
    setCloudState('')
    prevMsRef.current = -1

    // Engine choice: the local crossfade deck only exists in this browser —
    // remote outputs (e.g. the iPhone's Spotify app) always use jump-cuts.
    let allLocal = false
    if (outputRef.current === 'browser') {
      const neededIds = [...new Set(setlist.cues.map((c) => c.trackId))]
      const deck = (deckRef.current ??= new LocalDeck())
      allLocal = true
      const lib = loadAllTags()
      for (const id of neededIds) {
        const song = lib[id]
        if (song) deck.setMeta(id, { bpm: song.bpm, anchorMs: beatAnchorMs(song.markers) })
        if (deck.has(id)) continue
        const data = await loadAudio(id)
        if (data) {
          await deck.load(id, data)
        } else {
          allLocal = false
          break
        }
      }
    }
    engineRef.current = allLocal ? 'local' : 'spotify'
    setEngine(engineRef.current)
    return true
  }

  const remoteIdRef = useRef<string | null>(null)

  /** Spotify device IDs churn (app restarts, wifi↔LTE hops). Resolve the
   *  selected output by NAME, cache the id, and rediscover on demand. */
  async function resolveRemoteId(rediscover: boolean): Promise<string> {
    if (!rediscover && remoteIdRef.current) return remoteIdRef.current
    const d = (await listDevices()).find((x) => x.name === outputRef.current)
    if (!d) throw new Error(`"${outputRef.current}" not in Spotify's device list — open Spotify on it and tap play once`)
    remoteIdRef.current = d.id
    return d.id
  }

  function pauseOnTarget(): void {
    if (outputRef.current === 'browser') {
      void sdk.player.pause()
    } else {
      resolveRemoteId(false)
        .then((id) => pausePlayback(id))
        .catch(() => {})
    }
  }

  /** Play on the selected output, surviving stale remote device ids. */
  async function playOnTarget(uri: string, positionMs: number): Promise<void> {
    if (outputRef.current === 'browser') {
      await playTrack(sdk.deviceId, uri, positionMs)
      return
    }
    try {
      await playTrack(await resolveRemoteId(false), uri, positionMs)
    } catch {
      const id = await resolveRemoteId(true) // rediscover by name, re-activate, retry once
      await transferTo(id)
      await playTrack(id, uri, positionMs)
    }
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

  /** LIVE start: hand the session to the LiveEngine — the watch's stream drives everything. */
  async function startLive() {
    const lib = Object.values(loadAllTags())
    if (lib.length === 0) {
      setStatus('no tagged songs — nothing to conduct')
      return
    }
    const deck = (deckRef.current ??= new LocalDeck())
    let allLocal = outputRef.current === 'browser'
    if (allLocal) {
      for (const s of lib) {
        deck.setMeta(s.trackId, { bpm: s.bpm, anchorMs: beatAnchorMs(s.markers) })
        if (deck.has(s.trackId)) continue
        const data = await loadAudio(s.trackId)
        if (data) await deck.load(s.trackId, data)
        else {
          allLocal = false
          break
        }
      }
    }
    engineRef.current = allLocal ? 'local' : 'spotify'
    setEngine(engineRef.current)
    liveRef.current = new LiveEngine(plan, lib)
    planRef.current = plan
    setLog([])
    hrLogRef.current = []
    samplesRef.current = []
    uploadedRef.current = false
    setCloudState('')
    setPhase('running')
    setStatus(`LIVE — conducting ${plan.name} from your body's data`)
  }

  async function executeLive(c: PlayCommand) {
    const entry = { plannedAtMs: c.tMs, firedAtMs: c.tMs, cue: { atMs: c.tMs, trackId: c.trackId, uri: c.uri, positionMs: c.positionMs, reason: c.reason }, ok: true }
    try {
      if (engineRef.current === 'local' && deckRef.current?.has(c.trackId)) {
        deckRef.current.play(c.trackId, c.positionMs, c.fadeSec, { onBeat: !c.reason.startsWith('drop lands') })
      } else {
        await playOnTarget(c.uri, c.positionMs)
      }
      setLog((prev) => [...prev, entry])
    } catch (e) {
      setLog((prev) => [...prev, { ...entry, ok: false, error: String(e) }])
    }
  }
  handlersRef.current = { startFromGarmin, startLive, executeLive }

  function togglePause() {
    const clock = clockRef.current
    if (phase === 'running') {
      clock.pause()
      // workout paused = music paused
      if (engineRef.current === 'local') void deckRef.current?.pause()
      else pauseOnTarget()
      setPhase('paused')
    } else if (phase === 'paused') {
      clock.resume()
      if (engineRef.current === 'local') void deckRef.current?.resume()
      else scrubTo(clock.nowMs()) // re-establish the right song/position on the target
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
        playOnTarget(past.uri, pos).catch(() => {})
      }
    }
  }

  function stopSession() {
    setPhase('done')
  }

  /** Everything the iPhone app needs to run this session natively. */
  function exportBundle() {
    const lib = loadAllTags()
    const involved = [...new Set(setlist.cues.map((c) => c.trackId))]
      .map((id) => lib[id])
      .filter(Boolean)
      .map((s) => ({ trackId: s.trackId, name: s.name, artists: s.artists, durationMs: s.durationMs, bpm: s.bpm }))
    const bundle = {
      name: plan.name,
      planEndMs: totalDurationMs(plan),
      cues: setlist.cues,
      songs: involved,
      // LIVE-mode payload: with the plan and the full tag library on board,
      // the phone can conduct from the watch's live stream — no Mac anywhere.
      plan: plan.steps,
      tags: Object.values(lib).map((s) => ({
        trackId: s.trackId,
        uri: s.uri,
        name: s.name,
        artists: s.artists,
        durationMs: s.durationMs,
        bpm: s.bpm,
        markers: s.markers.map((m) => ({ type: m.type, ms: m.ms })),
      })),
    }
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }))
    a.download = 'session-bundle.json'
    a.click()
  }

  function downloadSessionLog() {
    const blob = new Blob(
      [
        JSON.stringify(
          { exportedAt: new Date().toISOString(), plan, cues: cuesRef.current, log, hr: hrLogRef.current, samples: samplesRef.current },
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
          {songs.length} tagged song(s) available · plan {Math.round(totalDurationMs(plan) / 60_000)}min{' '}
          <button onClick={exportBundle} disabled={setlist.cues.length === 0}>Export session bundle (for iPhone app)</button>
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
            <button
              onClick={() => void startSession()}
              disabled={errors.length > 0 || setlist.cues.length === 0 || liveMode}
              title={liveMode ? 'LIVE mode starts from the watch — press START on your Garmin' : ''}
            >
              3-2-1-GO (start watch on GO)
            </button>
            <label style={{ marginLeft: 12 }}>
              <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} style={{ width: 'auto' }} />{' '}
              Arm Garmin auto-start
            </label>
            <label style={{ marginLeft: 12 }} title="The watch's live distance/timer drives the DJ — drops land when you arrive, not when a clock guesses">
              <input type="checkbox" checked={liveMode} onChange={(e) => setLiveMode(e.target.checked)} style={{ width: 'auto' }} />{' '}
              🛰 LIVE mode (body-driven)
            </label>
            <div style={{ marginTop: 10 }}>
              <span className="muted">Audio output: </span>
              <select
                value={output}
                onChange={(e) => {
                  setOutput(e.target.value)
                  remoteIdRef.current = null
                }}
                style={{ width: 'auto' }}
              >
                <option value="browser">This browser (🎧 crossfades)</option>
                {outputs
                  .filter((d) => !d.name.includes('spike'))
                  .map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name} ({d.type}) — jump cuts
                    </option>
                  ))}
              </select>{' '}
              <button onClick={() => void listDevices().then(setOutputs).catch(() => {})}>Find devices</button>
            </div>
          </>
        )}
        {status && <p className="muted">{status}</p>}
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
            {!liveMode && (
              <input
                type="range"
                min={0}
                max={totalDurationMs(plan)}
                value={Math.min(clockMs, totalDurationMs(plan))}
                onChange={(e) => scrubTo(Number(e.target.value))}
                style={{ padding: 0, margin: '8px 0' }}
                title="Scrub anywhere in the workout (testing)"
              />
            )}
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
            {cloudState && (
              <p className={cloudState === 'failed' ? 'warn' : 'muted'}>
                {cloudState === 'uploading' && '☁️ uploading session log…'}
                {cloudState === 'uploaded' && '☁️ session log in the cloud — replayable from the Replay Lab anywhere'}
                {cloudState === 'failed' && '☁️ upload failed — use Download to keep the log'}
              </p>
            )}
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
