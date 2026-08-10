#!/usr/bin/env python3
"""Listen to audio files and emit AI Workout DJ marker tags.

Runs the all-in-one music structure analyzer (tempo, beats, downbeats,
labeled sections), then maps sections onto the app's marker vocabulary:

  drop       -> start of each chorus run (chorus onset ~= the drop in workout music)
  buildup    -> start of the section immediately preceding a drop
  loop bounds-> the longest steady section (verse/inst/bridge) >= MIN_LOOP_SEC

All markers snap to the nearest detected downbeat, which is more accurate
than human tapping. Output is an analysis JSON the web app imports and
matches to Spotify track IDs via search; final QA stays human (audition +
nudge in the tagger UI) because "drop" is a vibe, not a label.

Usage:
  python analyze.py song1.m4a song2.mp3 --out analysis-tags.json
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

MIN_LOOP_SEC = 15.0
LOOPABLE = {"verse", "inst", "bridge"}
PRE_DROP = {"verse", "bridge", "break", "inst", "solo"}


def probe_metadata(path: Path) -> dict:
    """Title/artist/duration via ffprobe (no extra Python deps)."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "quiet", "-print_format", "json",
            "-show_format", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    fmt = json.loads(out).get("format", {})
    tags = {k.lower(): v for k, v in fmt.get("tags", {}).items()}
    return {
        "title": tags.get("title") or path.stem,
        "artist": tags.get("artist") or tags.get("album_artist") or "",
        "durationMs": round(float(fmt.get("duration", 0)) * 1000),
    }


def snap(downbeats: list[float], sec: float) -> float:
    return min(downbeats, key=lambda d: abs(d - sec)) if downbeats else sec


def to_markers(segments, downbeats: list[float]) -> list[dict]:
    markers: list[tuple[str, float]] = []

    for i, seg in enumerate(segments):
        is_chorus_onset = seg.label == "chorus" and (i == 0 or segments[i - 1].label != "chorus")
        if is_chorus_onset:
            markers.append(("drop", snap(downbeats, seg.start)))
            if i > 0 and segments[i - 1].label in PRE_DROP:
                markers.append(("buildup", snap(downbeats, segments[i - 1].start)))

    loopable = [s for s in segments if s.label in LOOPABLE and s.end - s.start >= MIN_LOOP_SEC]
    if loopable:
        best = max(loopable, key=lambda s: s.end - s.start)
        markers.append(("loop_start", snap(downbeats, best.start)))
        markers.append(("loop_end", snap(downbeats, best.end)))

    seen: set[tuple[str, int]] = set()
    out = []
    for kind, sec in sorted(markers, key=lambda m: m[1]):
        key = (kind, round(sec * 1000))
        if key not in seen:
            seen.add(key)
            out.append({"type": kind, "ms": round(sec * 1000)})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=Path("analysis-tags.json"))
    args = ap.parse_args()

    try:
        import allin1  # heavy import (torch); deferred so --help stays fast
    except ImportError:
        print("allin1 not installed — run ./setup.sh first", file=sys.stderr)
        return 1

    entries = []
    for f in args.files:
        if not f.exists():
            print(f"skip (missing): {f}", file=sys.stderr)
            continue
        print(f"analyzing {f.name} …")
        meta = probe_metadata(f)
        result = allin1.analyze(str(f))
        markers = to_markers(result.segments, list(result.downbeats))
        entries.append({
            "sourceFile": f.name,
            "title": meta["title"],
            "artist": meta["artist"],
            "durationMs": meta["durationMs"],
            "bpm": result.bpm,
            "markers": markers,
            "segments": [
                {"label": s.label, "startMs": round(s.start * 1000), "endMs": round(s.end * 1000)}
                for s in result.segments
            ],
        })
        print(f"  bpm={result.bpm} markers={[(m['type'], m['ms']) for m in markers]}")

    args.out.write_text(json.dumps({"version": 1, "analysis": entries}, indent=2))
    print(f"wrote {args.out} ({len(entries)} song(s)) — import it in the app's Song Tagger tab")
    return 0


if __name__ == "__main__":
    sys.exit(main())
