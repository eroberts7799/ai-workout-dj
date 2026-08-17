#!/usr/bin/env python3
"""Crate shopping list — corpus-proven candidates, store-verified.

Ranks every track across the harvested 1001tracklists corpus by how many
real DJ sets it appears in (main entries AND "w/" overlay layers), drops
what the crate already owns, then verifies the top candidates against the
iTunes Search API — real store links and 30s previews only (rule 3: never
reconstruct URLs), with BPM estimated from the actual preview audio.

Output: docs/crate-shopping-<date>.md — Ethan buys the extended mixes on
Beatport by searching the verified artist/title (Beatport links are NOT
fabricated here).

Run: analysis/.venv/bin/python analysis/crate_shopping.py [--limit N]
(librosa lives in the analysis venv; network: iTunes API + previews.)
"""

import json
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LIMIT = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 28


def norm_title(t):
    # 1001tl appends the label after a run of spaces: "TITLE  LABEL/..."
    t = re.split(r"\s{2,}", t.strip())[0]
    return re.sub(r"\s+", " ", t).strip()


def norm_artist(a):
    a = re.sub(r"^w/\s*", "", a.strip())
    return re.sub(r"\s+", " ", a).strip()


def key_of(artist, title):
    return (norm_artist(artist).lower(), norm_title(title).lower())


corpus = json.loads((REPO / "data" / "tracklist-corpus" / "corpus.json").read_text())
counts = Counter()
display = {}
by_set = defaultdict(set)
for s in corpus:
    sid = s.get("set")
    for tr in s.get("tracks", []):
        entries = [(tr.get("artist", ""), tr.get("title", ""))]
        entries += [(o.get("artist", ""), o.get("title", "")) for o in tr.get("overlays", [])]
        for artist, title in entries:
            if not artist or not title or "ID -" in title or artist.lower() == "id":
                continue
            k = key_of(artist, title)
            if sid in by_set[k]:
                continue
            by_set[k].add(sid)
            counts[k] += 1
            display.setdefault(k, (norm_artist(artist), norm_title(title)))

# What the crate already owns — match on word overlap, honest and loose
# enough to catch remix-name drift (rule 4: a false "you own this" hides a
# good buy; a false "you don't" just re-surfaces something to skip by eye).
crate = json.loads((REPO / "analysis" / "crate-analysis.json").read_text())["analysis"]
owned_words = [set(re.findall(r"[a-z0-9]+", f"{c['artist']} {c['title']}".lower())) for c in crate]


def owned(k):
    words = set(re.findall(r"[a-z0-9]+", f"{k[0]} {k[1]}"))
    return any(len(words & ow) >= max(3, int(0.6 * len(words))) for ow in owned_words)


candidates = [(k, n) for k, n in counts.most_common() if n >= 2 and not owned(k)]
print(f"{len(counts)} distinct tracks in corpus · {len(candidates)} unowned candidates seen ≥2 sets")


def itunes(artist, title):
    term = urllib.parse.quote(f"{artist} {title}")
    url = f"https://itunes.apple.com/search?term={term}&entity=song&limit=5"
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            results = json.load(r).get("results", [])
    except Exception:
        return None
    want = set(re.findall(r"[a-z0-9]+", f"{artist} {title}".lower()))
    best, best_score = None, 0.0
    for it in results:
        got = set(re.findall(r"[a-z0-9]+", f"{it.get('artistName','')} {it.get('trackName','')}".lower()))
        score = len(want & got) / max(1, len(want))
        if score > best_score:
            best, best_score = it, score
    if best is None or best_score < 0.5:
        return None  # honest no-match
    return best


def preview_bpm(url):
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            data = r.read()
        with tempfile.NamedTemporaryFile(suffix=".m4a", delete=False) as f:
            f.write(data)
            path = f.name
        import librosa

        y, sr = librosa.load(path, sr=22050, mono=True)
        tempo = librosa.beat.tempo(y=y, sr=sr)[0]
        # fold octave errors into the dance range
        while tempo < 100:
            tempo *= 2
        while tempo > 160:
            tempo /= 2
        return round(float(tempo), 1)
    except Exception:
        return None


rows = []
for k, n in candidates:
    if len(rows) >= LIMIT:
        break
    artist, title = display[k]
    hit = itunes(artist, title)
    if hit is None:
        rows.append({"artist": artist, "title": title, "sets": n, "verified": False})
        continue
    bpm = preview_bpm(hit["previewUrl"]) if hit.get("previewUrl") else None
    rows.append({
        "artist": artist,
        "title": title,
        "sets": n,
        "verified": True,
        "storeName": f"{hit.get('artistName')} — {hit.get('trackName')}",
        "url": hit.get("trackViewUrl"),
        "preview": hit.get("previewUrl"),
        "bpm": bpm,
    })
    print(f"  {n}× {artist} — {title}  →  {'✓ ' + str(bpm) + 'bpm' if bpm else '✓ (no preview bpm)'}")

out = REPO / "docs" / f"crate-shopping-{date.today().isoformat()}.md"
lines = [
    f"# Crate shopping list · {date.today().isoformat()}",
    "",
    f"Corpus-proven: every candidate appears in ≥2 of the {len(corpus)} harvested real sets",
    "(Fred again.., Sammy Virji, John Summit, Dom Dolla, Interplanetary Criminal)",
    "and is not already in the 25-track crate. Store links + previews are from the",
    "iTunes Search API (never reconstructed); BPM is estimated from the actual",
    "30s preview. **Buy the EXTENDED MIX on Beatport by searching artist + title.**",
    "Target band for the current crate: 118–132bpm.",
    "",
    "| sets | artist — title | preview BPM | iTunes (verify/listen) |",
    "|---|---|---|---|",
]
for r in rows:
    if r["verified"]:
        bpm = f"{r['bpm']}" if r.get("bpm") else "—"
        lines.append(f"| {r['sets']} | {r['artist']} — {r['title']} | {bpm} | [{r['storeName']}]({r['url']}) |")
    else:
        lines.append(f"| {r['sets']} | {r['artist']} — {r['title']} | — | no confident iTunes match — search Beatport directly |")
lines += [
    "",
    "After buying: drop files in ~/Downloads/awdj-music → run the allin1 pipeline",
    "(analysis/setup.sh venv) → Tagger: Import analysis JSON → attach audio →",
    "export bundle. Segments now ride along automatically.",
]
out.write_text("\n".join(lines))
print(f"\nwrote {out} ({sum(1 for r in rows if r['verified'])} verified / {len(rows)} listed)")
