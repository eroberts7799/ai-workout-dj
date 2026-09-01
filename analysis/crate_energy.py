"""Energy for the owned crate, computed from the files themselves.

The preview pipeline (virtual_crate.py) scores energy on the iTunes 30s
hook: min(1, rms*6 + onset/8). Owned DJ edits never went through it, so
the watch crate shipped energy=null (parity gap, 2026-09-01). Same
formula, same 30s window length — anchored at the first drop marker when
the crate analysis has one (the hook), file midpoint otherwise — so the
scale stays comparable. Writes energy back into crate-analysis.json.

Run with the FRAGILE analysis venv:
    analysis/.venv/bin/python analysis/crate_energy.py [music_dir]
"""

import json
import os
import sys

import librosa
import numpy as np

MUSIC = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/awdj-music"))
PATH = os.path.join(os.path.dirname(__file__), "crate-analysis.json")

raw = json.load(open(PATH))
entries = raw.get("analysis", raw) if isinstance(raw, dict) else raw

# Raw loudness scores first. The preview formula min(1, rms*6 + onset/8)
# SATURATES on full-file modern masters (first pass: 41/44 pinned at 1.0 —
# zero discrimination), so file-derived energy is RANK-normalized instead:
# ordering preserved, mapped onto the tag table's observed 0.5–1.0 range.
scores = []
for e in entries:
    f = os.path.join(MUSIC, e["sourceFile"])
    if not os.path.exists(f):
        continue
    drop = next((m["ms"] for m in e.get("markers", []) if m.get("type") == "drop"), None)
    dur = e.get("durationMs") or 0
    start_s = (drop / 1000) if drop else max(0, dur / 2000 - 15)
    try:
        y, sr = librosa.load(f, sr=22050, offset=start_s, duration=30, mono=True)
        rms = float(np.mean(librosa.feature.rms(y=y)))
        onset = float(np.mean(librosa.onset.onset_strength(y=y, sr=sr)))
        scores.append((e, rms * 6 + onset / 8))
    except Exception as ex:
        print(f"{e['sourceFile']}: FAILED {ex}", file=sys.stderr)

scores.sort(key=lambda p: p[1])
n = len(scores)
for rank, (e, raw_score) in enumerate(scores):
    e["energy"] = round(0.5 + 0.5 * (rank / max(1, n - 1)), 2)
    print(f"{e['sourceFile']}: energy={e['energy']} (raw {raw_score:.2f})")

json.dump(raw, open(PATH, "w"), indent=1)
print(f"\n{n} entries ranked")
