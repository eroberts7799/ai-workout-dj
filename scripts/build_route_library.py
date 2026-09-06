#!/usr/bin/env python3
"""Build the personal route library from Garmin FIT files (GPS runs).

"Your history is your route": Ethan runs the same routes. With every past
track on the phone, the live run's first few hundred meters identify which
route he is on, and the terrain machinery (proven in the replay lab, crest
arrival p90 3.1s) runs against that route's elevation profile — no GPX,
no planning, no download. Privacy floor (CLAUDE.md rule 10, relaxed
2026-09-06 for ETHAN'S OWN data only): coordinates are extracted here,
stay under data/ (gitignored), and travel only through key-gated relay
blobs to his own phone. Friend data still never carries positions.

Output:
  data/routes/history/<date>-<id>.json   one downsampled track per GPS run
  data/routes/library.json               deduped route clusters for the phone

Dedupe: routes that are mutually ≥85% within 30m of each other are one
cluster (same route); the representative is the most recent run, `runs`
counts how often it was run. Near-identical loops in both directions are
handled at MATCH time (the matcher tries each route reversed), not here.

Run: <fitenv>/bin/python scripts/build_route_library.py <fit-dir>
"""

import json
import math
import sys
from collections import defaultdict
from multiprocessing import Pool
from pathlib import Path

import fitdecode

REPO = Path(__file__).resolve().parent.parent
HIST = REPO / "data" / "routes" / "history"
LIB = REPO / "data" / "routes" / "library.json"

SEMI = 180 / 2**31
STEP_M = 20          # downsample spacing
MIN_KM = 2.0
MIN_FILE_BYTES = 20_000  # monitoring / tiny files carry no track
CLUSTER_WITHIN_M = 30
CLUSTER_FRACTION = 0.85
RUN_SPORTS = {"running", "trail_running"}


def extract(path):
    path = Path(path)
    if path.stat().st_size < MIN_FILE_BYTES:
        return None
    sport, sub, start, pts = None, None, None, []
    try:
        with fitdecode.FitReader(path) as fr:
            for frame in fr:
                if not isinstance(frame, fitdecode.FitDataMessage):
                    continue
                n = frame.name
                if n == "sport":
                    sport = frame.get_value("sport", fallback=None)
                    sub = frame.get_value("sub_sport", fallback=None)
                elif n == "session":
                    sport = sport or frame.get_value("sport", fallback=None)
                    start = frame.get_value("start_time", fallback=None)
                elif n == "record":
                    lat = frame.get_value("position_lat", fallback=None)
                    lon = frame.get_value("position_long", fallback=None)
                    d = frame.get_value("distance", fallback=None)
                    alt = frame.get_value("enhanced_altitude", fallback=None)
                    if alt is None:
                        alt = frame.get_value("altitude", fallback=None)
                    if lat is None or lon is None or d is None or alt is None:
                        continue
                    pts.append((lat * SEMI, lon * SEMI, float(d), float(alt)))
    except Exception:
        return None
    if str(sport) not in RUN_SPORTS or len(pts) < 100:
        return None
    # Downsample by distance.
    out, last = [], -1e9
    for lat, lon, d, alt in pts:
        if d - last >= STEP_M:
            out.append([round(lat, 5), round(lon, 5), round(d, 1), round(alt, 1)])
            last = d
    if not out or out[-1][2] < MIN_KM * 1000:
        return None
    act_id = path.stem.split("_")[-1]
    date = start.strftime("%Y-%m-%d") if start else "unknown"
    return {
        "id": f"{date}-{act_id}",
        "date": date,
        "sport": str(sport) + (f"/{sub}" if sub else ""),
        "km": round(out[-1][2] / 1000, 2),
        "points": out,
    }


class Grid:
    """Coarse spatial hash over a track for cheap 'is any point within R'."""

    def __init__(self, pts, cell_m=CLUSTER_WITHIN_M):
        self.lat0 = pts[0][0]
        self.kx = 111_320 * math.cos(math.radians(self.lat0))
        self.ky = 110_540
        self.cell = cell_m
        self.cells = defaultdict(list)
        for p in pts:
            x, y = self.xy(p)
            self.cells[(int(x // cell_m), int(y // cell_m))].append((x, y))

    def xy(self, p):
        return (p[1] * self.kx, p[0] * self.ky)

    def near(self, p, r):
        x, y = self.xy(p)
        cx, cy = int(x // self.cell), int(y // self.cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for qx, qy in self.cells.get((cx + dx, cy + dy), ()):
                    if (qx - x) ** 2 + (qy - y) ** 2 <= r * r:
                        return True
        return False


def fraction_within(a, grid_b, r=CLUSTER_WITHIN_M):
    hits = sum(1 for p in a if grid_b.near(p, r))
    return hits / len(a)


def main():
    fit_dir = Path(sys.argv[1])
    files = sorted(fit_dir.glob("*.fit"))
    HIST.mkdir(parents=True, exist_ok=True)
    with Pool(8) as pool:
        routes = [r for r in pool.imap_unordered(extract, files, chunksize=32) if r]
    routes.sort(key=lambda r: r["date"], reverse=True)
    for r in routes:
        (HIST / f"{r['id']}.json").write_text(json.dumps(r))
    print(f"{len(files)} files → {len(routes)} GPS runs ≥{MIN_KM}km")

    # Greedy clustering, most recent first (the representative is the freshest track).
    clusters = []  # {rep, grid, members}
    for r in routes:
        g = Grid(r["points"])
        joined = False
        for c in clusters:
            if abs(c["rep"]["km"] - r["km"]) > max(1.0, 0.25 * c["rep"]["km"]):
                continue
            if fraction_within(r["points"], c["grid"]) >= CLUSTER_FRACTION and \
               fraction_within(c["rep"]["points"], g) >= CLUSTER_FRACTION:
                c["members"].append(r["id"])
                joined = True
                break
        if not joined:
            clusters.append({"rep": r, "grid": g, "members": [r["id"]]})
    lib = {
        "generatedAt": routes[0]["date"] if routes else None,
        "routes": [
            {
                "id": c["rep"]["id"],
                "km": c["rep"]["km"],
                "runs": len(c["members"]),
                "members": c["members"],
                "points": c["rep"]["points"],
            }
            for c in clusters
        ],
    }
    LIB.write_text(json.dumps(lib))
    sizes = sorted((len(c["members"]) for c in clusters), reverse=True)
    print(f"{len(clusters)} route clusters · top repeat counts {sizes[:8]} · library {LIB.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
