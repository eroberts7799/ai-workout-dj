import { useEffect, useRef, useState } from 'react'
import {
  beginLogin,
  getAccessToken,
  getClientId,
  handleCallback,
  isLoggedIn,
  logout,
  setClientId,
} from './auth/spotify-auth'
import { createSdkPlayer, runSdkTrial, sampleSdkStaleness, sleep } from './spike/sdk-path'
import {
  listDevices,
  playTrack,
  runWebApiTrial,
  sampleWebApiStaleness,
  transferTo,
  type ConnectDevice,
} from './spike/webapi-path'
import { summarize, verdict } from './spike/stats'
import type { SpikeSummary, StalenessSample, Trial } from './spike/types'

// Default test track: The Killers — Mr. Brightside (any Premium-playable track works).
const DEFAULT_TRACK = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp'
const TRIALS = 50
const STALENESS_SAMPLES = 5

type SdkHandle = Awaited<ReturnType<typeof createSdkPlayer>>

export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn())
  const [clientId, setClientIdState] = useState(getClientId() ?? '')
  const [authError, setAuthError] = useState<string | null>(null)

  useEffect(() => {
    if (window.location.pathname === '/callback') {
      handleCallback()
        .then((ok) => setAuthed(ok || isLoggedIn()))
        .catch((e) => setAuthError(String(e)))
    }
  }, [])

  return (
    <div>
      <h1>AI Workout DJ — hour-one latency spike</h1>
      <p className="muted">
        Decision gate from the design doc: p95 under 300ms → boundary cuts feel intentional, build on.
        Over 2s → design buffer strategies first.
      </p>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>1 · Spotify app credentials</h2>
        <p className="muted">
          developer.spotify.com/dashboard → Create app → redirect URI <code>http://127.0.0.1:5173/callback</code>,
          enable Web API + Web Playback SDK → paste the Client ID here.
        </p>
        <input
          placeholder="Spotify Client ID"
          value={clientId}
          onChange={(e) => setClientIdState(e.target.value)}
          onBlur={() => clientId.trim() && setClientId(clientId)}
        />
        <div style={{ marginTop: 10 }}>
          {authed ? (
            <>
              <span className="ok">Logged in ✓</span>{' '}
              <button onClick={() => { logout(); setAuthed(false) }}>Log out</button>
            </>
          ) : (
            <button
              disabled={!clientId.trim()}
              onClick={() => { setClientId(clientId); beginLogin().catch((e) => setAuthError(String(e))) }}
            >
              Log in with Spotify
            </button>
          )}
        </div>
        {authError && <p className="bad">{authError}</p>}
      </div>

      {authed && <SpikeRunner />}
    </div>
  )
}

