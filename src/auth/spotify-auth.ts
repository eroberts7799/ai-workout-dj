// Spotify Authorization Code + PKCE, no backend.
// Redirect URI must be loopback IP (127.0.0.1) — Spotify disallows plain-http localhost.

const TOKEN_KEY = 'awdj.tokens'
const VERIFIER_KEY = 'awdj.pkce_verifier'
const CLIENT_ID_KEY = 'awdj.client_id'

export const REDIRECT_URI = 'http://127.0.0.1:5173/callback'
export const SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-email',
  'user-read-private',
].join(' ')

interface StoredTokens {
  access_token: string
  refresh_token: string
  expires_at: number
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function getClientId(): string | null {
  return localStorage.getItem(CLIENT_ID_KEY)
}

export function setClientId(id: string): void {
  localStorage.setItem(CLIENT_ID_KEY, id.trim())
}

export async function beginLogin(): Promise<void> {
  const clientId = getClientId()
  if (!clientId) throw new Error('Set a Spotify Client ID first')
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(64)))
  localStorage.setItem(VERIFIER_KEY, verifier)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: b64url(new Uint8Array(digest)),
  })
  window.location.href = `https://accounts.spotify.com/authorize?${params}`
}

// React StrictMode double-invokes effects in dev; the auth code is single-use,
// so the exchange must run exactly once per callback load.
let callbackExchange: Promise<boolean> | null = null

export function handleCallback(): Promise<boolean> {
  callbackExchange ??= doHandleCallback()
  return callbackExchange
}

async function doHandleCallback(): Promise<boolean> {
  const search = new URLSearchParams(window.location.search)
  const code = search.get('code')
  if (!code) return false
  const verifier = localStorage.getItem(VERIFIER_KEY)
  const clientId = getClientId()
  if (!verifier || !clientId) return false
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`)
  storeTokenResponse(await res.json())
  localStorage.removeItem(VERIFIER_KEY)
  window.history.replaceState(null, '', '/')
  return true
}

function storeTokenResponse(json: { access_token: string; refresh_token?: string; expires_in: number }): void {
  const prev = readTokens()
  // Spotify may omit refresh_token on refresh responses — keep the existing one.
  const tokens: StoredTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? prev?.refresh_token ?? '',
    expires_at: Date.now() + json.expires_in * 1000,
  }
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens))
}

function readTokens(): StoredTokens | null {
  const raw = localStorage.getItem(TOKEN_KEY)
  return raw ? (JSON.parse(raw) as StoredTokens) : null
}

export function isLoggedIn(): boolean {
  return readTokens() !== null
}

export function logout(): void {
  localStorage.removeItem(TOKEN_KEY)
}

let refreshing: Promise<void> | null = null

/** Returns a valid access token, silently refreshing when <60s of life remain. */
export async function getAccessToken(): Promise<string> {
  const tokens = readTokens()
  if (!tokens) throw new Error('Not logged in')
  if (Date.now() < tokens.expires_at - 60_000) return tokens.access_token
  refreshing ??= refresh(tokens).finally(() => {
    refreshing = null
  })
  await refreshing
  const fresh = readTokens()
  if (!fresh) throw new Error('Token refresh lost tokens')
  return fresh.access_token
}

async function refresh(tokens: StoredTokens): Promise<void> {
  const clientId = getClientId()
  if (!clientId) throw new Error('Missing client ID')
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    }),
  })
  if (!res.ok) {
    logout()
    throw new Error(`Token refresh failed (${res.status}) — log in again`)
  }
  storeTokenResponse(await res.json())
}

/** Authenticated Web API fetch. Reports 429s so the spike can count them. */
export async function api(
  path: string,
  init: RequestInit = {},
  on429?: (retryAfterSec: number) => void,
): Promise<Response> {
  const token = await getAccessToken()
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  })
  if (res.status === 429) on429?.(Number(res.headers.get('Retry-After') ?? 0))
  return res
}
