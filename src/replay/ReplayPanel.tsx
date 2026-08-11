// Replay Lab — LIVE mode's test bench. Simulate a runner (or replay a recorded
// session log) through the LiveEngine and see every decision it would make:
// step boundaries as actually crossed, every cut, where each drop lands.
// Optionally hear it through the local deck at accelerated speed.
import { useMemo, useRef, useState } from 'react'
import { LocalDeck } from '../audio/local-deck'
import { loadAudio } from '../audio/local-store'
import type { SongTags, WorkoutPlan, WorkoutStep } from '../conductor/types'
import { beatAnchorMs } from '../conductor/beat'
import { parsePlan } from '../conduct/plan-parse'
import { RELAY_BASE, RELAY_KEY } from '../conduct/ConductPanel'
import { loadAllTags } from '../tags/store'
import {
  loadSessionLog,
  simulate,
  syntheticSamples,
  type LoadedLog,
  type SimResult,
  type TracePoint,
} from './simulate'

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

  // Audible replay machinery.
  const deckRef = useRef<LocalDeck | null>(null)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [replayMs, setReplayMs] = useState<number | null>(null)
  const [speed, setSpeed] = useState(8)

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

  function runSim() {
    stopReplay()
    const samples = loaded
      ? loaded.samples
      : syntheticSamples(activePlan, {
          easyPaceSecPerKm: easy!,
          hardPaceSecPerKm: hard!,
          fatiguePct,
          noisePct,
          hilly,
          withHr,
        })
    if (samples.length === 0) {
      setStatus('no samples to replay')
      return
    }
    setResult(simulate(activePlan, engineSongs, samples))
    setStatus('')
  }

  function acceptLog(json: unknown, origin: string) {
    const log = loadSessionLog(json)
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
    try {
      acceptLog(JSON.parse(await file.text()), 'that log')
    } catch (e) {
      setStatus(`could not read log: ${String(e)}`)
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
      acceptLog(await r.json(), 'that cloud session')
    } catch (e) {
      setStatus(`cloud fetch failed: ${String(e)}`)
    }
  }

  /** Schedule every command through the local deck at ×speed. */
  async function startReplay() {
    if (!result) return
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
      setStatus('audible replay needs songs with attached audio files (Tagger → attach file) — the timeline above is still the full story')
      return
    }
    const skipped = result.commands.filter((c) => !deck.has(c.trackId)).length
    setStatus(skipped > 0 ? `${skipped} command(s) hit songs without audio — silent gaps` : '')
    for (const c of result.commands) {
      timersRef.current.push(
        setTimeout(() => {
          if (deck.has(c.trackId))
            deck.play(c.trackId, c.positionMs, Math.max(0.12, c.fadeSec / speed), {
              onBeat: speed === 1 && !c.reason.startsWith('drop lands'), // beat waits only make sense in real time
            })
        }, c.tMs / speed),
      )
    }
    setReplayMs(0)
    const startedAt = performance.now()
    tickerRef.current = setInterval(() => {
      const ms = (performance.now() - startedAt) * speed
      if (ms >= result.durationMs) stopReplay()
      else setReplayMs(ms)
    }, 100)
  }

  function stopReplay() {
    for (const t of timersRef.current) clearTimeout(t)
    timersRef.current = []
    if (tickerRef.current) clearInterval(tickerRef.current)
    tickerRef.current = null
    deckRef.current?.stop()
    setReplayMs(null)
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
          style={{ width: '100%', boxSizing: 'border-box', background: '#161b22', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 6, padding: 8, font: 'inherit' }}
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
          <button onClick={runSim} disabled={!loaded && (errors.length > 0 || paceErrors.length > 0)}>
            {loaded ? 'Replay recorded session' : 'Simulate run'}
          </button>
          <label className="muted" style={{ cursor: 'pointer' }}>
            📄 Load session log…
            <input
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void onLogFile(f)
                e.target.value = ''
              }}
            />
          </label>
          <button onClick={() => void loadCloudList()}>☁️ Cloud sessions</button>
          {loaded && (
            <button onClick={() => { setLoaded(null); setResult(null); setStatus('') }}>✕ back to simulated runner</button>
          )}
        </div>
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

      {result && (
        <>
          <div className="card">
            <h2 style={{ marginTop: 0 }}>
              What the engine would do{' '}
              <span className="muted" style={{ fontWeight: 'normal', fontSize: 14 }}>
                {result.landings.length} landing(s)
                {worst != null && <> · worst {(worst / 1000).toFixed(1)}s off</>} ·{' '}
                {result.commands.filter((c) => c.reason.startsWith('loop back')).length} loop-backs ·{' '}
                {fmtClock(result.durationMs)} total
              </span>
            </h2>
            {result.warnings.map((w) => (
              <p key={w} className="warn">{w}</p>
            ))}
            <Timeline result={result} playheadMs={replayMs} />
            <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
              {replayMs == null ? (
                <button onClick={() => void startReplay()}>🎧 Audible replay</button>
              ) : (
                <button onClick={stopReplay}>⏹ Stop ({fmtClock(replayMs)})</button>
              )}
              <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: 'auto' }} disabled={replayMs != null}>
                {[1, 2, 4, 8, 16].map((x) => (
                  <option key={x} value={x}>×{x}</option>
                ))}
              </select>
            </div>
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

function Timeline({ result, playheadMs }: { result: SimResult; playheadMs: number | null }) {
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
  }, [result])

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
        style={{ width: '100%', display: 'block', background: '#0d1117', border: '1px solid #30363d', borderRadius: 6 }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {layers}

        {/* hover crosshair + replay playhead */}
        {hover && <line x1={x(hover.tMs)} y1={6} x2={x(hover.tMs)} y2={axisY - 16} stroke="#8b949e" strokeDasharray="3 3" />}
        {playheadMs != null && <line x1={x(playheadMs)} y1={6} x2={x(playheadMs)} y2={axisY - 16} stroke="#e6edf3" strokeWidth={1.5} />}
      </svg>
      <div className="muted" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, marginTop: 6 }}>
        <span><span style={{ color: '#3987e5' }}>▍</span> groove fill</span>
        <span><span style={{ color: '#199e70' }}>▍</span> loop back</span>
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
