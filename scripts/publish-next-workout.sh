#!/bin/bash
# Pull the next planned workout from Garmin and publish it to the PRIVATE
# (key-gated) relay path — the phone's "Today's workout" button reads it.
# Run the evening before (or morning of) a structured run.
set -euo pipefail
cd "$(dirname "$0")/.."
uv run --project ~/health-tracker python scripts/pull_next_workout.py > data/next-workout.json
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../data/next-workout.json \
  --pathname workout/next.json --content-type application/json \
  --add-random-suffix true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "FAILED: $OUT"; exit 1; }
echo "workout published (served via /api/next-workout?k=KEY): $URL"
# The route library rides on the same 05:00 job: it grows from the runs
# the phone logged (lat/lon since build 38) and recent Garmin activity.
"$(dirname "$0")/publish-route-library.sh 2>&1 | tail -1 || true
# Today's coaching script rides on the same job (after the workout).
"$(dirname "$0")/publish-coach-script.sh 2>&1 | tail -1 || true
