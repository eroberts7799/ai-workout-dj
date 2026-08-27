// Per-user taste bonus — PRIVATE (key-gated). Derived from Spotify listening
// history, so unlike the public tag table this requires the relay key. Proxies
// the newest published taste/bonus blob: { "artist|title" → bonus(-2..2) }.

import { list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'

export async function GET(request) {
  if (new URL(request.url).searchParams.get('k') !== KEY) {
    return new Response(null, { status: 404 })
  }
  const { blobs } = await list({ prefix: 'taste/bonus', limit: 50 })
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
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
