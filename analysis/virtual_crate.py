#!/usr/bin/env python3
"""Virtual crate builder v1 — the candidate pool for music picking.

"Spotify has millions; which few hundred could play today?" This ranks
every track in the harvested DJ-set corpus by (a) how many real sets it
appears in and (b) how often it plays ADJACENT to a seed track — songs
already in Ethan's crate (and, when exported, his Liked Songs). The top
candidates are verified against iTunes Search (real links/previews only —
rule 3) and tagged from the actual preview audio: BPM, key/camelot
(Krumhansl, as in detect_keys.py), and an energy proxy (RMS + onset rate).

Output: analysis/virtual-crate.json — a tagged candidate library. The
Tagger later resolves Spotify URIs on import with the strict credible-match
rules (rule 4: false positives poison; local-only identity beats a wrong
match). No URIs are guessed here.

Run: analysis/.venv/bin/python analysis/virtual_crate.py [--limit N]
     [--seeds extra-seeds.json]   (librosa needs the analysis venv)
extra-seeds.json: [{"artist": "...", "title": "..."}] — e.g. a Liked
Songs export. Optional; the crate is always seeded.
"""

import json
import re
import sys
import tempfile
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CORPUS = REPO / "data" / "tracklist-corpus" / "corpus.json"
CRATE = REPO / "analysis" / "crate-analysis.json"
OUT = REPO / "analysis" / "virtual-crate.json"
LIMIT = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else 150

# Adjacency window: a DJ playing X within one slot of a seed is a direct
# mixability vote; overlays ("w/") are the strongest signal (simultaneous).
ADJ_BONUS = 3.0
OVERLAY_BONUS = 5.0
SET_FREQ_WEIGHT = 1.0


def norm(s):
    s = re.sub(r"\((?:extended|original|club|radio)[^)]*\)", "", s.lower())
    s = re.sub(r"\s*(?:feat|ft)\.?\s.*", "", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def key_of(artist, title):
    return f"{norm(artist)}|{norm(title)}"


def load_seeds():
    seeds = set()
    crate = json.load(open(CRATE))["analysis"]
    for e in crate:
        seeds.add(key_of(e.get("artist", ""), e.get("title", "")))
    if "--seeds" in sys.argv:
        extra = json.load(open(sys.argv[sys.argv.index("--seeds") + 1]))
        # Accepts [{artist,title}] or a Tagger library dump {trackId: SongTags}
        entries = extra.values() if isinstance(extra, dict) else extra
        for e in entries:
            seeds.add(key_of(e.get("artist") or e.get("artists", ""), e.get("title") or e.get("name", "")))
    return seeds


def rank(corpus, seeds):
    score = defaultdict(float)
    sets_seen = defaultdict(set)
    meta = {}  # key -> display artist/title (first sighting wins)
    for s in corpus:
        tracks = s["tracks"]
        keys = [key_of(t["artist"], t["title"]) for t in tracks]
        for i, t in enumerate(tracks):
            k = keys[i]
            meta.setdefault(k, {"artist": t["artist"], "title": t["title"]})
            sets_seen[k].add(s["set"])
            neighbors = keys[max(0, i - 1) : i] + keys[i + 1 : i + 2]
            if any(n in seeds for n in neighbors):
                score[k] += ADJ_BONUS
            for o in t.get("overlays", []):
                ok = key_of(o["artist"], o["title"])
                meta.setdefault(ok, {"artist": o["artist"], "title": o["title"]})
                sets_seen[ok].add(s["set"])
                if k in seeds:
                    score[ok] += OVERLAY_BONUS
                if ok in seeds:
                    score[k] += OVERLAY_BONUS
    for k, ss in sets_seen.items():
        score[k] += SET_FREQ_WEIGHT * len(ss)
    ranked = [
        {**meta[k], "key": k, "score": round(score[k], 1), "sets": len(sets_seen[k])}
        for k in score
        if k not in seeds
        and len(sets_seen[k]) >= 2  # one sighting = noise
        # "ID" = 1001tracklists' unidentified-track placeholder, not a song
        and norm(meta[k]["title"]) != "id" and norm(meta[k]["artist"]) != "id"
    ]
    ranked.sort(key=lambda r: -r["score"])
    return ranked


def itunes(artist, title):
    """Credible iTunes match or None — word-boundary artist overlap required."""
    q = urllib.parse.quote(f"{artist} {title}")
    url = f"https://itunes.apple.com/search?term={q}&media=music&limit=5"
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            hits = json.load(r).get("results", [])
    except Exception:
        return None
    a_words = set(norm(artist).split())
    t_norm = norm(title)
    for h in hits:
        if not (set(norm(h.get("artistName", "")).split()) & a_words):
            continue
        if norm(h.get("trackName", "")) not in (t_norm,) and t_norm not in norm(h.get("trackName", "")):
            continue
        return h
    return None


def analyze_preview(url):
    """BPM, camelot, energy proxy from the 30s preview. None on any failure."""
    try:
        import numpy as np
        import librosa

        with urllib.request.urlopen(url, timeout=20) as r:
            data = r.read()
        with tempfile.NamedTemporaryFile(suffix=".m4a") as f:
            f.write(data)
            f.flush()
            y, sr = librosa.load(f.name, sr=22050, mono=True)
        tempo = float(librosa.beat.tempo(y=y, sr=sr)[0])
        # Krumhansl profiles, as in detect_keys.py
        maj = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        mino = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        best = (-1.0, None, None)
        for shift in range(12):
            rolled = np.roll(chroma, -shift)
            for prof, is_major in ((maj, True), (mino, False)):
                r_ = float(np.corrcoef(rolled, prof)[0, 1])
                if r_ > best[0]:
                    best = (r_, shift, is_major)
        notes = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
        cam_maj = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
        cam_min = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]
        note, is_major = best[1], best[2]
        camelot = (cam_maj if is_major else cam_min)[note]
        key = notes[note] + ("" if is_major else "m")
        # Energy proxy: loudness + rhythmic density. KNOWN v1 GAPS: constants
        # are guesses (saturate at 1.0 on loud masters — recalibrate against
        # the analyzed crate before ranking on energy), and beat.tempo on 30s
        # previews half-time-folds bass-heavy tracks (Rumble → 69.8). Sanity
        # signals only until calibrated.
        rms = float(np.mean(librosa.feature.rms(y=y)))
        onset = float(np.mean(librosa.onset.onset_strength(y=y, sr=sr)))
        energy = round(min(1.0, rms * 6 + onset / 8), 2)
        return {"bpm": round(tempo, 1), "key": key, "camelot": camelot, "energy": energy}
    except Exception:
        return None


