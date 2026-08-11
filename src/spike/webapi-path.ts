// Web API path: remote-control a real Spotify Connect device (e.g. the iPhone app).
// Position reads are stale by round-trip time; this path measures how much.
import { api } from '../auth/spotify-auth'
import { sleep } from './sdk-path'
import type { StalenessSample, Trial } from './types'

export interface ConnectDevice {
  id: string
  name: string
  type: string
  is_active: boolean
}

export async function listDevices(): Promise<ConnectDevice[]> {
  const res = await api('/me/player/devices')
  if (!res.ok) throw new Error(`devices: ${res.status}`)
  const json = (await res.json()) as { devices: ConnectDevice[] }
  return json.devices
}

/** A backgrounded phone app drops off the device list; transfer re-activates it. */
export async function transferTo(deviceId: string): Promise<void> {
  const res = await api('/me/player', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_ids: [deviceId], play: true }),
  })
  if (!res.ok && res.status !== 204) throw new Error(`transfer: ${res.status}`)
}

export async function pausePlayback(deviceId: string): Promise<void> {
  await api(`/me/player/pause?device_id=${encodeURIComponent(deviceId)}`, { method: 'PUT' })
}

export async function playTrack(deviceId: string, trackUri: string, positionMs = 20_000): Promise<void> {
  const res = await api(`/me/player/play?device_id=${encodeURIComponent(deviceId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris: [trackUri], position_ms: positionMs }),
  })
  if (!res.ok && res.status !== 204) throw new Error(`play: ${res.status} ${await res.text()}`)
}

interface PlayerState {
  progress_ms: number
  item: { duration_ms: number } | null
  is_playing: boolean
}

async function readRemoteState(on429: () => void): Promise<PlayerState | null> {
  const res = await api('/me/player', {}, on429)
  if (res.status === 204) return null
  if (!res.ok) return null
  return (await res.json()) as PlayerState
}

export async function runWebApiTrial(deviceId: string, index: number): Promise<Trial> {
  let rateLimited = false
  const on429 = () => {
    rateLimited = true
  }

  const before = await readRemoteState(on429)
  if (!before || !before.item) {
    return { path: 'webapi', index, targetMs: 0, issuedAt: performance.now(), latencyMs: null, landedErrorMs: null, rateLimited, error: 'no remote playback state' }
  }
  const duration = before.item.duration_ms
  let targetMs = 0
  for (let i = 0; i < 20; i++) {
    targetMs = 20_000 + Math.random() * Math.max(1, duration - 40_000)
    if (Math.abs(targetMs - before.progress_ms) > 8_000) break
  }
  targetMs = Math.round(targetMs)

  const issuedAt = performance.now()
  const seekRes = await api(
    `/me/player/seek?position_ms=${targetMs}&device_id=${encodeURIComponent(deviceId)}`,
    { method: 'PUT' },
    on429,
  )
  if (!seekRes.ok && seekRes.status !== 204) {
    return { path: 'webapi', index, targetMs, issuedAt, latencyMs: null, landedErrorMs: null, rateLimited, error: `seek: ${seekRes.status}` }
  }

  const timeoutMs = 8_000
  for (;;) {
    const elapsed = performance.now() - issuedAt
    if (elapsed > timeoutMs) {
      return { path: 'webapi', index, targetMs, issuedAt, latencyMs: null, landedErrorMs: null, rateLimited, error: 'timeout' }
    }
    const state = await readRemoteState(on429)
    if (state) {
      const naturalPos = before.progress_ms + elapsed
      const jumped = Math.abs(state.progress_ms - naturalPos) > 4_000
      const nearTarget = state.progress_ms >= targetMs - 1_500 && state.progress_ms <= targetMs + 10_000
      if (jumped && nearTarget) {
        const now = performance.now() - issuedAt
        return {
          path: 'webapi',
          index,
          targetMs,
          issuedAt,
          latencyMs: now,
          landedErrorMs: state.progress_ms - now - targetMs,
          rateLimited,
        }
      }
    }
    // 250ms poll: fast enough to bound detection error, slow enough to respect rate limits.
    await sleep(250)
  }
}

export async function sampleWebApiStaleness(samples: number): Promise<StalenessSample[]> {
  const out: StalenessSample[] = []
  const noop = () => {}
  for (let i = 0; i < samples; i++) {
    const a = await readRemoteState(noop)
    const tA = performance.now()
    await sleep(1_000)
    const b = await readRemoteState(noop)
    const tB = performance.now()
    if (a && b) {
      const reported = b.progress_ms - a.progress_ms
      const wall = tB - tA
      out.push({ path: 'webapi', reportedDeltaMs: reported, wallDeltaMs: wall, driftMs: reported - wall })
    }
  }
  return out
}
