# Connect IQ Store submission — the runbook

The `.iq` is built (`AWDJ.iq`, both fr570 sizes). Submission is a browser
flow with Ethan's Garmin login — ~15 minutes.

## PRE-SUBMISSION CHECKLIST (do not skip)
- [ ] Build the .iq ONLY via ./build-store.sh — it swaps Ethan's crate
  default for the royalty-free DEMO crate (installers hear music in
  minute one; Ethan's purchased music never ships).

## Steps
1. https://apps.garmin.com → sign in (same Garmin account as the watch) →
   Developer Dashboard ("Upload an app" — first time asks you to accept
   the developer agreement).
2. Upload `garmin/awdj-watch/AWDJ.iq`.
3. Listing (draft below): category **Music**, type is auto-detected
   (audio content provider).
4. Icon: reuse the AWDJ app icon (1024px source in the iOS assets; the
   store wants ~500x500 PNG).
5. Submit for review. Typical turnaround: 1–3 business days. Once
   approved, the app installs and UPDATES over the air via Garmin
   Connect — the cable ritual is over.

## Draft listing

**Name:** AWDJ — AI Workout DJ

**Summary:** Music that reads your run. AWDJ picks every next song from
your live effort — heart rate, climbs, and your structured workout plan.

**Description:**
AWDJ is a music provider that acts like a DJ who can see your workout.
At every song change it reads your live heart rate, altitude, and — in a
structured workout — the current and upcoming steps, then picks the
track whose tempo and key fit the moment: faster songs when a hard
interval is on (or about to be), smoother selections when you recover.
No phone needed on the run.

Bring your own music: AWDJ syncs MP3s you host yourself (a simple
manifest URL set in Garmin Connect — see the project page for the
self-hosting guide). Your listening never touches anyone else's servers.

This is, to our knowledge, the first sensor-driven music selection app
on the Connect IQ platform.

**What it needs:** your own music files reachable over HTTP(S) via a
manifest (docs linked), wifi for the initial sync, a music-capable watch.

## Notes for review
- App type: audio content provider (same as the official MonkeyMusic
  sample architecture).
- Network use: user-configured manifest URL for music sync; small JSON
  POST of anonymous selection telemetry to the developer's endpoint.
- No accounts, no personal data collected.
