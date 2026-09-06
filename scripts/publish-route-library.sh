#!/bin/bash
# Rebuild (optionally) and publish the personal route library to the PRIVATE
# (key-gated) relay path — the phone's route matcher reads it at app open.
#   scripts/publish-route-library.sh [fit-dir]
# With a fit-dir (Garmin takeout FIT files), rebuilds data/routes/library.json
# first via a scratch venv carrying fitdecode (the analysis venv is fragile —
# never add deps to it). Without, publishes the existing library.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${1:-}" != "" ]; then
  VENV="${TMPDIR:-/tmp}/awdj-fitenv"
  [ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q fitdecode; }
  "$VENV/bin/python" scripts/build_route_library.py "$1"
fi
[ -s data/routes/library.json ] || { echo "no data/routes/library.json — pass the FIT dir"; exit 1; }
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../data/routes/library.json \
  --pathname routes/library.json --content-type application/json \
  --add-random-suffix true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "FAILED: $OUT"; exit 1; }
echo "route library published (served via /api/routes?k=KEY): $URL"
