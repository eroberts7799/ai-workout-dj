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
MUSIC="${AWDJ_MUSIC_DIR:-$HOME/Downloads/awdj-music}"
CACHE=data/watch-crate-urls.json
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
[ -f "$CACHE" ] || echo '{}' > "$CACHE"

python3 - "$LIMIT" "$MUSIC" "$CACHE" << 'EOF'
import json, subprocess, sys, urllib.parse
limit, music_dir, cache_path = int(sys.argv[1]), sys.argv[2], sys.argv[3]
import os
analysis = json.load(open('analysis/crate-analysis.json'))['analysis']
keys = json.load(open('analysis/crate-keys.json'))
cache = json.load(open(cache_path))
tracks = []
picked = [e for e in analysis if e.get('bpm') and os.path.exists(os.path.join(music_dir, e['sourceFile']))][:limit]
for i, e in enumerate(picked):
    f = e['sourceFile']
    if f not in cache:
        print(f"  uploading {i+1}/{len(picked)}: {f}")
        out = subprocess.run(
            ['vercel', 'blob', 'put', os.path.join(music_dir, f),
             '--pathname', f'watch-crate/{f}', '--content-type', 'audio/mpeg', '--add-random-suffix', 'true', '--access', 'public'],
            capture_output=True, text=True, cwd='relay')
        url = next((w for w in (out.stdout + ' ' + out.stderr).split() if w.startswith('https://')), None)
        if not url:
            print(f"  UPLOAD FAILED: {out.stderr[:200]}"); sys.exit(1)
        cache[f] = url
        json.dump(cache, open(cache_path, 'w'), indent=1)
    else:
        print(f"  cached    {i+1}/{len(picked)}: {f}")
    tracks.append({
        'url': cache[f],
        'title': e.get('title', f),
        'artist': e.get('artist', ''),
        'bpm': e['bpm'],
        'camelot': e.get('camelot') or keys.get(f, {}).get('camelot'),
        'durationMs': e.get('durationMs'),
    })
manifest = {'tracks': tracks, 'logUrl': 'https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x'}
open('/tmp/awdj-watch-manifest.json', 'w').write(json.dumps(manifest))
out = subprocess.run(
    ['vercel', 'blob', 'put', '/tmp/awdj-watch-manifest.json',
     '--pathname', 'watch-crate/manifest.json', '--content-type', 'application/json',
     '--add-random-suffix', 'true', '--access', 'public'],
    capture_output=True, text=True, cwd='relay')
url = next((w for w in (out.stdout + ' ' + out.stderr).split() if w.startswith('https://')), None)
if not url:
    print(f"MANIFEST UPLOAD FAILED: {out.stderr[:300]}"); sys.exit(1)
print(f"\n{len(tracks)} tracks in the cloud crate")
print(f"MANIFEST URL (paste into the watch app's settings in Garmin Connect):\n{url}")
EOF
