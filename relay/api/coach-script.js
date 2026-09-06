// Today's coaching script — PRIVATE (key-gated): lines a morning job wrote
// for THIS session (workout + recent runs + sleep), spoken by the phone's
// coach at the moments the engine picks. Published from the Mac
// (scripts/coach_script.py in the 05:00 chain). Newest blob wins; a
// script older than today is ignored by the phone (date field).

import { list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'

export async function GET(request) {
  if (new URL(request.url).searchParams.get('k') !== KEY) {
    return new Response(null, { status: 404 })
  }
  const { blobs } = await list({ prefix: 'coach/script', limit: 50 })
  if (blobs.length === 0) {
    return new Response(null, { status: 404 })
  }
  const newest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0]
  const res = await fetch(newest.url)
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    },
  })
}
