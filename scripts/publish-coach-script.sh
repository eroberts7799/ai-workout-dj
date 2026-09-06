#!/bin/bash
# Write today's coaching script (Claude, headless) and publish it to the
# PRIVATE relay path the phone reads at app open. Part of the 05:00 chain.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 scripts/coach_script.py
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../data/coach-script.json \
  --pathname coach/script.json --content-type application/json \
  --add-random-suffix true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "FAILED: $OUT"; exit 1; }
echo "coach script published (served via /api/coach-script?k=KEY): $URL"
