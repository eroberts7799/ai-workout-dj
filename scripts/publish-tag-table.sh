#!/bin/bash
# Publish the enrichment tag table (normalized "artist|title" → bpm/camelot/
# energy) to a STABLE blob URL the apps refresh from at launch. Not
# sensitive (song names + musical facts, no audio, no personal data), so a
# fixed overwritable pathname is correct — publish, and every phone
# upgrades its picker on next open, no app update.
#
# Regenerate the table first when new analysis exists:
#   crate/virtual-crate → ios/Resources/track-tags.json (the generator
#   lives in git history; rerun after preview-tagging new playlists).
set -euo pipefail
cd "$(dirname "$0")/.."
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../ios/Resources/track-tags.json \
  --pathname enrichment/track-tags.json --content-type application/json \
  --add-random-suffix false --allow-overwrite true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "UPLOAD FAILED: $OUT"; exit 1; }
echo "tag table live: $URL"
