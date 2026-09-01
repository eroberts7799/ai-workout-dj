#!/bin/bash
# Publish the watch crate to the cloud: audio + manifest onto Vercel Blob
# (the relay's store), so the watch syncs from ANY wifi with the Mac off.
# URLs get random suffixes (unguessable — Ethan's purchased music is never
# a guessable public path), and only the manifest knows them. Idempotent:
# re-publishing overwrites the manifest; audio re-uploads are skipped by
# a local URL cache (data/watch-crate-urls.json). The manifest is
# suffixed too — a fixed pathname would make the crate guessable from the
# store host; re-publish = new URL = re-paste the setting (rare).
#
# Usage: scripts/publish-watch-crate.sh [limit]   (default 15 tracks)
# Prints the manifest URL to paste into the watch app's Garmin Connect
# settings — one-time.
set -euo pipefail
cd "$(dirname "$0")/.."
LIMIT="${1:-15}"
# Crate selection: default = Ethan's purchased crate; CRATE=demo publishes
# the royalty-free demo library (Pixabay - redistributable) that the STORE
# build uses as its zero-config default.
if [ "${CRATE:-}" = "demo" ]; then
  MUSIC="analysis/demo-music"
  ANALYSIS="analysis/demo-analysis.json"
  KEYS="analysis/demo-keys.json"
  PREFIX="demo-crate"
  CACHE=data/demo-crate-urls.json
else
  MUSIC="${AWDJ_MUSIC_DIR:-$HOME/Downloads/awdj-music}"
  ANALYSIS="analysis/crate-analysis.json"
  KEYS="analysis/crate-keys.json"
  PREFIX="watch-crate"
  CACHE=data/watch-crate-urls.json
fi
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
[ -f "$CACHE" ] || echo '{}' > "$CACHE"

python3 - "$LIMIT" "$MUSIC" "$CACHE" "$ANALYSIS" "$KEYS" "$PREFIX" << 'EOF'
import json, subprocess, sys, urllib.parse
limit, music_dir, cache_path, analysis_path, keys_path, prefix = (
    int(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])
import os, re
music_dir = os.path.abspath(music_dir)
raw = json.load(open(analysis_path))
analysis = raw.get('analysis', raw) if isinstance(raw, dict) else raw
try:
    keys = json.load(open(keys_path))
except FileNotFoundError:
    keys = {}

def nk(e):
    # Mirrors the TS engine's normKey: words of "artists name".
    words = re.findall(r'[a-z0-9]+', f"{e.get('artist','')} {e.get('title') or e['sourceFile']}".lower())
    return ' '.join(words)

def display_title(e):
    t = e.get('title') or e['sourceFile']
    # Demo files are named like "house-chill-reel-570198" - humanize.
    t = re.sub(r'-\d{4,}$', '', t)
    return t.replace('-', ' ').title() if e.get('artist', '') == '' else t
cache = json.load(open(cache_path))
try:
    taste = json.load(open('data/taste-bonus.json'))
except FileNotFoundError:
    taste = {}
# The crate analyzer never emitted energy (that's the preview-tag
# pipeline's field) — fill from the cloud tag table, same source the
# phone's enrich() uses. Misses stay null (neutral, never punished).
try:
    import urllib.request
    tagtable = json.load(urllib.request.urlopen('https://awdj-relay.vercel.app/api/track-tags', timeout=15))
except Exception:
    tagtable = {}
def norm(x):
    import re as _re
    x = x.lower()
    x = _re.sub(r'\((?:extended|original|club|radio)[^)]*\)', '', x)
    x = _re.sub(r'\s*(?:feat|ft)\.?\s.*', '', x)
    x = _re.sub(r'[^a-z0-9]+', ' ', x)
    return x.strip()
tracks = []
picked = [e for e in analysis if e.get('bpm') and os.path.exists(os.path.join(music_dir, e['sourceFile']))][:limit]
for i, e in enumerate(picked):
    f = e['sourceFile']
    if f not in cache:
        print(f"  uploading {i+1}/{len(picked)}: {f}")
        out = subprocess.run(
            ['vercel', 'blob', 'put', os.path.join(music_dir, f),
             '--pathname', f'{prefix}/{f}', '--content-type', 'audio/mpeg', '--add-random-suffix', 'true', '--access', 'public'],
            capture_output=True, text=True, cwd='relay')
        url = next((w for w in (out.stdout + ' ' + out.stderr).split() if w.startswith('https://')), None)
        if not url:
            print(f"  UPLOAD FAILED: {out.stderr[:200]}"); sys.exit(1)
        cache[f] = url
        json.dump(cache, open(cache_path, 'w'), indent=1)
    else:
        print(f"  cached    {i+1}/{len(picked)}: {f}")
    # Parity law (2026-09-01): the watch Brain scores taste + energy like
    # the phone brains. Taste key mirrors SpotifyLibrary.enrich's norm form.
    title_n = norm(e.get('title') or e['sourceFile'])
    artist_full = norm(e.get('artist',''))
    artist_first = norm((e.get('artist','') or '').split(',')[0])
    # Full-artist key first; first-artist fallback for multi-artist DJ
    # edits ("Beam, Skin On Skin, Fred again.." vs the table's primary).
    def look(table):
        return table.get(f"{artist_full}|{title_n}") or table.get(f"{artist_first}|{title_n}")
    tag_hit = look(tagtable) or {}
    tracks.append({
        'url': cache[f],
        'title': display_title(e),
        'artist': e.get('artist', ''),
        'bpm': e['bpm'],
        'camelot': e.get('camelot') or keys.get(f, {}).get('camelot'),
        'durationMs': e.get('durationMs'),
        'nk': nk(e),
        'aff': look(taste),
        'energy': e.get('energy') if e.get('energy') is not None else tag_hit.get('energy'),
    })
# Learned pairs, filtered to THIS crate: what real DJs played adjacently
# among these exact tracks. Tiny by construction (watch Storage is 8KB/value).
try:
    weights = json.load(open('analysis/selection-weights.json'))
    all_pairs = weights.get('pairs', weights)
except FileNotFoundError:
    all_pairs = {}
nks = {t['nk'] for t in tracks}
pairs = {k: v for k, v in all_pairs.items()
         if '>' in k and k.split('>')[0] in nks and k.split('>')[1] in nks}
print(f"learned pairs shipped: {len(pairs)}")
manifest = {'tracks': tracks, 'pairs': pairs, 'logUrl': 'https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x'}
open('/tmp/awdj-watch-manifest.json', 'w').write(json.dumps(manifest))
out = subprocess.run(
    ['vercel', 'blob', 'put', '/tmp/awdj-watch-manifest.json',
     '--pathname', f'{prefix}/manifest.json', '--content-type', 'application/json',
     '--add-random-suffix', 'true', '--access', 'public'],
    capture_output=True, text=True, cwd='relay')
url = next((w for w in (out.stdout + ' ' + out.stderr).split() if w.startswith('https://')), None)
if not url:
    print(f"MANIFEST UPLOAD FAILED: {out.stderr[:300]}"); sys.exit(1)
print(f"\n{len(tracks)} tracks in the cloud crate")
print(f"MANIFEST URL (paste into the watch app's settings in Garmin Connect):\n{url}")
EOF
