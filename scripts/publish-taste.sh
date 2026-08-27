#!/bin/bash
# Publish the per-user taste bonus map to a PRIVATE (key-gated) relay path.
# It's derived from listening history — never public, unlike the tag table.
set -euo pipefail
cd "$(dirname "$0")/.."
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../data/taste-bonus.json \
  --pathname taste/bonus.json --content-type application/json \
  --add-random-suffix true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "FAILED: $OUT"; exit 1; }
echo "taste bonus published (served via /api/taste?k=KEY): $URL"