function SpikeRunner() {
  const [trackUri, setTrackUri] = useState(DEFAULT_TRACK)
  const [trials, setTrials] = useState<Trial[]>([])
  const [staleness, setStaleness] = useState<StalenessSample[]>([])
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [devices, setDevices] = useState<ConnectDevice[]>([])
  const [deviceId, setDeviceId] = useState('')
  const sdkRef = useRef<SdkHandle | null>(null)
  const [sdkReady, setSdkReady] = useState(false)

  async function connectSdk() {
    setStatus('Connecting Web Playback SDK player…')
    try {
      sdkRef.current = await createSdkPlayer(getAccessToken)
      setSdkReady(true)
      setStatus(`SDK device ready (${sdkRef.current.deviceId.slice(0, 8)}…)`)
    } catch (e) {
      setStatus(`SDK connect failed: ${String(e)}`)
    }
  }

  async function runSdkSpike() {
    const sdk = sdkRef.current
    if (!sdk) return
    setRunning(true)
    try {
      setStatus('Starting test track on SDK device…')
      await playTrack(sdk.deviceId, trackUri)
      await sleep(2_000)
      for (let i = 0; i < TRIALS; i++) {
        const t = await runSdkTrial(sdk.player, i)
        setTrials((prev) => [...prev, t])
        setStatus(`SDK trial ${i + 1}/${TRIALS} — latency ${t.latencyMs?.toFixed(0) ?? 'fail'}ms`)
        await sleep(400)
      }
      setStatus('Sampling SDK position staleness…')
      const sdkSamples = await sampleSdkStaleness(sdk.player, STALENESS_SAMPLES)
      setStaleness((prev) => [...prev, ...sdkSamples])
      setStatus('SDK path done.')
    } catch (e) {
      setStatus(`SDK spike failed: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  async function refreshDevices() {
    try {
      const d = await listDevices()
      setDevices(d)
      const phone = d.find((x) => x.type === 'Smartphone') ?? d.find((x) => !x.name.includes('spike'))
      if (phone && !deviceId) setDeviceId(phone.id)
      setStatus(d.length ? `${d.length} device(s) found` : 'No devices — open Spotify on your phone and play/pause once')
    } catch (e) {
      setStatus(`device list failed: ${String(e)}`)
    }
  }

  async function runWebApiSpike() {
    if (!deviceId) return
    setRunning(true)
    try {
      setStatus('Transferring playback to target device…')
      await transferTo(deviceId)
      await sleep(1_500)
      await playTrack(deviceId, trackUri)
      await sleep(2_000)
      for (let i = 0; i < TRIALS; i++) {
        const t = await runWebApiTrial(deviceId, i)
        setTrials((prev) => [...prev, t])
        setStatus(`Web API trial ${i + 1}/${TRIALS} — latency ${t.latencyMs?.toFixed(0) ?? 'fail'}ms${t.rateLimited ? ' (429!)' : ''}`)
        await sleep(400)
      }
      setStatus('Sampling remote position staleness…')
      const remoteSamples = await sampleWebApiStaleness(STALENESS_SAMPLES)
      setStaleness((prev) => [...prev, ...remoteSamples])
      setStatus('Web API path done.')
    } catch (e) {
      setStatus(`Web API spike failed: ${String(e)}`)
    } finally {
      setRunning(false)
    }
  }

  function downloadLog() {
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), trials, staleness }, null, 2)],
      { type: 'application/json' },
    )
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `spike-log-${Date.now()}.json`
    a.click()
  }

  const sdkSummary = summarize('sdk', trials, staleness)
  const webSummary = summarize('webapi', trials, staleness)

  return (
    <>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>2 · Test track</h2>
        <input value={trackUri} onChange={(e) => setTrackUri(e.target.value)} placeholder="spotify:track:…" />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>3 · SDK path (this browser is the speaker)</h2>
        {!sdkReady ? (
          <button onClick={connectSdk} disabled={running}>Connect SDK player</button>
        ) : (
          <button onClick={runSdkSpike} disabled={running}>Run {TRIALS} SDK trials</button>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>4 · Web API path (remote-control a device, e.g. your iPhone)</h2>
        <button onClick={refreshDevices} disabled={running}>Refresh devices</button>
        {devices.length > 0 && (
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} style={{ marginTop: 8 }}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.type}){d.is_active ? ' — active' : ''}
              </option>
            ))}
          </select>
        )}
        {deviceId && (
          <div style={{ marginTop: 8 }}>
            <button onClick={runWebApiSpike} disabled={running}>Run {TRIALS} Web API trials</button>
          </div>
        )}
      </div>

      <p>{status}</p>

      {(sdkSummary.trials > 0 || webSummary.trials > 0) && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Results</h2>
          <SummaryTable summaries={[sdkSummary, webSummary].filter((s) => s.trials > 0)} />
          <div style={{ marginTop: 12 }}>
            <button onClick={downloadLog}>Download JSON log</button>
            <button onClick={() => { setTrials([]); setStaleness([]) }} disabled={running}>Clear</button>
          </div>
        </div>
      )}
    </>
  )
}

function SummaryTable({ summaries }: { summaries: SpikeSummary[] }) {
  const fmt = (q: { median: number; p95: number } | null) =>
    q ? `${q.median.toFixed(0)} / ${q.p95.toFixed(0)}` : '—'
  return (
    <table>
      <thead>
        <tr>
          <th>path</th><th>trials</th><th>fail</th><th>429s</th>
          <th>latency med/p95 (ms)</th><th>|landed err| med/p95 (ms)</th>
          <th>|staleness| med/p95 (ms)</th><th>verdict</th>
        </tr>
      </thead>
      <tbody>
        {summaries.map((s) => {
          const v = verdict(s)
          const cls = v === 'green' ? 'ok' : v === 'red' ? 'bad' : 'warn'
          return (
            <tr key={s.path}>
              <td>{s.path}</td>
              <td>{s.trials}</td>
              <td>{s.failures}</td>
              <td className={s.rateLimited429s ? 'bad' : ''}>{s.rateLimited429s}</td>
              <td>{fmt(s.latency)}</td>
              <td>{fmt(s.landedErrorAbs)}</td>
              <td>{fmt(s.stalenessDriftAbs)}</td>
              <td className={`verdict ${cls}`}>{v.toUpperCase()}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
