// Strava auto-ingest — the watch's own recording flows into the archive
// with zero ritual. Garmin auto-syncs every activity to Strava; this
// endpoint (daily cron + manual trigger) refreshes the OAuth token, pulls
// any activity not yet archived, downloads its streams (HR, cadence,
// distance, altitude — the fields the Replay Lab and the HR-response
// scorer feed on), and writes it as an import log. Deterministic pathnames
// (strava-<activityId>) make the sync idempotent: re-running never
// duplicates. Replaces the connect.garmin.com → TCX → "Import TCX" ritual
// (first done by hand for the 2026-08-22 trail run).
//
// Env: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN,
// optionally CRON_SECRET (Vercel sends it as a Bearer token on cron hits).

import { put, list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'
const MAX_ACTIVITIES = 20 // per run; daily cron never falls behind on one athlete

function authorized(request) {
  if (new URL(request.url).searchParams.get('k') === KEY) return true
  const cron = process.env.CRON_SECRET
  return !!cron && request.headers.get('authorization') === `Bearer ${cron}`
}

async function accessToken() {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw new Error(`strava token refresh HTTP ${res.status}`)
  return (await res.json()).access_token
}

async function strava(token, path) {
  const res = await fetch(`https://www.strava.com/api/v3${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`strava ${path} HTTP ${res.status}`)
  return res.json()
}

export async function GET(request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  try {
    const token = await accessToken()
    const activities = await strava(token, `/athlete/activities?per_page=${MAX_ACTIVITIES}`)

    // Idempotence: an activity's blob pathname is deterministic; skip any id
    // already archived.
    const { blobs } = await list({ prefix: 'sessions/', limit: 1000 })
    const have = new Set()
    for (const b of blobs) {
      const m = b.pathname.match(/strava-(\d+)\.json$/)
      if (m) have.add(m[1])
    }

    const synced = []
    for (const a of activities) {
      const id = String(a.id)
      if (have.has(id)) continue
      let streams
      try {
        streams = await strava(
          token,
          `/activities/${id}/streams?keys=time,heartrate,distance,cadence,altitude&key_by_type=true`,
        )
      } catch {
        continue // no streams (manual entries etc.) — nothing to archive
      }
      const time = streams.time?.data
      if (!time || time.length < 60) continue // under a minute of data
      const hr = streams.heartrate?.data
      const dist = streams.distance?.data
      const cad = streams.cadence?.data
      const alt = streams.altitude?.data
      const samples = time.map((t, i) => ({
        tMs: t * 1000,
        ...(hr ? { hr: hr[i] } : {}),
        ...(dist ? { distanceM: dist[i] } : {}),
        ...(cad ? { cadence: cad[i] } : {}),
        ...(alt ? { altitude: alt[i] } : {}),
      }))
      const day = (a.start_date ?? new Date().toISOString()).slice(0, 10)
      const log = {
        name: `${a.name ?? a.sport_type ?? 'activity'} (Strava auto-sync)`,
        source: 'import-strava',
        sport: a.sport_type ?? a.type ?? null,
        stravaId: id,
        startDate: a.start_date ?? null,
        samples,
        commands: [],
        landings: [],
      }
      await put(`sessions/${day}-strava-${id}.json`, JSON.stringify(log), {
        access: 'public',
        allowOverwrite: true,
        contentType: 'application/json',
      })
      synced.push({ id, name: a.name, samples: samples.length, hr: !!hr })
    }
    return new Response(JSON.stringify({ ok: true, checked: activities.length, synced }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}
