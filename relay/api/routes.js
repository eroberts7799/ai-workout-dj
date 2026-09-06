// The runner's personal route library — PRIVATE (key-gated): GPS tracks of
// his own past runs, the "your history is your route" matcher's input.
// Published from the Mac (scripts/publish-route-library.sh) from the Garmin
// takeout; the phone caches it for a day. Same trust model as the taste
// bonus: key-gated proxy over an unguessable blob. Own data only — friend
// data never carries positions (CLAUDE.md privacy floor).

import { list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'

export async function GET(request) {
  if (new URL(request.url).searchParams.get('k') !== KEY) {
    return new Response(null, { status: 404 })
  }
  const { blobs } = await list({ prefix: 'routes/library', limit: 50 })
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
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
