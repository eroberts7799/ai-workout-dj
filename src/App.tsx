import { useEffect, useState } from 'react'
import {
  beginLogin,
  getAccessToken,
  getClientId,
  handleCallback,
  isLoggedIn,
  logout,
  setClientId,
} from './auth/spotify-auth'
import { createSdkPlayer, runSdkTrial, sampleSdkStaleness, sleep, type SdkHandle } from './spike/sdk-path'
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
import TagEditor from './tags/TagEditor'
import ConductPanel from './conduct/ConductPanel'

// Default test track: The Killers — Mr. Brightside (any Premium-playable track works).
const DEFAULT_TRACK = 'spotify:track:3n3Ppam7vgaVa1iaRUc9Lp'
const TRIALS = 50
const STALENESS_SAMPLES = 5

type Tab = 'tagger' | 'conduct' | 'spike'

export default function App() {
  const [authed, setAuthed] = useState(isLoggedIn())
  const [clientId, setClientIdState] = useState(getClientId() ?? '')
  const [authError, setAuthError] = useState<string | null>(null)
  const [sdk, setSdk] = useState<SdkHandle | null>(null)
  const [sdkStatus, setSdkStatus] = useState('')
  const [tab, setTab] = useState<Tab>('tagger')

  useEffect(() => {
    if (window.location.pathname === '/callback') {
      handleCallback()
        .then((ok) => setAuthed(ok || isLoggedIn()))
        .catch((e) => setAuthError(String(e)))
    }
  }, [])

  async function connectSdk() {
    setSdkStatus('Connecting Web Playback SDK player…')
    try {
      const handle = await createSdkPlayer(getAccessToken)
      setSdk(handle)
      setSdkStatus(`SDK device ready (${handle.deviceId.slice(0, 8)}…) — this browser is now a Spotify device`)
    } catch (e) {
      setSdkStatus(`SDK connect failed: ${String(e)}`)
    }
  }

  return (
    <div>
      <h1>AI Workout DJ</h1>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Spotify</h2>
        {!authed && (
          <>
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
          </>
        )}
        <div style={{ marginTop: 10 }}>
          {authed ? (
            <>
              <span className="ok">Logged in ✓</span>{' '}
              {!sdk ? (
                <button onClick={() => void connectSdk()}>Connect SDK player</button>
              ) : (
                <span className="ok">SDK player ready ✓</span>
              )}{' '}
              <button onClick={() => { logout(); setAuthed(false); setSdk(null) }}>Log out</button>
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
        {(authError || sdkStatus) && <p className={authError ? 'bad' : 'muted'}>{authError ?? sdkStatus}</p>}
      </div>

      {authed && (
        <>
          <div style={{ marginTop: 16 }}>
            <button onClick={() => setTab('tagger')} disabled={tab === 'tagger'}>Song Tagger</button>
            <button onClick={() => setTab('conduct')} disabled={tab === 'conduct'}>Conduct</button>
            <button onClick={() => setTab('spike')} disabled={tab === 'spike'}>Latency Spike</button>
          </div>
          {tab === 'tagger' &&
            (sdk ? <TagEditor sdk={sdk} /> : <p className="muted">Connect the SDK player above to start tagging.</p>)}
          {tab === 'conduct' &&
            (sdk ? <ConductPanel sdk={sdk} /> : <p className="muted">Connect the SDK player above to conduct a session.</p>)}
          {tab === 'spike' && <SpikeRunner sdk={sdk} />}
        </>
      )}
    </div>
  )
}

function SpikeRunner({ sdk }: { sdk: SdkHandle | null }) {
  const [trackUri, setTrackUri] = useState(DEFAULT_TRACK)
  const [trials, setTrials] = useState<Trial[]>([])
  const [staleness, setStaleness] = useState<StalenessSample[]>([])
  const [status, setStatus] = useState('')
  const [running, setRunning] = useState(false)
  const [devices, setDevices] = useState<ConnectDevice[]>([])
  const [deviceId, setDeviceId] = useState('')

  async function runSdkSpike() {
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
      <p className="muted" style={{ marginTop: 16 }}>
        Decision gate: p95 under 300ms → boundary cuts feel intentional. Over 2s → buffer strategies first.
      </p>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Test track</h2>
        <input value={trackUri} onChange={(e) => setTrackUri(e.target.value)} placeholder="spotify:track:…" />
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>SDK path (this browser is the speaker)</h2>
        <button onClick={() => void runSdkSpike()} disabled={running || !sdk}>
          {sdk ? `Run ${TRIALS} SDK trials` : 'Connect the SDK player first'}
        </button>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Web API path (remote-control a device, e.g. your iPhone)</h2>
        <button onClick={() => void refreshDevices()} disabled={running}>Refresh devices</button>
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
            <button onClick={() => void runWebApiSpike()} disabled={running}>Run {TRIALS} Web API trials</button>
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
