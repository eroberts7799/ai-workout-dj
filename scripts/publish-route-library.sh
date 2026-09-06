#!/bin/bash
# Rebuild (optionally) and publish the personal route library to the PRIVATE
# (key-gated) relay path — the phone's route matcher reads it at app open.
#   scripts/publish-route-library.sh [takeout-fit-dir]
# Always: pull recent runs from Garmin, fold the phone's session logs,
# re-cluster, publish. A takeout FIT dir (one-time) is extracted first.
# fitdecode lives in a scratch venv (the analysis venv is fragile).
set -euo pipefail
cd "$(dirname "$0")/.."
VENV="${TMPDIR:-/tmp}/awdj-fitenv"
[ -x "$VENV/bin/python" ] || { python3 -m venv "$VENV" && "$VENV/bin/pip" install -q fitdecode; }
# The library grows by itself: recent Garmin runs (API) + the phone's own
# session logs (relay), then re-cluster everything in data/routes/history.
uv run --project ~/health-tracker python scripts/pull_recent_fits.py 2>&1 | tail -1 || true
python3 scripts/fold_session_routes.py 2>&1 | tail -1 || true
"$VENV/bin/python" scripts/build_route_library.py data/routes/fits-recent ${1:+"$1"}
[ -s data/routes/library.json ] || { echo "no data/routes/library.json — pass the FIT dir"; exit 1; }
export $(grep BLOB_READ_WRITE_TOKEN relay/.env.local | tr -d '"')
OUT=$(cd relay && vercel blob put ../data/routes/library.json \
  --pathname routes/library.json --content-type application/json \
  --add-random-suffix true --access public 2>&1)
URL=$(echo "$OUT" | tr ' ' '\n' | grep '^https://' | head -1)
[ -n "$URL" ] || { echo "FAILED: $OUT"; exit 1; }
echo "route library published (served via /api/routes?k=KEY): $URL"