def main():
    corpus = json.load(open(CORPUS))
    seeds = load_seeds()
    ranked = rank(corpus, seeds)
    print(f"{len(corpus)} sets → {len(ranked)} candidate tracks (seeds: {len(seeds)}); tagging top {LIMIT}")
    out = []
    for i, c in enumerate(ranked[:LIMIT]):
        hit = itunes(c["artist"], c["title"])
        if not hit:
            print(f"  {i+1:3}. ✗ no credible iTunes match: {c['artist']} — {c['title']}")
            continue
        tags = analyze_preview(hit["previewUrl"]) if hit.get("previewUrl") else None
        out.append({
            "artist": c["artist"],
            "title": c["title"],
            "score": c["score"],
            "sets": c["sets"],
            "itunesArtist": hit.get("artistName"),
            "itunesTitle": hit.get("trackName"),
            "itunesUrl": hit.get("trackViewUrl"),
            "durationMs": hit.get("trackTimeMillis"),
            "preview": hit.get("previewUrl"),
            **(tags or {}),
        })
        note = f"{tags['bpm']}bpm {tags['camelot']} e={tags['energy']}" if tags else "no preview tags"
        print(f"  {i+1:3}. ✓ {c['artist']} — {c['title']}  [{c['sets']} sets, {c['score']}]  {note}")
    json.dump({
        "generatedFrom": {"sets": len(corpus), "seeds": len(seeds)},
        "caveats": "preview BPM sits on librosa's coarse tempo grid (~±3, half-time folds possible) — "
                   "curation-grade only; energy proxy uncalibrated. True analysis happens if a track "
                   "is bought and run through allin1.",
        "tracks": out,
    }, open(OUT, "w"), indent=1)
    print(f"\nwrote {OUT} — {len(out)} verified candidates")


if __name__ == "__main__":
    main()
