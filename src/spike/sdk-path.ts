// Web Playback SDK path: an in-browser Spotify Connect device with a local,
// low-staleness position readout. Desktop browsers only.
import type { StalenessSample, Trial } from './types'

/* Minimal ambient typing for the SDK — enough for the spike + tagger. */
export type SdkPlayer = {
  connect(): Promise<boolean>
  addListener(event: string, cb: (payload: never) => void): void
  getCurrentState(): Promise<{ position: number; duration: number; paused: boolean } | null>
  seek(positionMs: number): Promise<void>
  togglePlay(): Promise<void>
  pause(): Promise<void>
  resume(): Promise<void>
}

export interface SdkHandle {
  player: SdkPlayer
  deviceId: string
}

let sdkLoading: Promise<void> | null = null

function loadSdkScript(): Promise<void> {
  sdkLoading ??= new Promise<void>((resolve) => {
    ;(window as unknown as { onSpotifyWebPlaybackSDKReady: () => void }).onSpotifyWebPlaybackSDKReady = resolve
    const s = document.createElement('script')
    s.src = 'https://sdk.scdn.co/spotify-player.js'
    document.head.appendChild(s)
  })
  return sdkLoading
}

export async function createSdkPlayer(getToken: () => Promise<string>): Promise<SdkHandle> {
  await loadSdkScript()
  const Spotify = (window as unknown as { Spotify: { Player: new (opts: object) => SdkPlayer } }).Spotify
  const player = new Spotify.Player({
    name: 'AI Workout DJ (spike)',
    getOAuthToken: (cb: (t: string) => void) => {
      void getToken().then(cb)
    },
    volume: 0.5,
  })
  const deviceId = await new Promise<string>((resolve, reject) => {
    player.addListener('ready', (p: never) => resolve((p as { device_id: string }).device_id))
    for (const ev of ['initialization_error', 'authentication_error', 'account_error']) {
      player.addListener(ev, (p: never) =>
        reject(new Error(`${ev}: ${(p as { message: string }).message}`)),
      )
    }
    void player.connect()
  })
  return { player, deviceId }
}

async function readPosition(player: SdkPlayer): Promise<{ position: number; duration: number } | null> {
  const s = await player.getCurrentState()
  return s ? { position: s.position, duration: s.duration } : null
}

/**
 * One seek trial: issue player.seek(target), poll position until a jump to the
 * target neighborhood is observed (a change not explainable by natural playback).
 */
export async function runSdkTrial(player: SdkPlayer, index: number): Promise<Trial> {
  const before = await readPosition(player)
  if (!before) return failTrial('sdk', index, 'no playback state — is the SDK device playing?')
  const duration = before.duration
  // Pick a target at least 8s away from the current playhead, inside [20s, duration-20s].
  let targetMs = 0
  for (let i = 0; i < 20; i++) {
    targetMs = 20_000 + Math.random() * Math.max(1, duration - 40_000)
    if (Math.abs(targetMs - before.position) > 8_000) break
  }
  targetMs = Math.round(targetMs)

  const issuedAt = performance.now()
  await player.seek(targetMs)

  const timeoutMs = 5_000
  for (;;) {
    const now = performance.now()
    const elapsed = now - issuedAt
    if (elapsed > timeoutMs) return { ...failTrial('sdk', index, 'timeout'), targetMs, issuedAt }
    const state = await readPosition(player)
    if (state) {
      const naturalPos = before.position + elapsed
      const jumped = Math.abs(state.position - naturalPos) > 4_000
      const nearTarget = state.position >= targetMs - 1_500 && state.position <= targetMs + 8_000
      if (jumped && nearTarget) {
        return {
          path: 'sdk',
          index,
          targetMs,
          issuedAt,
          latencyMs: elapsed,
          landedErrorMs: state.position - elapsed - targetMs,
          rateLimited: false,
        }
      }
    }
    await sleep(25)
  }
}

export async function sampleSdkStaleness(player: SdkPlayer, samples: number): Promise<StalenessSample[]> {
  const out: StalenessSample[] = []
  for (let i = 0; i < samples; i++) {
    const a = await readPosition(player)
    const tA = performance.now()
    await sleep(1_000)
    const b = await readPosition(player)
    const tB = performance.now()
    if (a && b) {
      const reported = b.position - a.position
      const wall = tB - tA
      out.push({ path: 'sdk', reportedDeltaMs: reported, wallDeltaMs: wall, driftMs: reported - wall })
    }
  }
  return out
}

function failTrial(path: 'sdk' | 'webapi', index: number, error: string): Trial {
  return { path, index, targetMs: 0, issuedAt: performance.now(), latencyMs: null, landedErrorMs: null, rateLimited: false, error }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
