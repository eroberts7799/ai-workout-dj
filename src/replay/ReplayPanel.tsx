// Replay Lab — LIVE mode's test bench. Simulate a runner (or replay a recorded
// session log) through the LiveEngine and see every decision it would make:
// step boundaries as actually crossed, every cut, where each drop lands.
// Optionally hear it through the local deck at accelerated speed.
import { useMemo, useRef, useState } from 'react'
import { LocalDeck, deckOptsFor } from '../audio/local-deck'
import { loadAudio } from '../audio/local-store'
import type { SongTags, WorkoutPlan, WorkoutStep } from '../conductor/types'
import { beatAnchorMs } from '../conductor/beat'
import { parsePlan } from '../conduct/plan-parse'
import { RELAY_BASE, RELAY_KEY } from '../conduct/ConductPanel'
import { loadAllTags } from '../tags/store'
import { loadPairWeights } from '../weights'
import {
  importTcx,
  loadSessionLog,
  loadStructuredRun,
  simulate,
  syntheticSamples,
  type LoadedLog,
  type SimResult,
  type TracePoint,
} from './simulate'

/** One corpus entry from the dev server's /api/corpus listing. */
interface CorpusEntry {
  file: string
  name: string
  date: string
  steps: number
  hard: number
  samples: number
}

/** One row of the mass-test table. */
interface BatchRow {
  file: string
  name: string
  hard: number
  landings: number
  onTime: number
  worstMs: number
  truncated: number
  reaims: number
  warnings: number
}

const ON_TIME_MS = 1_920 // one 4-beat bar at ~125bpm — reads as "on the moment"

const DEFAULT_PLAN = `# the live-run target workout
warmup 3:00
4x easy 400m hard 800m
cooldown 3:00`

// Tagged songs the engine can't use are worthless here — fall back to a demo
// library so the lab works before anything is tagged.
const DEMO_SONGS: SongTags[] = ['demo-a', 'demo-b', 'demo-c'].map((id) => ({
  trackId: id,
  uri: `spotify:track:${id}`,
  name: `Demo ${id.slice(-1).toUpperCase()}`,
  artists: 'Replay Lab',
  durationMs: 240_000,
  bpm: 128,
  updatedAt: '2026-01-01T00:00:00Z',
  markers: [
    { id: 'l1', type: 'loop_start', ms: 30_000 },
    { id: 'l2', type: 'loop_end', ms: 60_000 },
    { id: 'b', type: 'buildup', ms: 75_000 },
    { id: 'd', type: 'drop', ms: 95_000 },
  ],
}))

/** "6:30" or "390" → seconds per km. */
function parsePace(s: string): number | null {
  const mmss = s.trim().match(/^(\d+):([0-5]\d)$/)
  if (mmss) return Number(mmss[1]) * 60 + Number(mmss[2])
  const secs = s.trim().match(/^\d+$/)
  return secs ? Number(s) : null
}

