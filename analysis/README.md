# Song analysis pipeline

The AI listens to your training songs and tags them automatically — tempo, beats,
downbeats, and section boundaries mapped to the app's marker vocabulary (drop,
buildup, loop bounds). Human audition in the tagger UI stays the final QA, because
"drop" is a vibe, not a label.

## Why files, not Spotify

Spotify's stream is DRM'd; no analyzer can legally listen to it, and Spotify's own
audio-analysis API is dead for new apps. So: buy the songs you train to (iTunes,
Bandcamp — ~$1.29 each), analyze the files here, and the app matches results onto
Spotify track IDs by search. A purchased master can start a few hundred ms off from
Spotify's stream — audition each marker (▶ −2s) and nudge once per track.

## Setup (one time)

```bash
brew install python@3.12 ffmpeg   # if missing
./setup.sh                        # venv + PyTorch + allin1
```

## Use

```bash
.venv/bin/python analyze.py ~/Music/song1.m4a ~/Music/song2.mp3 --out analysis-tags.json
```

Then in the web app: Song Tagger tab → **Import analysis JSON (auto-tagged)**.
Each song is matched via Spotify search; a ⚠ means the matched track's duration
differs from your file — probably a different version, audition before trusting.

## Marker heuristics

- **drop** — start of each chorus run (chorus onset ≈ the drop in workout music)
- **buildup** — start of the section immediately before a drop
- **loop ⟨ ⟩** — longest steady verse/inst/bridge section ≥ 15s
- everything snaps to detected downbeats (better than human tapping)
