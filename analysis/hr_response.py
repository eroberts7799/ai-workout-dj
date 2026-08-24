#!/usr/bin/env python3
"""Physiological reward v1: score every logged transition by HR response.

The moat data, finally computed instead of merely collected. Every session
log carries the raw sample stream (tMs/hr/distance) and the command list;
this script windows heart rate around each command and asks: what did the
body do when the music changed?

Windows (literature-informed guesses, not yet data-tuned — HR lags effort
by ~20-40s, so the "after" window must outlast the lag):
  before = mean HR over [-45s, -5s]   (settled pre-transition state)
  after  = mean HR over [+20s, +80s]  (past the lag, before the next change)
A command needs >=60% HR coverage in both windows to score — sparse or
HR-less logs are reported, not silently skipped (no silent caps).

Honesty note baked into the output: HR responds to EFFORT first, music
second. Rep changes coincide with pace changes BY DESIGN (that's the
product), so their deltas measure choreography+effort together. Groove
fills and natural-end chains happen mid-steady-state — their deltas are
the closest thing v1 has to a pure music signal. The per-class split IS
the analysis; a pooled number would be a confound salad.

Reads the cloud archive via the relay (same key as the Replay Lab).
Output: data/hr-response.json (local-only, gitignored with data/) and a
printed summary. Run: python3 analysis/hr_response.py  (stdlib only — NOT
the fragile allin1 venv).
"""

import json
import re
import statistics
import urllib.parse
import urllib.request
from pathlib import Path

RELAY = "https://awdj-relay.vercel.app/api/sessions"
KEY = "awdj-7g2k9x"
OUT = Path(__file__).resolve().parent.parent / "data" / "hr-response.json"

BEFORE_WIN = (-45_000, -5_000)
AFTER_WIN = (20_000, 80_000)
MIN_COVERAGE = 0.6  # fraction of expected 1Hz samples carrying HR

def fetch(url: str):
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)

def reason_class(reason: str) -> str:
    """Collapse command reasons to their transition class."""
    r = reason.lower()
    if "crest" in r:
        return "crest reward"
    for cls in ("rep change", "groove fill", "buildup", "drop lands", "build re-aim", "loop back"):
        if r.startswith(cls):
            return cls
    return "other"

def window_mean(samples, t0, win):
    lo, hi = t0 + win[0], t0 + win[1]
    vals = [s["hr"] for s in samples if lo <= s["tMs"] <= hi and s.get("hr") is not None]
    expected = (hi - lo) / 1000
    if expected <= 0 or len(vals) / expected < MIN_COVERAGE:
        return None
    return statistics.fmean(vals)

def score_session(pathname: str, log: dict):
    samples = log.get("samples") or []
    commands = log.get("commands") or []
    hr_n = sum(1 for s in samples if s.get("hr") is not None)
    if not commands or hr_n < 60:  # under a minute of HR = nothing to window
        return None, f"skipped {pathname}: {len(commands)} commands, {hr_n} HR samples"
    end_t = samples[-1]["tMs"]
    rows = []
    for i, c in enumerate(commands):
        t0 = c["tMs"]
        nxt = commands[i + 1]["tMs"] if i + 1 < len(commands) else end_t
        before = window_mean(samples, t0, BEFORE_WIN)
        # Never score past the next transition — its response isn't ours.
        after_hi = min(AFTER_WIN[1], nxt - t0)
        after = window_mean(samples, t0, (AFTER_WIN[0], after_hi)) if after_hi > AFTER_WIN[0] else None
        if before is None or after is None:
            continue
        rows.append({
            "session": pathname,
            "tMs": t0,
            "reason": c.get("reason", ""),
            "class": reason_class(c.get("reason", "")),
            "trackId": c.get("trackId"),
            "hrBefore": round(before, 1),
            "hrAfter": round(after, 1),
            "deltaBpm": round(after - before, 1),
        })
    return rows, None

def main():
    listing = fetch(f"{RELAY}?k={KEY}")
    all_rows, notes = [], []
    for entry in listing:
        pathname = entry["pathname"]
        log = fetch(f"{RELAY}?k={KEY}&file={urllib.parse.quote(pathname)}")
        rows, note = score_session(pathname, log)
        if note:
            notes.append(note)
        else:
            all_rows.extend(rows)
            notes.append(f"scored  {pathname}: {len(rows)} transitions")

    by_class = {}
    for r in all_rows:
        by_class.setdefault(r["class"], []).append(r["deltaBpm"])
    summary = {
        cls: {
            "n": len(d),
            "meanDeltaBpm": round(statistics.fmean(d), 2),
            "medianDeltaBpm": round(statistics.median(d), 2),
        }
        for cls, d in sorted(by_class.items())
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "windows": {"beforeMs": BEFORE_WIN, "afterMs": AFTER_WIN, "minCoverage": MIN_COVERAGE},
        "confoundNote": "rep-change deltas measure choreography+effort together; "
                        "groove-fill/chain deltas are the closest to a pure music signal",
        "summary": summary,
        "transitions": all_rows,
    }, indent=1))

    print(f"scored {len(all_rows)} transitions across {sum(1 for n in notes if n.startswith('scored'))} sessions")
    for n in notes:
        print(" ", n)
    print("\nper-class HR response (after - before, bpm):")
    for cls, s in summary.items():
        print(f"  {cls:18} n={s['n']:<4} mean {s['meanDeltaBpm']:+6.2f}  median {s['medianDeltaBpm']:+6.2f}")
    print(f"\nwrote {OUT}")

if __name__ == "__main__":
    main()