function fmtClock(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${String(s).padStart(2, '0')}/km`
}

function cmdColor(reason: string): string {
  if (reason.startsWith('loop back')) return '#199e70'
  if (reason.startsWith('buildup')) return '#9085e9'
  if (reason.startsWith('drop lands')) return '#d55181'
  return '#3987e5' // groove fill
}

function landingColor(errorMs: number): string {
  const e = Math.abs(errorMs)
  return e <= 2000 ? '#199e70' : e <= 5000 ? '#c98500' : '#e66767'
}

export default function ReplayPanel() {
  const [planText, setPlanText] = useState(DEFAULT_PLAN)
  const [easyPace, setEasyPace] = useState('6:30')
  const [hardPace, setHardPace] = useState('4:45')
  const [fatiguePct, setFatiguePct] = useState(0)
  const [noisePct, setNoisePct] = useState(4)
  const [hilly, setHilly] = useState(true)
  const [withHr, setWithHr] = useState(true)
  const [loaded, setLoaded] = useState<LoadedLog | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [status, setStatus] = useState('')
  const [cloud, setCloud] = useState<{ pathname: string; size: number; uploadedAt: string }[] | null>(null)
  const [corpus, setCorpus] = useState<CorpusEntry[] | null>(null)
  const [useWkStep, setUseWkStep] = useState(true)
  const [batch, setBatch] = useState<BatchRow[] | null>(null)
  const [batchBusy, setBatchBusy] = useState('')

  // Replay machinery — seekable: a position (replayMs) that the slider can
  // move anywhere, and a play mode that advances it in real time (×1 default:
  // the session takes exactly as long as the data says it will).
  const deckRef = useRef<LocalDeck | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const anchorRef = useRef<{ perf: number; ms: number } | null>(null)
  const [replayMs, setReplayMs] = useState(0)
  const [playMode, setPlayMode] = useState<'idle' | 'silent' | 'audio'>('idle')
  const [speed, setSpeed] = useState(1)

  const lib = Object.values(loadAllTags())
  const hasDrop = lib.some((s) => s.markers.some((m) => m.type === 'drop'))
  const hasLoop = lib.some(
    (s) => s.markers.some((m) => m.type === 'loop_start') && s.markers.some((m) => m.type === 'loop_end'),
  )
  const usingDemo = !(hasDrop && hasLoop)
  const engineSongs = usingDemo ? DEMO_SONGS : lib

  const { plan: parsedPlan, errors } = parsePlan('replay', planText)
  const activePlan: WorkoutPlan = loaded?.plan ?? parsedPlan
  const easy = parsePace(easyPace)
  const hard = parsePace(hardPace)
  const paceErrors = [
    ...(easy == null ? ['easy pace: use mm:ss per km (e.g. 6:30)'] : []),
    ...(hard == null ? ['hard pace: use mm:ss per km (e.g. 4:45)'] : []),
  ]

  async function runSim() {
    stopReplay()
    const pairBonus = await loadPairWeights()
    let samples = loaded
      ? loaded.samples
      : syntheticSamples(activePlan, {
          easyPaceSecPerKm: easy!,
          hardPaceSecPerKm: hard!,
          fatiguePct,
          noisePct,
          hilly,
          withHr,
        })
    // Comparing the engine's two regimes: with the watch's step stream
    // (boundaries exact) or estimation-only (odometer + plan).
    if (!useWkStep) samples = samples.map(({ wkStepSeq: _seq, ...s }) => s)
    if (samples.length === 0) {
      setStatus('no samples to replay')
      return
    }
    setResult(simulate(activePlan, engineSongs, samples, { pairBonus, ...(loaded?.hrMax != null ? { hrMax: loaded.hrMax } : {}) }))
    setStatus('')
  }

  // ---- Real-run corpus (served by the dev server from the local extract) ----

  async function loadCorpusList() {
    try {
      const r = await fetch('/api/corpus')
      const list = (await r.json()) as CorpusEntry[]
      setCorpus(list)
      if (list.length === 0)
        setStatus('no extracted runs — run analysis/extract_structured_runs.py over the FIT takeout first')
    } catch (e) {
      setStatus(`corpus list failed (dev server only): ${String(e)}`)
    }
  }

  /** One click from list to verdict: load a real run and simulate it. */
  async function openCorpusRun(file: string) {
    try {
      const r = await fetch(`/api/corpus/${encodeURIComponent(file)}`)
      const log = loadStructuredRun(await r.json())
      acceptLog(log, 'that run')
      stopReplay()
      const samples = useWkStep ? log.samples : log.samples.map(({ wkStepSeq: _s, ...rest }) => rest)
      if (log.plan && samples.length > 0) {
        setResult(simulate(log.plan, engineSongs, samples, { pairBonus: await loadPairWeights(), ...(log.hrMax != null ? { hrMax: log.hrMax } : {}) }))
      }
    } catch (e) {
      setStatus(`corpus fetch failed: ${String(e)}`)
    }
  }

  /** Mass test: every real run in the corpus through the engine, one table. */
  async function runBatch() {
    if (!corpus || corpus.length === 0) return
    stopReplay()
    setBatch(null)
    const rows: BatchRow[] = []
    for (let i = 0; i < corpus.length; i++) {
      setBatchBusy(`testing ${i + 1}/${corpus.length} — ${corpus[i].name}`)
      await new Promise((r) => setTimeout(r)) // let the progress line paint
      try {
        const raw = await (await fetch(`/api/corpus/${encodeURIComponent(corpus[i].file)}`)).json()
        let log = loadStructuredRun(raw)
        if (!useWkStep) log = { ...log, samples: log.samples.map(({ wkStepSeq: _s, ...rest }) => rest) }
        const res = simulate(log.plan!, engineSongs, log.samples, { pairBonus: await loadPairWeights(), ...(log.hrMax != null ? { hrMax: log.hrMax } : {}) })
        const errs = res.landings.map((l) => Math.abs(l.errorMs))
        rows.push({
          file: corpus[i].file,
          name: log.name,
          hard: corpus[i].hard,
          landings: res.landings.length,
          onTime: errs.filter((e) => e <= ON_TIME_MS).length,
          worstMs: errs.length > 0 ? Math.max(...errs) : 0,
          truncated: res.commands.filter((c) => c.reason.includes('truncated')).length,
          reaims: res.commands.filter((c) => c.reason.startsWith('build re-aim')).length,
          warnings: res.warnings.length,
        })
      } catch {
        rows.push({ file: corpus[i].file, name: `${corpus[i].name} (failed)`, hard: corpus[i].hard, landings: 0, onTime: 0, worstMs: 0, truncated: 0, reaims: 0, warnings: 1 })
      }
    }
    setBatchBusy('')
    setBatch(rows.sort((a, b) => b.worstMs - a.worstMs))
  }

  function acceptLog(log: LoadedLog, origin: string) {
    if (log.samples.length === 0) {
      setStatus(`${origin} has no replayable samples (record a new session — logs now carry the raw watch stream)`)
      return
    }
    setLoaded(log)
    setResult(null)
    setStatus(
      `loaded "${log.name}": ${log.samples.length} samples` +
        `${log.samples.some((s) => s.distanceM != null) ? ' · distance ✓' : ' · time-only'}` +
        `${log.samples.some((s) => s.hr != null) ? ' · HR ✓' : ''}` +
        `${log.plan ? '' : ' · no plan in log — using the plan text above'}`,
    )
  }

  async function onLogFile(file: File) {
    const text = await file.text()
    try {
      if (file.name.toLowerCase().endsWith('.tcx') || text.trimStart().startsWith('<')) {
        acceptLog(importTcx(text), 'that TCX export')
      } else {
        acceptLog(loadSessionLog(JSON.parse(text)), 'that log')
      }
    } catch (e) {
      // Not a log — maybe it's a PLAN text file (docs/tuesday-*.txt). Picking
      // a plan through this picker is the natural move; route it home.
      const { plan: asPlan, errors: planErrors } = parsePlan(file.name, text)
      if (planErrors.length === 0 && asPlan.steps.length > 0) {
        setLoaded(null)
        setResult(null)
        setPlanText(text)
        setStatus(`"${file.name}" loaded as a plan (${asPlan.steps.length} steps) — set paces, then Simulate run`)
        return
      }
      setStatus(`could not read log: ${String(e)}`)
    }
  }

  /** Archive a locally-imported log (e.g. a Garmin TCX) to the cloud. */
  async function saveLoadedToCloud() {
    if (!loaded) return
    try {
      const r = await fetch(`${RELAY_BASE}/api/sessions?k=${RELAY_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: loaded.name, source: 'import', samples: loaded.samples, plan: loaded.plan ?? undefined }),
      })
      setStatus(r.ok ? `☁️ "${loaded.name}" archived to the cloud` : 'cloud save failed')
    } catch (e) {
      setStatus(`cloud save failed: ${String(e)}`)
    }
  }

  async function loadCloudList() {
    try {
      const r = await fetch(`${RELAY_BASE}/api/sessions?k=${RELAY_KEY}`)
      setCloud(await r.json())
    } catch (e) {
      setStatus(`cloud list failed: ${String(e)}`)
    }
  }

  async function openCloud(pathname: string) {
    try {
      const r = await fetch(`${RELAY_BASE}/api/sessions?k=${RELAY_KEY}&file=${encodeURIComponent(pathname)}`)
      acceptLog(loadSessionLog(await r.json()), 'that cloud session')
    } catch (e) {
      setStatus(`cloud fetch failed: ${String(e)}`)
    }
  }

  function clearTimers() {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
    if (tickerRef.current) clearInterval(tickerRef.current)
    tickerRef.current = null
  }

  /** Cue the audio to what should be playing at ms (last command before it). */
  function establishAudio(ms: number) {
    const deck = deckRef.current
    if (!deck || !result) return
    const cmd = [...result.commands].reverse().find((c) => c.tMs <= ms && deck.has(c.trackId))
    if (cmd) deck.play(cmd.trackId, cmd.positionMs + (ms - cmd.tMs), 0.15)
    else void deck.pause()
  }

  /** Schedule the commands from ms onward at ×speed. */
  function scheduleAudioFrom(ms: number) {
    const deck = deckRef.current
    if (!deck || !result) return
    for (const c of result.commands) {
      if (c.tMs < ms) continue
      // Time compression artifact: at ×N the engine's musical clock outruns
      // 1× audio, so loop-backs would re-cut every few real seconds — mute
      // them and let the groove play through. ×1 executes everything.
      if (speed > 1 && c.reason.startsWith('loop back')) continue
      timersRef.current.push(
        setTimeout(() => {
          if (deck.has(c.trackId))
            deck.play(
              c.trackId,
              c.positionMs,
              Math.max(0.12, c.fadeSec / speed),
              speed === 1 ? deckOptsFor(c.reason) : {}, // beat waits/locks only make sense in real time
            )
        }, (c.tMs - ms) / speed),
      )
    }
  }

  function startTicker(fromMs: number, durationMs: number) {
    anchorRef.current = { perf: performance.now(), ms: fromMs }
    tickerRef.current = setInterval(() => {
      const a = anchorRef.current
      if (!a) return
      const ms = a.ms + (performance.now() - a.perf) * speed
      if (ms >= durationMs) {
        pausePlayback()
        setReplayMs(durationMs)
      } else {
        setReplayMs(ms)
      }
    }, 100)
  }

  /** Play from the slider position — silent (dashboard only) or with audio. */
  async function play(withAudio: boolean) {
    if (!result) return
    clearTimers()
    const from = replayMs >= result.durationMs - 1000 ? 0 : replayMs
    setReplayMs(from)
    if (withAudio) {
      const deck = (deckRef.current ??= new LocalDeck())
      const ids = [...new Set(result.commands.map((c) => c.trackId))]
      let loadedCount = 0
      for (const id of ids) {
        const song = engineSongs.find((s) => s.trackId === id)
        if (song) deck.setMeta(id, { bpm: song.bpm, anchorMs: beatAnchorMs(song.markers) })
        if (deck.has(id)) {
          loadedCount++
          continue
        }
        const data = await loadAudio(id)
        if (data) {
          await deck.load(id, data)
          loadedCount++
        }
      }
      if (loadedCount === 0) {
        setStatus('listening needs songs with attached audio files (Tagger → attach file) — ▶ Watch works without them')
        return
      }
      const skipped = result.commands.filter((c) => !deck.has(c.trackId)).length
      setStatus(skipped > 0 ? `${skipped} command(s) hit songs without audio — silent gaps` : '')
      establishAudio(from)
      scheduleAudioFrom(from)
    }
    setPlayMode(withAudio ? 'audio' : 'silent')
    startTicker(from, result.durationMs)
  }

  function pausePlayback() {
    clearTimers()
    void deckRef.current?.pause()
    setPlayMode('idle')
  }

  /** Slide anywhere in the session; playback (and audio) follow. */
  function seek(ms: number) {
    setReplayMs(ms)
    if (playMode === 'idle') return
    anchorRef.current = { perf: performance.now(), ms }
    if (playMode === 'audio') {
      clearTimers()
      establishAudio(ms)
      scheduleAudioFrom(ms)
      if (result) startTicker(ms, result.durationMs)
    }
  }

  /** Full reset (new sim / new load): pause and rewind. */
  function stopReplay() {
    clearTimers()
    deckRef.current?.stop()
    setPlayMode('idle')
    setReplayMs(0)
  }

  const worst = result && result.landings.length > 0 ? Math.max(...result.landings.map((l) => Math.abs(l.errorMs))) : null

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Replay Lab 🧪</h2>
        <p className="muted">
          Dry-run LIVE mode: a simulated runner (or a recorded session log) drives the exact engine that will conduct
          your real run. See where every drop would land before you lace up.
        </p>
        <textarea
          value={planText}
          onChange={(e) => setPlanText(e.target.value)}
          rows={5}
          disabled={loaded?.plan != null}
          style={{ width: '100%', boxSizing: 'border-box', background: 'var(--olive-wash)', color: 'var(--ink)', border: 0, borderRadius: 0, padding: 10, fontFamily: 'var(--mono)', fontSize: 12, lineHeight: 1.6 }}
        />
        {!loaded && errors.map((e) => <p key={e} className="bad">{e}</p>)}
        {!loaded && paceErrors.map((e) => <p key={e} className="bad">{e}</p>)}

        {!loaded && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <label>
              easy pace <input value={easyPace} onChange={(e) => setEasyPace(e.target.value)} style={{ width: 60 }} />
            </label>
            <label>
              hard pace <input value={hardPace} onChange={(e) => setHardPace(e.target.value)} style={{ width: 60 }} />
            </label>
            <label title="pace drifts this % slower by the planned end">
              fatigue {fatiguePct}%{' '}
              <input type="range" min={0} max={25} value={fatiguePct} onChange={(e) => setFatiguePct(Number(e.target.value))} style={{ width: 100, verticalAlign: 'middle' }} />
            </label>
            <label title="second-to-second pace wobble">
              wobble {noisePct}%{' '}
              <input type="range" min={0} max={12} value={noisePct} onChange={(e) => setNoisePct(Number(e.target.value))} style={{ width: 100, verticalAlign: 'middle' }} />
            </label>
            <label title="two 4% climbs on the route — crest rewards fire at the top">
              <input type="checkbox" checked={hilly} onChange={(e) => setHilly(e.target.checked)} style={{ width: 'auto' }} /> ⛰ hills
            </label>
            <label title="synthetic heart rate chasing each step's effort">
              <input type="checkbox" checked={withHr} onChange={(e) => setWithHr(e.target.checked)} style={{ width: 'auto' }} /> ❤️ HR
            </label>
          </div>
        )}

        <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="arm" onClick={() => void runSim()} disabled={!loaded && (errors.length > 0 || paceErrors.length > 0)}>
            {loaded ? 'Replay recorded session' : 'Simulate run'}
          </button>
          <label className="muted" style={{ cursor: 'pointer' }}>
            📄 Load session log / Garmin TCX…
            <input
              type="file"
              accept="application/json,.json,.tcx"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onLogFile(f)
                e.target.value = ''
              }}
            />
          </label>
          <button onClick={() => void loadCloudList()}>☁️ Cloud sessions</button>
          <button onClick={() => void loadCorpusList()}>🏃 Real runs</button>
          <label title="Feed the engine the watch's step-change stream (exact boundaries) or make it estimate from time/distance alone">
            <input type="checkbox" checked={useWkStep} onChange={(e) => setUseWkStep(e.target.checked)} style={{ width: 'auto' }} />{' '}
            ⌚ watch step stream
          </label>
          {loaded && (
            <>
              <button onClick={() => void saveLoadedToCloud()}>☁️ archive this</button>
              <button onClick={() => { setLoaded(null); setResult(null); setStatus('') }}>✕ back to simulated runner</button>
            </>
          )}
        </div>
        {corpus && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => void runBatch()} disabled={batchBusy !== '' || corpus.length === 0}>
                ▶ Test all {corpus.length} runs
              </button>
              {batchBusy && <span className="muted" style={{ fontSize: 12 }}>{batchBusy}</span>}
            </div>
            <div style={{ marginTop: 6, maxHeight: 200, overflowY: 'auto', border: '1px solid #30363d', borderRadius: 6, padding: 6 }}>
              {corpus.map((c) => (
                <div key={c.file} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                  <button onClick={() => void openCorpusRun(c.file)} style={{ fontSize: 12 }}>replay</button>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {c.date} · {c.name} · {c.steps} steps ({c.hard} hard)
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {cloud && (
          <div style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto', border: '1px solid #30363d', borderRadius: 6, padding: 6 }}>
            {cloud.length === 0 && <p className="muted" style={{ margin: 4 }}>no sessions in the cloud yet</p>}
            {cloud.map((c) => (
              <div key={c.pathname} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                <button onClick={() => void openCloud(c.pathname)} style={{ fontSize: 12 }}>replay</button>
                <span className="muted" style={{ fontSize: 12 }}>
                  {c.pathname.replace('sessions/', '').replace(/-[A-Za-z0-9]{20,}\.json$/, '')} · {Math.round(c.size / 1024)}kB
                </span>
              </div>
            ))}
          </div>
        )}
        {usingDemo && (
          <p className="warn" style={{ marginBottom: 0 }}>
            No fully-tagged songs (need loop + drop markers) — using a 3-song demo library. Timeline works; audible
            replay won't.
          </p>
        )}
        {status && <p className="muted">{status}</p>}
      </div>

      {batch && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>
            Mass test — {batch.length} real runs{' '}
            <span className="muted" style={{ fontWeight: 'normal', fontSize: 14 }}>
              {batch.reduce((n, r) => n + r.onTime, 0)}/{batch.reduce((n, r) => n + r.landings, 0)} drops on-time (≤
              {(ON_TIME_MS / 1000).toFixed(1)}s) · worst{' '}
              {(Math.max(0, ...batch.map((r) => r.worstMs)) / 1000).toFixed(1)}s ·{' '}
              {useWkStep ? 'watch-driven' : 'estimation-only'}
            </span>
          </h2>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>run</th><th>reps</th><th>on-time</th><th>worst</th><th>trunc</th><th>re-aims</th><th></th></tr>
              </thead>
              <tbody>
                {batch.map((r) => (
                  <tr key={r.file}>
                    <td style={{ textAlign: 'left' }} title={r.file}>{r.name.slice(0, 34)}{r.warnings > 0 ? ' ⚠️' : ''}</td>
                    <td>{r.hard}</td>
                    <td style={{ color: r.onTime === r.landings && r.landings > 0 ? '#199e70' : undefined }}>
                      {r.onTime}/{r.landings}
                    </td>
                    <td style={{ color: landingColor(r.worstMs) }}>{(r.worstMs / 1000).toFixed(1)}s</td>
                    <td>{r.truncated || ''}</td>
                    <td>{r.reaims || ''}</td>
                    <td><button style={{ fontSize: 12 }} onClick={() => void openCorpusRun(r.file)}>watch</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>
              What the engine would do{' '}
              <span className="muted" style={{ fontWeight: 'normal', fontSize: 14 }}>
                {result.landings.length} landing(s)
                {worst != null && <> · worst {(worst / 1000).toFixed(1)}s off</>} ·{' '}
                {result.commands.length} transitions ·{' '}
                {fmtClock(result.durationMs)} total
              </span>
            </h2>
            {result.warnings.map((w) => (
              <p key={w} className="warn">{w}</p>
            ))}
            <LiveStatus result={result} tMs={replayMs} songs={engineSongs} />
            <CourseView result={result} playheadMs={replayMs} songs={engineSongs} />
            <Timeline result={result} playheadMs={replayMs} truth={loaded?.boundaries ?? null} />
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {playMode === 'idle' ? (
                <>
                  <button onClick={() => void play(false)}>▶ Watch</button>
                  <button onClick={() => void play(true)}>🎧 Listen</button>
                </>
              ) : (
                <button onClick={pausePlayback}>⏸ Pause</button>
              )}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: 'auto' }} disabled={playMode !== 'idle'} title="×1 = real time — the session takes as long as the data says">
                {[1, 2, 4, 8, 16].map((x) => (
                  <option key={x} value={x}>×{x}{x === 1 ? ' (real time)' : ''}</option>
                ))}
              </select>
              <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {fmtClock(replayMs)} / {fmtClock(result.durationMs)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={result.durationMs}
              step={1000}
              value={Math.min(replayMs, result.durationMs)}
              onChange={(e) => seek(Number(e.target.value))}
              style={{ width: '100%', marginTop: 6 }}
              title="Slide to any moment — the dashboard, course, and audio follow"
            />
          </div>

          <div className="card">
            <h2 style={{ marginTop: 0 }}>Landings</h2>
            {result.landings.length === 0 ? (
              <p className="muted">no hard-step landings in this plan</p>
            ) : (
              <table>
                <thead>
                  <tr><th>rep</th><th>drop aimed at</th><th>you arrived</th><th>error</th></tr>
                </thead>
                <tbody>
                  {result.landings.map((l, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td>{fmtClock(l.targetTMs)}</td>
                      <td>{fmtClock(l.actualTMs)}</td>
                      <td style={{ color: landingColor(l.errorMs) }}>
                        {l.errorMs >= 0 ? '+' : '−'}{(Math.abs(l.errorMs) / 1000).toFixed(1)}s
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <details style={{ marginTop: 10 }}>
              <summary className="muted" style={{ cursor: 'pointer' }}>all {result.commands.length} commands</summary>
              <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr><th>at</th><th>command</th><th>enter at</th></tr>
                  </thead>
                  <tbody>
                    {result.commands.map((c, i) => (
                      <tr key={i}>
                        <td>{fmtClock(c.tMs)}</td>
                        <td style={{ textAlign: 'left' }}>
                          <span style={{ color: cmdColor(c.reason) }}>■</span> {c.reason}
                        </td>
                        <td>{fmtClock(c.positionMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// CourseView: the race-profile picture — the course drawn in DISTANCE space
// (elevation filled underneath, hard intervals as shaded climb columns,
// steep grades labeled), with every musical event pinned where it happens on
// the course and a runner moving through it during replay. The question it
// answers at a glance: do the songs switch at the points that matter?

const CV_H = 190
const CV_PROFILE_TOP = 46
const CV_PROFILE_BOT = CV_H - 24

function CourseView({ result, playheadMs, songs }: { result: SimResult; playheadMs: number | null; songs: SongTags[] }) {
  const { trace, durationMs } = result
  const hasDist = trace.some((p) => p.distanceM != null)
  const geometry = useMemo(() => {
    if (trace.length === 0) return null
    // Course domain: distance when we have it, time as a stand-in when not —
    // the picture still reads, the axis label says which it is.
    const domain = (p: TracePoint) => (hasDist ? (p.distanceM ?? 0) : p.tMs)
    const total = domain(trace[trace.length - 1])
    if (total <= 0) return null
    const x = (v: number) => X0 + (v / total) * XW
    const atT = (tMs: number) => {
      const idx = Math.max(0, Math.min(trace.length - 1, Math.round(tMs / 1000) - 1))
      return domain(trace[idx])
    }
    // Elevation, lightly smoothed; flat ribbon when the run has none.
    const alts = trace.map((p) => p.altitude)
    const hasAlt = alts.some((a) => a != null)
    const smooth: number[] = []
    if (hasAlt) {
      const raw = alts.map((a, i) => a ?? alts[i - 1] ?? 0)
      for (let i = 0; i < raw.length; i++) {
        const lo = Math.max(0, i - 7)
        const win = raw.slice(lo, i + 8)
        smooth.push(win.reduce((s, v) => s + v, 0) / win.length)
      }
    }
    const aLo = hasAlt ? Math.min(...smooth) : 0
    const aHi = hasAlt ? Math.max(...smooth, aLo + 8) : 1
    const yAlt = (a: number) => CV_PROFILE_BOT - ((a - aLo) / (aHi - aLo)) * (CV_PROFILE_BOT - CV_PROFILE_TOP)
    const surface = (v: number) => {
      if (!hasAlt) return CV_PROFILE_BOT - (CV_PROFILE_BOT - CV_PROFILE_TOP) * 0.35
      // nearest trace point in course space
      let best = 0
      let bestD = Infinity
      for (let i = 0; i < trace.length; i += 4) {
        const d = Math.abs(domain(trace[i]) - v)
        if (d < bestD) { bestD = d; best = i }
      }
      return yAlt(smooth[best])
    }
    const profile = hasAlt
      ? `M${X0},${CV_PROFILE_BOT} ` +
        trace.map((p, i) => `L${x(domain(p)).toFixed(1)},${yAlt(smooth[i]).toFixed(1)}`).join(' ') +
        ` L${X0 + XW},${CV_PROFILE_BOT} Z`
      : `M${X0},${CV_PROFILE_BOT} L${X0},${surface(0)} L${X0 + XW},${surface(0)} L${X0 + XW},${CV_PROFILE_BOT} Z`
    return { x, atT, total, surface, profile, hasAlt }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])
  if (!geometry) return null
  const { x, atT, total, surface, profile } = geometry

  const fmtCourse = (v: number) => (hasDist ? `${(v / 1000).toFixed(v < 9950 ? 1 : 0)}km` : fmtClock(v))
  const ticks: number[] = []
  const step = hasDist ? [500, 1000, 2000, 5000].find((s) => total / s <= 12) ?? 10000 : Math.max(60_000, Math.ceil(total / 10 / 60_000) * 60_000)
  for (let v = step; v < total; v += step) ticks.push(v)

  // Hard intervals as climb-style shaded columns, labeled with avg grade.
  const hardCols = result.stepSpans
    .filter((s) => s.step.kind === 'hard')
    .map((s) => {
      const a = atT(s.startMs)
      const b = atT(s.endMs)
      const grades = trace.filter((p) => p.tMs >= s.startMs && p.tMs < s.endMs).map((p) => p.gradePct)
      const avgGrade = grades.length > 0 ? grades.reduce((x1, y) => x1 + y, 0) / grades.length : 0
      return { a, b, avgGrade }
    })

  // Drop badges come from LANDINGS: a committed buildup lands with no new
  // command (the audio simply arrives at the drop), so commands alone miss
  // most drops. Crest rewards are commands-only (never landings) — ⛰ pins.
  const crests = result.commands.filter((c) => c.reason.includes('crest reward'))
  const others = result.commands.filter((c) => !c.reason.startsWith('drop lands') && !c.reason.startsWith('loop back'))
  const runnerV = playheadMs != null ? atT(Math.min(playheadMs, durationMs)) : null
  const nowCmd = playheadMs != null ? [...result.commands].reverse().find((c) => c.tMs <= playheadMs) : null
  const nowSong = nowCmd ? songs.find((s) => s.trackId === nowCmd.trackId) : null

  return (
    <svg viewBox={`0 0 ${W} ${CV_H}`} style={{ width: '100%', display: 'block', background: '#171711', border: 0, borderRadius: 0, marginBottom: 8 }}>
      {/* course profile */}
      <path d={profile} fill="#2b4a8f" opacity={0.9} />
      {/* hard-interval climb columns */}
      {hardCols.map((c, i) => {
        const w = x(c.b) - x(c.a)
        return (
          <g key={i}>
            <rect x={x(c.a)} y={CV_PROFILE_TOP - 14} width={Math.max(1, w)} height={CV_PROFILE_BOT - CV_PROFILE_TOP + 14} fill="#8a4a6d" opacity={0.38} />
            {w > 30 && (
              <text x={x(c.a) + w / 2} y={CV_PROFILE_BOT - 6} textAnchor="middle" fontSize={10} fill="#e6edf3" opacity={0.9}>
                {Math.abs(c.avgGrade) >= 1 ? `${c.avgGrade > 0 ? '+' : ''}${c.avgGrade.toFixed(1)}%` : 'hard'}
              </text>
            )}
          </g>
        )
      })}
      {/* song-change pins (fills, buildups, re-aims) */}
      {others.map((c, i) => {
        const v = atT(c.tMs)
        const sy = surface(v)
        return (
          <g key={`p${i}`}>
            <line x1={x(v)} y1={sy - 16} x2={x(v)} y2={sy} stroke={cmdColor(c.reason)} strokeWidth={1.5} />
            <circle cx={x(v)} cy={sy - 18} r={3} fill={cmdColor(c.reason)}>
              <title>{`${fmtCourse(v)} · ${fmtClock(c.tMs)} — ${c.reason}`}</title>
            </circle>
          </g>
        )
      })}
      {/* drops: one numbered badge per landing, colored by accuracy */}
      {result.landings.map((l, i) => {
        const v = atT(l.targetTMs)
        const sy = surface(v)
        const col = landingColor(l.errorMs)
        return (
          <g key={`d${i}`}>
            <line x1={x(v)} y1={sy - 26} x2={x(v)} y2={sy} stroke={col} strokeWidth={1.5} />
            <circle cx={x(v)} cy={sy - 32} r={9} fill={col}>
              <title>{`drop ${i + 1} · ${fmtCourse(v)} · ${fmtClock(l.targetTMs)} — landed ${l.errorMs >= 0 ? '+' : '−'}${(Math.abs(l.errorMs) / 1000).toFixed(1)}s`}</title>
            </circle>
            <text x={x(v)} y={sy - 28.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">{i + 1}</text>
          </g>
        )
      })}
      {/* crest-reward drops (unplanned moments the body earned) */}
      {crests.map((c, i) => {
        const v = atT(c.tMs)
        const sy = surface(v)
        return (
          <text key={`c${i}`} x={x(v)} y={sy - 24} textAnchor="middle" fontSize={13}>
            ⛰<title>{`${fmtCourse(v)} · ${fmtClock(c.tMs)} — ${c.reason}`}</title>
          </text>
        )
      })}
      {/* start / finish */}
      <circle cx={X0 + 4} cy={surface(0) - 10} r={8} fill="#199e70" />
      <text x={X0 + 4} y={surface(0) - 6.5} textAnchor="middle" fontSize={10} fontWeight={700} fill="#fff">S</text>
      <text x={X0 + XW - 4} y={surface(total) - 12} textAnchor="middle" fontSize={13}>🏁</text>
      {/* the runner */}
      {runnerV != null && (
        <g>
          <line x1={x(runnerV)} y1={surface(runnerV)} x2={x(runnerV)} y2={CV_PROFILE_BOT} stroke="#e6edf3" opacity={0.5} />
          <text
            x={x(runnerV)}
            y={surface(runnerV) - 8}
            textAnchor="middle"
            fontSize={16}
            transform={`translate(${x(runnerV) * 2}, 0) scale(-1, 1)`}
          >
            🏃
          </text>
          {nowSong && (
            <text x={Math.min(Math.max(x(runnerV), 60), W - 60)} y={CV_PROFILE_TOP - 28} textAnchor="middle" fontSize={11} fill="#8b949e" fontStyle="italic">
              🎧 {nowSong.name}
            </text>
          )}
        </g>
      )}
      {/* course axis */}
      {ticks.map((v) => (
        <g key={v}>
          <line x1={x(v)} y1={CV_PROFILE_BOT} x2={x(v)} y2={CV_PROFILE_BOT + 4} stroke="#8b949e" />
          <text x={x(v)} y={CV_H - 8} textAnchor="middle" fontSize={10} fill="#8b949e">{fmtCourse(v)}</text>
        </g>
      ))}
      <text x={X0} y={CV_H - 8} fontSize={10} fill="#8b949e">{hasDist ? 'course' : 'time'}</text>
    </svg>
  )
}

// ---------------------------------------------------------------------------
// LiveStatus: the engine's mind while the replay runs — what the runner is
// doing, what the DJ is thinking, what's playing, what's about to happen.

function LiveStatus({ result, tMs, songs }: { result: SimResult; tMs: number; songs: SongTags[] }) {
  const { trace } = result
  const idx = Math.max(0, Math.min(trace.length - 1, Math.floor(tMs / 1000) - 1))
  const p = trace[idx]
  const cmd = [...result.commands].reverse().find((c) => c.tMs <= tMs)
  const song = cmd ? songs.find((s) => s.trackId === cmd.trackId) : null
  const songPos = cmd ? cmd.positionMs + (tMs - cmd.tMs) : 0
  const step = result.stepSpans.find((s) => tMs >= s.startMs && tMs < s.endMs)
  const stepPct = step ? Math.round(((tMs - step.startMs) / Math.max(1, step.endMs - step.startMs)) * 100) : null
  const eta = p?.etaToHardMs
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'baseline', padding: '6px 0 10px' }}>
      <span style={{ fontSize: 26, fontVariantNumeric: 'tabular-nums' }}>{fmtClock(tMs)}</span>
      {step && (
        <span style={{ fontSize: 17, fontFamily: 'var(--cond)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.08em', color: step.step.kind === 'hard' ? 'var(--olive)' : 'var(--ink)' }}>
          {step.step.kind}
          {step.step.meters != null ? ` ${Math.round(step.step.meters)}m` : ''} · {stepPct}%
        </span>
      )}
      {p?.distanceM != null && <span className="muted">{(p.distanceM / 1000).toFixed(2)}km · {fmtPace(p.paceSecPerKm)}</span>}
      {p?.hr != null && <span style={{ color: 'var(--ink)', fontWeight: 600 }}>♥ {Math.round(p.hr)} z{p.hrZone}</span>}
      <span style={{ color: cmd ? cmdColor(cmd.reason) : 'var(--faded)' }}>
        {p?.mode ?? '—'}
        {eta != null && eta < 120_000 && p?.mode !== 'ride' && ` · drop in ${Math.max(0, Math.round(eta / 1000))}s`}
      </span>
      {song && (
        <span className="muted" style={{ fontStyle: 'italic' }}>
          🎧 {song.name} · {fmtClock(songPos)}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Timeline: step bands as actually crossed, commands, landings, then pace and
// HR as separate strips on the shared time axis (never a dual axis).

const W = 1000
const X0 = 8
const XW = W - 16

function stepFill(kind: WorkoutStep['kind']): string {
  if (kind === 'hard') return 'rgba(217, 89, 38, 0.35)'
  if (kind === 'easy' || kind === 'rest') return 'rgba(139, 148, 158, 0.12)'
  return 'rgba(139, 148, 158, 0.05)' // warmup / cooldown
}

function Timeline({
  result,
  playheadMs,
  truth,
}: {
  result: SimResult
  playheadMs: number | null
  truth: { tMs: number; stepIdx: number; end?: boolean }[] | null
}) {
  const [hover, setHover] = useState<TracePoint | null>(null)
  const { trace, durationMs } = result
  const hasHr = trace.some((p) => p.hr != null)
  const hasPace = trace.some((p) => p.distanceM != null)
  const hasAlt = trace.some((p) => p.altitude != null)

  // Strips stack below the command lane: pace, HR, altitude — each 60 tall + 10 gap.
  let lane = 102
  const paceTop = lane
  if (hasPace) lane += 70
  const hrTop = lane
  if (hasHr) lane += 70
  const altTop = lane
  if (hasAlt) lane += 70
  const axisY = (lane > 102 ? lane - 10 : 92) + 22
  const H = axisY + 6

  const x = (t: number) => X0 + (t / durationMs) * XW

  // Time ticks: the smallest step that keeps ≤ ~10 labels.
  const tickStepS = [30, 60, 120, 300, 600, 1200].find((s) => durationMs / (s * 1000) <= 10) ?? 1800
  const ticks: number[] = []
  for (let t = tickStepS * 1000; t < durationMs; t += tickStepS * 1000) ticks.push(t)

  // Everything except the crosshair/playhead depends only on the result —
  // build it once per simulation so mousemove renders diff two lines, not
  // hundreds of SVG nodes.
  const layers = useMemo(() => {
    const paces = trace.map((p) => p.paceSecPerKm)
    const [pLo, pHi] = pad(Math.min(...paces), Math.max(...paces))
    const yPace = (v: number) => paceTop + ((v - pLo) / (pHi - pLo)) * 60 // faster = up
    const hrs = trace.filter((p) => p.hr != null).map((p) => p.hr!)
    const [hLo, hHi] = hasHr ? pad(Math.min(...hrs), Math.max(...hrs)) : [0, 1]
    const yHr = (v: number) => hrTop + ((hHi - v) / (hHi - hLo)) * 60 // higher = up

    const pacePath = hasPace ? linePath(trace.map((p) => [x(p.tMs), yPace(p.paceSecPerKm)])) : ''
    const hrPath = hasHr ? linePath(trace.filter((p) => p.hr != null).map((p) => [x(p.tMs), yHr(p.hr!)])) : ''
    const alts = trace.filter((p) => p.altitude != null).map((p) => p.altitude!)
    const [aLo, aHi] = hasAlt ? pad(Math.min(...alts), Math.max(...alts)) : [0, 1]
    const yAlt = (v: number) => altTop + ((aHi - v) / (aHi - aLo)) * 60 // higher = up
    const altPath = hasAlt ? linePath(trace.filter((p) => p.altitude != null).map((p) => [x(p.tMs), yAlt(p.altitude!)])) : ''

    return (
      <>
        {/* step bands — boundaries as the runner actually crossed them */}
        {result.stepSpans.map((s, i) => {
          const w = x(s.endMs) - x(s.startMs)
          return (
            <g key={i}>
              <rect x={x(s.startMs)} y={6} width={Math.max(0, w - 1)} height={28} rx={3} fill={stepFill(s.step.kind)} />
              {w > 46 && (
                <text x={x(s.startMs) + w / 2} y={24} textAnchor="middle" fontSize={11} fill={s.step.kind === 'hard' ? '#e6edf3' : '#8b949e'}>
                  {s.step.kind}
                  {s.step.meters != null ? ` ${s.step.meters}m` : ''}
                </text>
              )}
            </g>
          )
        })}

        {/* ground truth: the watch's actual step boundaries (▾ above the bands) */}
        {truth?.filter((b) => !b.end && b.tMs > 0 && b.tMs < durationMs).map((b, i) => (
          <path key={`tb${i}`} d={`M${x(b.tMs) - 4},1 L${x(b.tMs) + 4},1 L${x(b.tMs)},7 Z`} fill="#e6edf3" opacity={0.8}>
            <title>{`true step ${b.stepIdx + 1} start — ${fmtClock(b.tMs)}`}</title>
          </path>
        ))}

        {/* landings: where each drop actually hit vs. the hard-step start */}
        {result.landings.map((l, i) => (
          <g key={i}>
            <circle cx={x(l.actualTMs)} cy={48} r={5} fill={landingColor(l.errorMs)} />
            <text x={x(l.actualTMs)} y={44} textAnchor="middle" fontSize={11} fill={landingColor(l.errorMs)}>
              {l.errorMs >= 0 ? '+' : '−'}{(Math.abs(l.errorMs) / 1000).toFixed(1)}s
            </text>
          </g>
        ))}

        {/* command ticks (crest rewards get their mountain) */}
        {result.commands.map((c, i) => (
          <g key={i}>
            <line x1={x(c.tMs)} y1={60} x2={x(c.tMs)} y2={90} stroke={cmdColor(c.reason)} strokeWidth={2}>
              <title>{`${fmtClock(c.tMs)} — ${c.reason} @ ${fmtClock(c.positionMs)}`}</title>
            </line>
            {c.reason.includes('crest reward') && (
              <text x={x(c.tMs)} y={58} textAnchor="middle" fontSize={11}>⛰</text>
            )}
          </g>
        ))}

        {/* pace strip (engine's EMA — what decisions were made from) */}
        {hasPace && (
          <g>
            <line x1={X0} y1={paceTop} x2={X0 + XW} y2={paceTop} stroke="#21262d" />
            <line x1={X0} y1={paceTop + 60} x2={X0 + XW} y2={paceTop + 60} stroke="#21262d" />
            <path d={pacePath} fill="none" stroke="#3987e5" strokeWidth={2} />
            <text x={X0 + 2} y={paceTop + 10} fontSize={10} fill="#8b949e">{fmtPace(pLo)} — engine pace</text>
            <text x={X0 + 2} y={paceTop + 57} fontSize={10} fill="#8b949e">{fmtPace(pHi)}</text>
          </g>
        )}

        {/* HR strip */}
        {hasHr && (
          <g>
            <line x1={X0} y1={hrTop} x2={X0 + XW} y2={hrTop} stroke="#21262d" />
            <line x1={X0} y1={hrTop + 60} x2={X0 + XW} y2={hrTop + 60} stroke="#21262d" />
            <path d={hrPath} fill="none" stroke="#e66767" strokeWidth={2} />
            <text x={X0 + 2} y={hrTop + 10} fontSize={10} fill="#8b949e">{Math.round(hHi)} bpm</text>
            <text x={X0 + 2} y={hrTop + 57} fontSize={10} fill="#8b949e">{Math.round(hLo)}</text>
          </g>
        )}

        {/* altitude strip */}
        {hasAlt && (
          <g>
            <line x1={X0} y1={altTop} x2={X0 + XW} y2={altTop} stroke="#21262d" />
            <line x1={X0} y1={altTop + 60} x2={X0 + XW} y2={altTop + 60} stroke="#21262d" />
            <path d={altPath} fill="none" stroke="#8b949e" strokeWidth={2} />
            <text x={X0 + 2} y={altTop + 10} fontSize={10} fill="#8b949e">{Math.round(aHi)}m — elevation</text>
            <text x={X0 + 2} y={altTop + 57} fontSize={10} fill="#8b949e">{Math.round(aLo)}m</text>
          </g>
        )}

        {/* time axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} y1={6} x2={x(t)} y2={axisY - 16} stroke="#21262d" strokeDasharray="2 4" />
            <text x={x(t)} y={axisY - 2} textAnchor="middle" fontSize={10} fill="#8b949e">{fmtClock(t)}</text>
          </g>
        ))}
      </>
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, truth])

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const t = ((e.clientX - rect.left) / rect.width) * durationMs
    const idx = Math.max(0, Math.min(trace.length - 1, Math.round(t / 1000) - 1))
    setHover(trace[idx])
  }

  return (
    <>
      <div className="muted" style={{ minHeight: 20, fontSize: 13 }}>
        {hover
          ? `${fmtClock(hover.tMs)} · ${hover.distanceM != null ? `${(hover.distanceM / 1000).toFixed(2)}km · ` : ''}` +
            `engine pace ${fmtPace(hover.paceSecPerKm)}${hover.hr != null ? ` · ${hover.hr} bpm z${hover.hrZone}` : ''}` +
            `${hover.altitude != null ? ` · ${hover.gradePct >= 0 ? '+' : ''}${hover.gradePct.toFixed(1)}%${hover.climbing ? ' ⛰ climbing' : ''}` : ''} · ` +
            `${hover.mode ?? '—'}${hover.etaToHardMs != null ? ` · hard in ${Math.round(hover.etaToHardMs / 1000)}s` : ''}`
          : 'hover the timeline to inspect the engine’s mind at any moment'}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', display: 'block', background: '#171711', border: 0, borderRadius: 0 }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {layers}

        {/* hover crosshair + replay playhead */}
        {hover && <line x1={x(hover.tMs)} y1={6} x2={x(hover.tMs)} y2={axisY - 16} stroke="#8b949e" strokeDasharray="3 3" />}
        {playheadMs != null && <line x1={x(playheadMs)} y1={6} x2={x(playheadMs)} y2={axisY - 16} stroke="#e6edf3" strokeWidth={1.5} />}
      </svg>
      <div className="muted" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginTop: 6 }}>
        <span><span style={{ color: '#3987e5' }}>▍</span> song change</span>
        <span><span style={{ color: '#9085e9' }}>▍</span> buildup</span>
        <span><span style={{ color: '#d55181' }}>▍</span> drop</span>
        <span><span style={{ color: '#199e70' }}>●</span> landing ≤2s</span>
        <span><span style={{ color: '#c98500' }}>●</span> ≤5s</span>
        <span><span style={{ color: '#e66767' }}>●</span> &gt;5s</span>
      </div>
    </>
  )
}

function pad(lo: number, hi: number): [number, number] {
  if (hi - lo < 1e-6) return [lo - 1, hi + 1]
  const p = (hi - lo) * 0.08
  return [lo - p, hi + p]
}

function linePath(pts: [number, number][]): string {
  return pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')
}
