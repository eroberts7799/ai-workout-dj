#!/usr/bin/env python3
"""Parse harvested 1001tracklists raw text into structured set sequences.

Output per set: ordered tracks with timestamps and "w/" overlays (tracks the
DJ layered simultaneously — mashup craft). Best-effort parsing of flattened
page text; unparseable fragments are dropped, not guessed.

Usage: parse_tracklists.py <corpus-dir> [--out corpus.json]
"""
import json
import re
import sys
from pathlib import Path

DIR = Path(sys.argv[1])
OUT = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else str(DIR / "corpus.json")

# `NN  MM:SS  Artist - Title ...` — position + optional timestamp starts an entry
ENTRY = re.compile(r"\s(\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)?\s+")
NOISE = re.compile(
    r"\s{2,}(?:Save|Pre-Save)\s+\d+|\s+\w[\w.]*\((?:[\d.]+k?)\)|\s{2,}\d+\s{2,}|\s+linked positions.*", re.S
)

def clean_track(fragment):
    frag = NOISE.split(fragment)[0].strip()
    # strip trailing ALL-CAPS label runs (2+ spaces then caps)
    frag = re.sub(r"\s{2,}[A-Z][A-Z0-9 &/().'!-]{2,}$", "", frag).strip()
    if " - " not in frag:
        return None
    artist, title = frag.split(" - ", 1)
    artist, title = artist.strip(), title.strip()
    if not artist or not title or len(artist) > 90 or len(title) > 90:
        return None
    return {"artist": artist, "title": title}

def ts_ms(ts):
    if not ts:
        return None
    parts = [int(p) for p in ts.split(":")]
    if len(parts) == 2:
        return (parts[0] * 60 + parts[1]) * 1000
    return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000

sets = []
for f in sorted(DIR.glob("set-*.txt")):
    text = f.read_text(errors="ignore")
    # main body starts after the header nav; entries begin at the first "01"
    m = ENTRY.search(text)
    if not m:
        continue
    body = text[m.start():]
    chunks = ENTRY.split(body)
    # chunks: ['', pos, ts, segment, pos, ts, segment, ...]
    tracks = []
    i = 1
    while i + 2 < len(chunks) + 1 and i + 2 <= len(chunks):
        pos, ts, seg = chunks[i], chunks[i + 1], chunks[i + 2] if i + 2 < len(chunks) else ""
        i += 3
        parts = re.split(r"\sw/\s", seg)
        main = clean_track(parts[0])
        if not main:
            continue
        overlays = [t for p in parts[1:] if (t := clean_track(p))]
        tracks.append({"pos": int(pos), "tMs": ts_ms(ts), **main, "overlays": overlays})
    # de-dup positions (linked-position noise can repeat), keep first
    seen = set()
    tracks = [t for t in tracks if not (t["pos"] in seen or seen.add(t["pos"]))]
    if len(tracks) >= 5:
        sets.append({"set": f.stem.replace("set-", ""), "tracks": tracks})

json.dump(sets, open(OUT, "w"), indent=1)
n_tracks = sum(len(s["tracks"]) for s in sets)
n_over = sum(len(t["overlays"]) for s in sets for t in s["tracks"])
n_ts = sum(1 for s in sets for t in s["tracks"] if t["tMs"] is not None)
print(f"{len(sets)} sets · {n_tracks} sequenced tracks · {n_over} overlays · {n_ts} timestamped")
print(f"wrote {OUT}")
