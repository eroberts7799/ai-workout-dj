"""Pace-over-grade model from the structured corpus (design doc, Approach A).

How much does grade cost Ethan, in pace? Per-run normalization (each run's
own flat pace = 1.0) removes three years of fitness drift; the aggregate
multiplier per grade bucket is his personal GAP curve. Effort windows are
excluded — classified by target speed (mid >= 3.7 m/s = genuine effort, the
same absolute rule as scripts/pull_next_workout.py), NOT by the corpus's
step kinds (the old extractor marks target-less "conversational pace" steps
as hard — same bug fixed in the pull script 2026-09-02).

Output: data/pace-grade.json {flatSecPerKm, multipliers{bucket->x}, counts}.
flatSecPerKm is the median flat pace of 2026 runs (the "current athlete
pace" the live system would know from recent history).

Run: python3 analysis/pace_over_grade.py
"""

import glob
import json
import statistics
from collections import defaultdict

EFFORT_ABSOLUTE_MPS = 3.7  # mirrors pull_next_workout.py
BUCKET_PCT = 2  # grade bucket width, percent
CLEAN_MEDIAN_DELTA_M = 1.5  # step-0 criterion from the design doc


def rolling_median(vals, w=5):
    half = w // 2
    return [
        statistics.median(vals[max(0, i - half):i + half + 1])
        for i in range(len(vals))
    ]


def effort_windows(doc):
    steps = doc.get("planSteps", [])
    bounds = doc.get("boundaries", [])
    out = []
    for b in bounds:
        i = b.get("stepIdx", -1)
        if not (0 <= i < len(steps)):
            continue
        s = steps[i]
        lo, hi = s.get("targetSpeedLow"), s.get("targetSpeedHigh")
        if lo and hi and (lo + hi) / 2 >= EFFORT_ABSOLUTE_MPS:
            end = bounds[bounds.index(b) + 1]["tMs"] if bounds.index(b) + 1 < len(bounds) else float("inf")
            out.append((b["tMs"], end))
    return out


def in_windows(t, windows):
    return any(a <= t < z for a, z in windows)


def bucket(grade):
    pct = max(-10, min(10, round(grade * 100 / BUCKET_PCT) * BUCKET_PCT))
    return str(int(pct))


def main():
    files = sorted(glob.glob("data/garmin-history-structured/*.json"))
    run_buckets = []  # per-run {bucket: multiplier}
    flat_2026 = []
    for f in files:
        d = json.load(open(f))
        samples = d.get("samples", [])
        alts = [s.get("altitude") for s in samples]
        if sum(1 for a in alts if a is not None) < 100:
            continue
        alts_f = [a for a in alts if a is not None]
        deltas = [abs(alts_f[i + 1] - alts_f[i]) for i in range(len(alts_f) - 1)]
        if statistics.median(deltas) >= CLEAN_MEDIAN_DELTA_M:
            continue
        windows = effort_windows(d)
        pts = [(s["tMs"], s["distanceM"], s.get("altitude")) for s in samples
               if s.get("distanceM") is not None and s.get("altitude") is not None]
        if len(pts) < 100:
            continue
        smooth = rolling_median([p[2] for p in pts])
        paces = defaultdict(list)  # bucket -> [sec/km]
        # Grade over ~60m windows, not per sample-pair: smart-recording gaps
        # (~7s, ~25m) put altimeter noise (±1m) at the same scale as real
        # elevation change, randomizing bucket assignment — the first fit
        # collapsed every multiplier to ~1.0 (dilution). Over 60m the
        # signal dominates (1m noise = 1.7% grade error).
        WINDOW_M = 60
        j = 0
        for i in range(1, len(pts)):
            dd = pts[i][1] - pts[j][1]
            if dd < WINDOW_M:
                continue
            dt = (pts[i][0] - pts[j][0]) / 1000
            mid_t = pts[i][0]
            if dt <= 0 or in_windows(mid_t, windows) or in_windows(pts[j][0], windows):
                j = i
                continue
            pace = dt / dd * 1000
            grade = (smooth[i] - smooth[j]) / dd
            j = i
            if not (180 <= pace <= 1200) or abs(grade) > 0.15:
                continue
            paces[bucket(grade)].append(pace)
        if not paces.get("0"):
            continue
        flat = statistics.median(paces["0"])
        run_buckets.append({b: statistics.median(v) / flat for b, v in paces.items() if len(v) >= 8})
        if f.split("/")[-1].startswith("2026"):
            flat_2026.append(flat)

    agg = defaultdict(list)
    for rb in run_buckets:
        for b, m in rb.items():
            agg[b].append(m)
    multipliers = {b: round(statistics.median(v), 4) for b, v in agg.items() if len(v) >= 5}
    out = {
        "flatSecPerKm": round(statistics.median(flat_2026), 1) if flat_2026 else None,
        "multipliers": multipliers,
        "runs": len(run_buckets),
        "runsPerBucket": {b: len(v) for b, v in agg.items()},
    }
    json.dump(out, open("data/pace-grade.json", "w"), indent=1)
    print(f"{len(run_buckets)} runs fitted | flat (2026): {out['flatSecPerKm']} s/km")
    for b in sorted(multipliers, key=int):
        print(f"  grade {b:>3}%: x{multipliers[b]} (n={len(agg[b])} runs)")


if __name__ == "__main__":
    main()
