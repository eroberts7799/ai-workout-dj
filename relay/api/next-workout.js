// The next planned workout, engine-shaped — PRIVATE (key-gated): training
// plans are personal data. Published from the Mac (scripts/publish-next-
// workout.sh) after a Garmin calendar pull; the phone loads it so a
// structured run carries full step IDENTITY (hard vs float) that the watch
// stream can't express — Runna authors floats as plain "interval" steps,
// indistinguishable from the efforts without the target speeds.

import { list } from '@vercel/blob'

const KEY = 'awdj-7g2k9x'

export async function GET(request) {
  if (new URL(request.url).searchParams.get('k') !== KEY) {
    return new Response(null, { status: 404 })
  }
  const { blobs } = await list({ prefix: 'workout/next', limit: 50 })
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
      // Workouts change daily and get re-published after edits — stay fresh.
      'Cache-Control': 'public, max-age=60',
    },
  })
}
