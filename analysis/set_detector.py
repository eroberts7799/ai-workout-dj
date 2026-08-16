#!/usr/bin/env python3
"""Set-start detection from HR alone, evaluated against Garmin's own set
labels (4,223 sets across 282 of Ethan's strength sessions).

Detector (deterministic, portable to the live engine): smoothed HR slope
crosses a rise threshold after a rest (non-rising) period, with a
refractory gap between detections.

Matching: a detection within [-10s, +35s] of a labeled active-set start
counts (HR lags muscular effort). Train/test split by date (60/40).
Reports precision / recall / median timing offset on TEST only.
"""
import glob
import json
import statistics
import sys

DIR = sys.argv[1] if len(sys.argv) > 1 else "data/garmin-history"

def load_sessions():
    out = []
    for f in sorted(glob.glob(f"{DIR}/*-training-*.json")):
        d = json.load(open(f))
        sets = [s["startMs"] for s in d.get("sets", []) if s["type"] == "active" and s.get("startMs") is not None]
        hr = [(s["tMs"], s["hr"]) for s in d["samples"] if s.get("hr")]
        if len(sets) >= 3 and len(hr) > 300:
            out.append((f, sorted(sets), hr))
    return out

def detect(hr, alpha, rise_bpm_per_s, rest_s, refractory_s):
    """Set starts: EMA slope > threshold after >=rest_s of non-rise."""
    ema = None
    prev_t = None
    slope_win = []  # (t, ema)
    last_rise_end = None
    non_rise_since = None
    last_fire = -1e12
    fires = []
    for t, v in hr:
        ema = v if ema is None else ema * (1 - alpha) + v * alpha
        slope_win.append((t, ema))
        while slope_win and t - slope_win[0][0] > 15_000:
            slope_win.pop(0)
        if len(slope_win) < 4 or t - slope_win[0][0] < 8000:
            continue
        slope = (ema - slope_win[0][1]) / ((t - slope_win[0][0]) / 1000)
        rising = slope > rise_bpm_per_s
        if not rising:
            if non_rise_since is None:
                non_rise_since = t
        else:
            rested = non_rise_since is not None and (t - non_rise_since) >= rest_s * 1000
            if rested and t - last_fire >= refractory_s * 1000:
                fires.append(t)
                last_fire = t
            non_rise_since = None
    return fires

def score(sessions, params):
    tp = fp = fn = 0
    offsets = []
    for _, sets, hr in sessions:
        fires = detect(hr, *params)
        used = set()
        for s in sets:
            hit = None
            for i, f in enumerate(fires):
                if i in used:
                    continue
                if -10_000 <= f - s <= 35_000:
                    hit = i
                    break
            if hit is not None:
                used.add(hit)
                tp += 1
                offsets.append((fires[hit] - s) / 1000)
            else:
                fn += 1
        fp += len(fires) - len(used)
    prec = tp / max(1, tp + fp)
    rec = tp / max(1, tp + fn)
    return prec, rec, (statistics.median(offsets) if offsets else 0)

sessions = load_sessions()
sessions.sort(key=lambda x: x[0])
cut = int(len(sessions) * 0.6)
train, test = sessions[:cut], sessions[cut:]
print(f"{len(train)} train / {len(test)} test sessions")

best = None
for alpha in (0.2, 0.3):
    for rise in (0.25, 0.4, 0.6):
        for rest in (15, 25, 40):
            for refr in (45, 60, 90):
                p, r, off = score(train, (alpha, rise, rest, refr))
                f1 = 2 * p * r / max(1e-9, p + r)
                if best is None or f1 > best[0]:
                    best = (f1, (alpha, rise, rest, refr), p, r)
print(f"best on train: alpha={best[1][0]} rise={best[1][1]}bpm/s rest={best[1][2]}s refractory={best[1][3]}s  (P={best[2]:.2f} R={best[3]:.2f} F1={best[0]:.2f})")

p, r, off = score(test, best[1])
f1 = 2 * p * r / max(1e-9, p + r)
print(f"TEST: precision={p:.2f} recall={r:.2f} F1={f1:.2f} median offset={off:+.1f}s  ({len(test)} unseen sessions)")
