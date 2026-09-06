#!/usr/bin/env python3
"""Fold the phone's own session logs into the route history — the library
grows with every run (build 38+ logs carry lat/lon). Nightly with the
05:00 publish job.

Reads the relay session archive (key-gated), keeps iOS sessions with
positions and ≥2km, writes data/routes/history/<date>-ios-<id>.json in
the same shape the FIT extractor writes (downsampled every 20m, altitude
from the watch/barometer). Skips logs already folded.

Run: python3 scripts/fold_session_routes.py
"""

import json
import re
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HIST = REPO / "data" / "routes" / "history"
RELAY = "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x"
STEP_M = 20
MIN_KM = 2.0


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def main():
    HIST.mkdir(parents=True, exist_ok=True)
    sessions = fetch(RELAY)
    folded, seen = 0, 0
    for s in sessions:
        path = s["pathname"]
        m = re.match(r"sessions/(\d{4}-\d{2}-\d{2})-ios-(.*)\.json$", path)
        if not m or s.get("size", 0) < 20_000:
            continue
        sid = re.sub(r"[^a-zA-Z0-9]", "", m.group(2))[-20:]
        dest = HIST / f"{m.group(1)}-ios-{sid}.json"
        if dest.exists():
            seen += 1
            continue
        log = fetch(f"{RELAY}&file={path}")
        pts, last = [], -1e9
        for x in log.get("samples", []):
            lat, lon, d = x.get("lat"), x.get("lon"), x.get("distanceM")
            alt = x.get("altitude")
            if lat is None or lon is None or d is None or alt is None:
                continue
            if d - last >= STEP_M:
                pts.append([round(lat, 5), round(lon, 5), round(d, 1), round(alt, 1)])
                last = d
        if len(pts) < 20 or pts[-1][2] < MIN_KM * 1000:
            continue
        dest.write_text(json.dumps({
            "id": dest.stem, "date": m.group(1), "sport": "running/session-log",
            "km": round(pts[-1][2] / 1000, 2), "points": pts,
        }))
        folded += 1
        print(f"  folded {dest.name} ({pts[-1][2] / 1000:.1f} km)")
    print(f"{folded} new session routes, {seen} already folded")


if __name__ == "__main__":
    main()
