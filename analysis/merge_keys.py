#!/usr/bin/env python3
"""Merge crate-keys.json (librosa key detection) into an analyze.py output
file, matching entries by sourceFile. Run after both have been produced:

  python3 merge_keys.py crate-analysis.json crate-keys.json
"""
import json
import sys

analysis_path, keys_path = sys.argv[1], sys.argv[2]
doc = json.load(open(analysis_path))
keys = json.load(open(keys_path))

merged = 0
for entry in doc.get("analysis", []):
    k = keys.get(entry.get("sourceFile", ""))
    if k:
        entry["camelot"] = k["camelot"]
        entry["key"] = k["key"]
        merged += 1

json.dump(doc, open(analysis_path, "w"), indent=1)
print(f"merged keys into {merged}/{len(doc.get('analysis', []))} entries")
