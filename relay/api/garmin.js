// Public HTTPS relay for the watch → conductor data path.
// Garmin Connect only delivers plain HTTP to local addresses, so the watch
// posts here (real HTTPS, permanent URL, works over LTE) and the conductor
// polls from wherever it runs.
//
// State is module-scope memory: at 1Hz, a cold start just means a ~1s gap
// before the next sample refills it. The `k` token is a light gate so the
// endpoint isn't readable/writable by random scanners.

const KEY = 'awdj-7g2k9x'

let latest = null

const CORS = { 'Access-Control-Allow-Origin': '*' }

function authorized(request) {
  return new URL(request.url).searchParams.get('k') === KEY
}

export async function POST(request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  const body = await request.json().catch(() => ({}))
  latest = { ...body, receivedAt: Date.now() }
  return new Response(null, { status: 204, headers: CORS })
}

export async function GET(request) {
  if (!authorized(request)) return new Response(null, { status: 404 })
  return new Response(JSON.stringify(latest), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}
