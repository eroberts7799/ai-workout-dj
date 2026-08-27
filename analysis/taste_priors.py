#!/usr/bin/env python3
"""Taste priors from Spotify Extended Streaming History.

The motherlode: every play Ethan has ever made (2019→now), each with
ms_played, skipped, and reason_end. This turns raw history into a per-track
affinity the picker uses — a track loved over years outranks a stranger,
and a track he habitually skips gets penalised even if it "fits" musically.

Affinity per track (normalized "artist|title" key, matching the tag table
and the engine's normKey):
  plays        — how many times started
  completions  — reason_end trackdone / ms_played ≥ 80% of a typical play
  skips        — skipped flag OR reason_end fwdbtn with ms_played < 30s
  totalMinutes — lifetime listening
  affinity     — completions - skips, log-damped by recency-weighted plays;
                 negative = a track to AVOID even when it mixes well.

Output: data/taste-priors.json (local-only; contains listening history —
never leaves the machine per the privacy floor) + a summary. This is a
prior, not a playlist: it re-weights whatever library is loaded.

Run: python3 analysis/taste_priors.py <extracted-export-dir>
"""

import glob
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "data" / "taste-priors.json"

def norm(s):
    s = re.sub(r"\((?:extended|original|club|radio)[^)]*\)", "", (s or "").lower())
    s = re.sub(r"\s*(?:feat|ft)\.?\s.*", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

def year_of(ts):
    return int(ts[:4]) if ts and len(ts) >= 4 else 2019

def main():
    export_dir = sys.argv[1]
    files = glob.glob(f"{export_dir}/**/Streaming_History_Audio_*.json", recursive=True)
    if not files:
        print("no Streaming_History_Audio_*.json found under", export_dir)
        sys.exit(1)

    agg = defaultdict(lambda: {"plays": 0, "completions": 0, "skips": 0, "ms": 0,
                               "artist": "", "title": "", "wplays": 0.0})
    total_plays = 0
    latest_year = 2019
    for f in files:
        for r in json.load(open(f)):
            title = r.get("master_metadata_track_name")
            artist = r.get("master_metadata_album_artist_name")
            if not title or not artist:
                continue  # podcast/audiobook rows
            total_plays += 1
            y = year_of(r.get("ts"))
            latest_year = max(latest_year, y)
            ms = r.get("ms_played") or 0
            k = f"{norm(artist)}|{norm(title)}"
            a = agg[k]
            a["artist"], a["title"] = artist, title
            a["plays"] += 1
            a["ms"] += ms
            # Recency weight: recent years count more (half-life ~3 yrs).
            a["wplays"] += 0.5 ** ((latest_year - y) / 3.0)
            skipped = r.get("skipped") or (r.get("reason_end") == "fwdbtn" and ms < 30_000)
            if skipped:
                a["skips"] += 1
            elif r.get("reason_end") == "trackdone" or ms >= 120_000:
                a["completions"] += 1

    priors = {}
    for k, a in agg.items():
        if a["plays"] < 2:
            continue  # a single play is noise, not taste
        # completions minus skips, damped by log of recency-weighted plays.
        raw = (a["completions"] - a["skips"]) * math.log1p(a["wplays"])
        priors[k] = {
            "affinity": round(raw, 2),
            "plays": a["plays"],
            "skips": a["skips"],
            "minutes": round(a["ms"] / 60000, 1),
            "artist": a["artist"],
            "title": a["title"],
        }

    OUT.parent.mkdir(exist_ok=True)
    json.dump({"generatedFromPlays": total_plays, "tracks": priors}, open(OUT, "w"))

    # Compact shippable bonus map: normalize affinity to a capped ±2 the
    # engine adds directly (comparable to mixScore's +2 and the learned-pair
    # +2). Scale by the 90th-percentile positive affinity so a handful of
    # obsession tracks don't flatten everything else. Only tracks with real
    # signal ship (|bonus| ≥ 0.5) — the map stays small and private.
    pos = sorted(p["affinity"] for p in priors.values() if p["affinity"] > 0)
    p90 = pos[int(len(pos) * 0.9)] if pos else 1.0
    bonus_map = {}
    for k, p in priors.items():
        b = max(-2.0, min(2.0, 2.0 * p["affinity"] / p90))
        if abs(b) >= 0.5:
            bonus_map[k] = round(b, 2)
    BONUS = REPO / "data" / "taste-bonus.json"
    json.dump(bonus_map, open(BONUS, "w"))
    print(f"shippable bonus map: {len(bonus_map)} tracks with |bonus|≥0.5 → {BONUS.name}")

    ranked = sorted(priors.values(), key=lambda p: -p["affinity"])
    total_min = sum(p["minutes"] for p in priors.values())
    print(f"{total_plays:,} plays across {len(files)} years → {len(priors):,} tracks with a prior")
    print(f"lifetime: {total_min/60:,.0f} hours of tracked listening\n")
    print("TOP 15 by affinity (your anthems):")
    for p in ranked[:15]:
        print(f"  {p['affinity']:6.1f}  {p['plays']:4}× {p['artist']} — {p['title']}")
    print("\nMOST SKIPPED (the picker will avoid these):")
    for p in sorted(priors.values(), key=lambda x: (x["skips"] - x["plays"]))[:8]:
        if p["skips"] >= 3:
            print(f"  {p['skips']}/{p['plays']} skipped  {p['artist']} — {p['title']}")
    print(f"\nwrote {OUT}")

if __name__ == "__main__":
    main()
