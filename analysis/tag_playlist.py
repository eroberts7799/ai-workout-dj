#!/usr/bin/env python3
"""Preview-tag a scraped playlist into the enrichment table.

Input: a JSON file from /api/playlist ({name, tracks:[{name, artists,...}]})
or a library-snapshot from the relay. Each track not already in the table
goes through iTunes match → 30s preview → BPM/key/energy (virtual_crate's
machinery), and results merge into ios/Resources/track-tags.json — which
publish-tag-table.sh then pushes to every phone via the relay.

Run: analysis/.venv/bin/python analysis/tag_playlist.py <playlist.json>
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from virtual_crate import itunes, analyze_preview, norm  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TABLE = REPO / "ios" / "Resources" / "track-tags.json"

def main():
    src = json.load(open(sys.argv[1]))
    tracks = src.get("tracks", [])
    table = json.load(open(TABLE))
    added, known, failed = 0, 0, 0
    for i, t in enumerate(tracks):
        artist = t.get("artists") or t.get("artist", "")
        title = t.get("name") or t.get("title", "")
        key = f"{norm(artist)}|{norm(title)}"
        if key in table:
            known += 1
            continue
        hit = itunes(artist, title)
        if not hit or not hit.get("previewUrl"):
            failed += 1
            print(f"  {i+1:3}. ✗ no preview: {artist} — {title}")
            continue
        tags = analyze_preview(hit["previewUrl"])
        if not tags:
            failed += 1
            print(f"  {i+1:3}. ✗ analysis failed: {artist} — {title}")
            continue
        table[key] = {"bpm": tags["bpm"], "camelot": tags["camelot"], "energy": tags["energy"]}
        added += 1
        print(f"  {i+1:3}. ✓ {artist} — {title}  {tags['bpm']}bpm {tags['camelot']}")
    json.dump(table, open(TABLE, "w"), indent=0)
    print(f"\n{added} tagged, {known} already known, {failed} unmatchable · table now {len(table)} entries")

if __name__ == "__main__":
    main()
