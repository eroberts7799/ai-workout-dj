// Session-log archive — the data flywheel's intake.
// Every finished workout (web conductor or iPhone app, Ethan or a friend)
// POSTs its session log here; the Replay Lab lists and replays them from
// anywhere. Storage is Vercel Blob: public store, but every pathname gets a
// random suffix (unguessable URLs) and listing requires the key — the same
// trust model as the live relay itself.

import { put, list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'
const MAX_BYTES = 5 * 1024 * 1024

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function authorized(request) {
  return new URL(request.url).searchParams.get('k') === KEY
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export async function POST(request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const text = await request.text()
  if (text.length > MAX_BYTES) {
    return new Response(JSON.stringify({ error: 'log too large' }), { status: 413, headers: CORS })
  }
  let log
  try {
    log = JSON.parse(text)
  } catch {
    return new Response(JSON.stringify({ error: 'not JSON' }), { status: 400, headers: CORS })
  }
  const name = (log.plan?.name ?? log.name ?? 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
  const source = typeof log.source === 'string' ? log.source.slice(0, 12) : 'web'
  const day = new Date().toISOString().slice(0, 10)
  // In-flight checkpoints: a sessionId pins the pathname so periodic saves
  // overwrite instead of piling up — a closed tab can lose ≤2min, not a run.
  const sid = typeof log.sessionId === 'string' ? log.sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16) : null
  const blob = await put(
    `sessions/${day}-${source}-${name}${sid ? `-${sid}` : ''}.json`,
    text,
    sid
      ? { access: 'public', allowOverwrite: true, contentType: 'application/json' }
      : { access: 'public', addRandomSuffix: true, contentType: 'application/json' },
  )
  return new Response(JSON.stringify({ ok: true, pathname: blob.pathname }), {
    status: 201,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

export async function GET(request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const file = new URL(request.url).searchParams.get('file')

  if (file) {
    // Proxy one log's content (dodges blob-storage CORS for the browser).
    const { blobs } = await list({ prefix: file, limit: 1 })
    if (blobs.length === 0 || blobs[0].pathname !== file) {
      return new Response(null, { status: 404, headers: CORS })
    }
    const res = await fetch(blobs[0].url)
    return new Response(res.body, {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const { blobs } = await list({ prefix: 'sessions/', limit: 200 })
  const sessions = blobs
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .map((b) => ({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt }))
  return new Response(JSON.stringify(sessions), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
