// The enrichment tag table's stable address. The blob CLI insists on
// random suffixes, so clients point HERE and this proxies the newest
// published table. Public by design: song titles and musical facts
// (bpm/key/energy) — no audio, no personal data, no key required.

import { list } from '@vercel/blob'

export async function GET() {
  const { blobs } = await list({ prefix: 'enrichment/track-tags', limit: 100 })
  if (blobs.length === 0) {
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  const newest = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0]
  const res = await fetch(newest.url)
  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // Callers refresh at app-open; an hour of edge cache is plenty fresh.
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
