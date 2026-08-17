#!/usr/bin/env python3
"""Key detection → Camelot, for DJ-crate harmonic matching.

Krumhansl-Schmuckler key profiles correlated against the track's average
chroma (librosa chroma_cqt). Output shape matches crate-keys.json:
  { "<sourceFile>": {"key": "A#m", "camelot": "3A", "confidence": 0.52}, ... }

Usage: analysis/.venv/bin/python analysis/detect_keys.py <audio...> --out keys.json
Merge into an existing keys file by passing --merge-into crate-keys.json.
"""

import argparse
import json
from pathlib import Path

import numpy as np
import librosa

MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Camelot wheel: number+letter per key (B = major, A = minor).
CAMELOT_MAJOR = {"B": "1B", "F#": "2B", "C#": "3B", "G#": "4B", "D#": "5B", "A#": "6B", "F": "7B", "C": "8B", "G": "9B", "D": "10B", "A": "11B", "E": "12B"}
CAMELOT_MINOR = {"G#": "1A", "D#": "2A", "A#": "3A", "F": "4A", "C": "5A", "G": "6A", "D": "7A", "A": "8A", "E": "9A", "B": "10A", "F#": "11A", "C#": "12A"}


def detect(path):
    y, sr = librosa.load(path, sr=22050, mono=True, duration=180)
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
    best = None
    for shift in range(12):
        rolled = np.roll(chroma, -shift)
        for profile, is_major in ((MAJOR, True), (MINOR, False)):
            r = float(np.corrcoef(rolled, profile)[0, 1])
            if best is None or r > best[0]:
                best = (r, shift, is_major)
    r, shift, is_major = best
    note = NOTES[shift]
    key = f"{note}{'' if is_major else 'm'}"
    camelot = (CAMELOT_MAJOR if is_major else CAMELOT_MINOR)[note]
    return {"key": key, "camelot": camelot, "confidence": round(r, 2)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--merge-into")
    args = ap.parse_args()
    out = {}
    if args.merge_into and Path(args.merge_into).exists():
        out = json.loads(Path(args.merge_into).read_text())
    for f in args.files:
        p = Path(f)
        out[p.name] = detect(p)
        print(f"{p.name}: {out[p.name]['key']} ({out[p.name]['camelot']}, r={out[p.name]['confidence']})")
    dest = Path(args.merge_into or args.out)
    dest.write_text(json.dumps(out, indent=1))
    print(f"wrote {dest} ({len(out)} entries)")


if __name__ == "__main__":
    main()
