#!/usr/bin/env python3
"""Learned selection weights v1 — which of OUR songs do real DJs sequence?

The crate was largely bought out of the harvested artists' sets, so the
tracklist corpus contains ground truth about which crate tracks belong next
to each other. This mines it two ways:

  ADJACENCY  crate track B played within ±2 positions of crate track A in a
             real set (direction kept: A→B ≠ B→A)
  OVERLAY    B layered "w/" over A (mashup — the strongest possible
             compatibility signal, weighted ×2)

Output: analysis/selection-weights.json
  { pairs: { "<norm A>><norm B>": weight, ... } }
where <norm X> is the lowercase alnum-word join of "artist title" — the
engines recompute the same key from SongTags name/artists at runtime, so no
id plumbing is needed and the same file serves web and phone.

Run: python3 analysis/selection_weights.py   (stdlib only)
"""

import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent


def norm(artist, title):
    words = re.findall(r"[a-z0-9]+", f"{artist} {title}".lower())
    return " ".join(words)


def clean_title(t):
    return re.split(r"\s{2,}", t.strip())[0]


def clean_artist(a):
    return re.sub(r"^w/\s*", "", a.strip())


crate = json.loads((REPO / "analysis" / "crate-analysis.json").read_text())["analysis"]
crate_norms = {}
for c in crate:
    crate_norms[norm(c["artist"], c["title"])] = (c["artist"], c["title"])


def match_crate(artist, title):
    """Corpus entry → crate norm, by word overlap (word-boundary, ≥60% of the
    smaller set — rule 4: prefer honest no-match over a poisoned edge)."""
    want = set(norm(artist, title).split())
    if not want:
        return None
    best, best_score = None, 0.0
    for cn in crate_norms:
        cw = set(cn.split())
        score = len(want & cw) / max(1, min(len(want), len(cw)))
        if score > best_score:
            best, best_score = cn, score
    return best if best_score >= 0.6 else None


corpus = json.loads((REPO / "data" / "tracklist-corpus" / "corpus.json").read_text())
pairs = Counter()
sets_with_crate = 0
for s in corpus:
    seq = []  # (pos, crate_norm) for main entries that matched
    overlays = []  # (base_norm, overlay_norm)
    for tr in s.get("tracks", []):
        base = match_crate(clean_artist(tr.get("artist", "")), clean_title(tr.get("title", "")))
        if base:
            seq.append((tr.get("pos", 0), base))
        for o in tr.get("overlays", []):
            ov = match_crate(clean_artist(o.get("artist", "")), clean_title(o.get("title", "")))
            if base and ov and base != ov:
                overlays.append((base, ov))
    if len(seq) >= 2 or overlays:
        sets_with_crate += 1
    seq.sort()
    for i, (pos_a, a) in enumerate(seq):
        for pos_b, b in seq[i + 1 :]:
            if pos_b - pos_a > 2:
                break
            if a != b:
                pairs[f"{a}>{b}"] += 1
    for base, ov in overlays:
        pairs[f"{base}>{ov}"] += 2
        pairs[f"{ov}>{base}"] += 2

out = {
    "generated": date.today().isoformat(),
    "source": f"{len(corpus)} harvested sets; {sets_with_crate} contained ≥1 crate pairing",
    "pairs": dict(pairs.most_common()),
}
dest = REPO / "analysis" / "selection-weights.json"
dest.write_text(json.dumps(out, indent=1))
print(f"{len(pairs)} learned pairs from {sets_with_crate} sets → {dest}")
for k, v in pairs.most_common(12):
    print(f"  {v}× {k}")
