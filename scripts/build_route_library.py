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

Run: <fitenv>/bin/python scripts/build_route_library.py [fit-dir ...]
FIT dirs are extracted into data/routes/history (existing ids skipped);
the library is then clustered from EVERYTHING in history — takeout FITs,
recent API pulls (pull_recent_fits.py) and the phone's own session logs
(fold_session_routes.py). No args = re-cluster only.

Consensus profile (2026-09-06): a cluster's altitude is the mean over ALL
its runs (each map-matched onto the representative, per-run barometric
offset removed) — one recording's jitter put summits ~100m off across
runs in the route backtest; ten recordings averaged should not.
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


def consensus(rep, members):
    """Average member altitudes onto the representative's points."""
    pts = rep["points"]
    rlat = [p[0] for p in pts]
    rlon = [p[1] for p in pts]
    kx = 111_320 * math.cos(math.radians(rlat[0]))
    ky = 110_540
    grid = defaultdict(list)
    for i, p in enumerate(pts):
        grid[(int(p[1] * kx // 40), int(p[0] * ky // 40))].append(i)
    sums = [p[3] for p in pts]
    counts = [1.0] * len(pts)
    for m in members:
        # nearest rep point (≤30m) for each member point
        pairs = []
        for q in m["points"]:
            cx, cy = int(q[1] * kx // 40), int(q[0] * ky // 40)
            best, bestD = -1, 30.0
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    for i in grid.get((cx + dx, cy + dy), ()):
                        d = math.hypot((q[1] - rlon[i]) * kx, (q[0] - rlat[i]) * ky)
                        if d < bestD:
                            bestD, best = d, i
            if best >= 0:
                pairs.append((best, q[3]))
        if len(pairs) < 20:
            continue
        diffs = sorted(alt - pts[i][3] for i, alt in pairs)
        offset = diffs[len(diffs) // 2]  # barometric offset this day
        for i, alt in pairs:
            sums[i] += alt - offset
            counts[i] += 1
    return [[p[0], p[1], p[2], round(sums[i] / counts[i], 1)] for i, p in enumerate(pts)]


BRANCH_AHEAD_PTS = 5   # 100m at 20m spacing
BRANCH_NEAR_M = 30


def branch_probabilities(rep_points, run_grids):
    """History as a Markov chain, precomputed: for each route point, the share
    of ALL runs that passed here AND were still on this route 100m later.
    The matcher multiplies these along the way to a cue → the probability
    the runner follows this route that far. Direction-blind (a run through
    here the other way counts), which is fine: it is a "does anyone ever
    turn off here" prior, not a heading model."""
    n = len(rep_points)
    here = [0] * n
    both = [0] * n
    for g in run_grids:
        near = [g.near(p, BRANCH_NEAR_M) for p in rep_points]
        for i in range(n):
            if not near[i]:
                continue
            here[i] += 1
            j = min(n - 1, i + BRANCH_AHEAD_PTS)
            if near[j]:
                both[i] += 1
    return [round(both[i] / here[i], 2) if here[i] else 1.0 for i in range(n)]


def main():
    fit_dirs = [Path(a) for a in sys.argv[1:]]
    HIST.mkdir(parents=True, exist_ok=True)
    have = {p.stem for p in HIST.glob("*.json")}
    files = []
    for d in fit_dirs:
        files += sorted(d.glob("*.fit"))
    if files:
        with Pool(8) as pool:
            new = [r for r in pool.imap_unordered(extract, files, chunksize=32) if r and r["id"] not in have]
        for r in new:
            (HIST / f"{r['id']}.json").write_text(json.dumps(r))
        print(f"{len(files)} FIT files → {len(new)} new GPS runs ≥{MIN_KM}km")
    routes = [json.loads(p.read_text()) for p in HIST.glob("*.json")]
    routes = [r for r in routes if r.get("points") and r["points"][-1][2] >= MIN_KM * 1000]
    routes.sort(key=lambda r: r["date"], reverse=True)

    # Greedy clustering, most recent first (the representative is the freshest track).
    clusters = []  # {rep, grid, members: [route]}
    for r in routes:
        g = Grid(r["points"])
        joined = False
        for c in clusters:
            if abs(c["rep"]["km"] - r["km"]) > max(1.0, 0.25 * c["rep"]["km"]):
                continue
            if fraction_within(r["points"], c["grid"]) >= CLUSTER_FRACTION and \
               fraction_within(c["rep"]["points"], g) >= CLUSTER_FRACTION:
                c["members"].append(r)
                joined = True
                break
        if not joined:
            clusters.append({"rep": r, "grid": g, "members": []})
    run_grids = [Grid(r["points"]) for r in routes]
    lib_routes = []
    for c in clusters:
        pts = consensus(c["rep"], c["members"]) if c["members"] else c["rep"]["points"]
        lib_routes.append({
            "id": c["rep"]["id"],
            "km": c["rep"]["km"],
            "runs": 1 + len(c["members"]),
            "members": [c["rep"]["id"]] + [m["id"] for m in c["members"]],
            "points": pts,
            "branch": branch_probabilities(pts, run_grids),
        })
    lib = {"generatedAt": routes[0]["date"] if routes else None, "routes": lib_routes}
    LIB.write_text(json.dumps(lib))
    sizes = sorted((1 + len(c["members"]) for c in clusters), reverse=True)
    print(f"{len(routes)} runs → {len(clusters)} route clusters · top repeat counts {sizes[:8]} · library {LIB.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
