#!/usr/bin/env python3
"""Per-athlete HR calibration from workout history.

Reads every converted activity JSON (Ethan: data/garmin-history/, friends:
data/friend-history/<name>/) and estimates a defensible per-athlete max HR,
replacing the invented DEFAULT_HR_MAX = 190 in the engines.

Estimator (artifact-resistant by construction):
  1. Per activity, "sustained max" = the highest 30-second rolling MEDIAN of
     the HR stream. A single-sample optical spike can't move a 30s median;
     a real max-effort finish (30s+ near max) survives it.
  2. Athlete hrMax = the SECOND-highest sustained max across all activities.
     One corrupt recording (strap dropout reading 220, cadence lock-in) can
     top the list; it can't also be runner-up. Two independent workouts
     sustaining the same 30s ceiling is evidence.
  3. The top-5 sustained maxes are emitted with dates/sports so the choice
     can be eyeballed against real memories ("yes, that was the 5k PR").

Zones stay the classic %-of-max bands the engine already uses — only the
anchor is calibrated. Output: data/athlete-calibration.json (local-only,
gitignored with the rest of data/; friend data never leaves the machine).

Run: python3 analysis/hr_calibration.py   (stdlib only — NOT the fragile
allin1 venv; see analysis/setup.sh warning)
"""

import json
import statistics
import sys
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WINDOW_MS = 30_000
MIN_HR = 30  # below this is a dropout/zero, not a heartbeat
MIN_WINDOW_SAMPLES = 10  # a 30s median needs real support at ~1Hz

ATHLETES = {
    "ethan": REPO / "data" / "garmin-history",
    "john-kubinak": REPO / "data" / "friend-history" / "john-kubinak",
    "noah-roberts": REPO / "data" / "friend-history" / "noah-roberts",
}


def sustained_max(samples):
    """Highest 30s rolling median of (tMs, hr) pairs; None if too sparse."""
    pts = [(s["tMs"], s["hr"]) for s in samples
           if s.get("hr") is not None and s["hr"] > MIN_HR and s.get("tMs") is not None]
    if len(pts) < MIN_WINDOW_SAMPLES:
        return None
    pts.sort()
    best = None
    lo = 0
    for hi in range(len(pts)):
        while pts[hi][0] - pts[lo][0] > WINDOW_MS:
            lo += 1
        if hi - lo + 1 >= MIN_WINDOW_SAMPLES:
            med = statistics.median(p[1] for p in pts[lo:hi + 1])
            if best is None or med > best:
                best = med
    return best


def calibrate(name, folder):
    files = sorted(folder.glob("*.json"))
    per_activity = []
    abs_max = 0
    with_hr = 0
    for f in files:
        try:
            act = json.loads(f.read_text())
        except (json.JSONDecodeError, OSError):
            continue
        samples = act.get("samples") or []
        hrs = [s["hr"] for s in samples if s.get("hr") is not None and s["hr"] > MIN_HR]
        if not hrs:
            continue
        with_hr += 1
        abs_max = max(abs_max, max(hrs))
        sm = sustained_max(samples)
        if sm is not None:
            per_activity.append({
                "file": f.name,
                "sport": act.get("sport"),
                "sustainedMax": round(sm, 1),
            })
    per_activity.sort(key=lambda a: -a["sustainedMax"])
    if len(per_activity) < 2:
        return None
    hr_max = round(per_activity[1]["sustainedMax"])  # runner-up rule
    return {
        "hrMax": hr_max,
        "method": "2nd-highest 30s-rolling-median across activities",
        "absMaxSample": round(abs_max),
        "activities": len(files),
        "activitiesWithHr": with_hr,
        "top5": per_activity[:5],
        "zonesBpm": {  # engine bands 0.6/0.7/0.8/0.9 of max, for humans
            "z2From": round(0.6 * hr_max),
            "z3From": round(0.7 * hr_max),
            "z4From": round(0.8 * hr_max),
            "z5From": round(0.9 * hr_max),
        },
    }


def main():
    out = {"generated": date.today().isoformat(), "athletes": {}}
    for name, folder in ATHLETES.items():
        if not folder.is_dir():
            print(f"{name}: folder missing, skipped", file=sys.stderr)
            continue
        cal = calibrate(name, folder)
        if cal is None:
            print(f"{name}: not enough HR data", file=sys.stderr)
            continue
        out["athletes"][name] = cal
        print(f"{name}: hrMax={cal['hrMax']} (abs sample max {cal['absMaxSample']}, "
              f"{cal['activitiesWithHr']}/{cal['activities']} activities with HR)")
        for a in cal["top5"]:
            print(f"    {a['sustainedMax']:>6}  {a['sport'] or '?':<18} {a['file']}")
    dest = REPO / "data" / "athlete-calibration.json"
    dest.write_text(json.dumps(out, indent=2))
    print(f"\nwrote {dest}")


if __name__ == "__main__":
    main()
