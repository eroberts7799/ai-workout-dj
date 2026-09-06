#!/usr/bin/env python3
"""Write today's coaching script — the coach who read your workout, your
last runs and your sleep before you woke up (v1 of live coaching).

Inputs: data/next-workout.json (the 05:00 pull), the relay's recent iOS
session logs (pace, HR, landings), and the health tracker's last nights
(sleep) when available. Claude (`claude -p`, headless) writes SHORT spoken
lines for the slots the CoachEngine fills at engine-picked moments —
timing stays deterministic on the phone; only the wording is written here.

Output: data/coach-script.json → published to the private relay path
(scripts/publish-coach-script.sh). The phone ignores scripts whose date
isn't today.

Run: python3 scripts/coach_script.py
"""

import datetime as dt
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RELAY = "https://awdj-relay.vercel.app/api/sessions?k=awdj-7g2k9x"
OUT = REPO / "data" / "coach-script.json"


def fetch(url, timeout=60):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def recent_runs(n=3):
    """Compact summaries of the last n phone-conducted runs."""
    out = []
    try:
        sessions = [s for s in fetch(RELAY) if "-ios-" in s["pathname"] and s.get("size", 0) > 20_000][:n]
        for s in sessions:
            log = fetch(f"{RELAY}&file={s['pathname']}")
            samples = log.get("samples", [])
            hrs = [x["hr"] for x in samples if x.get("hr")]
            dist = max((x.get("distanceM") or 0) for x in samples) if samples else 0
            secs = (samples[-1]["tMs"] - samples[0]["tMs"]) / 1000 if len(samples) > 1 else 0
            out.append({
                "date": s["pathname"].split("/")[1][:10],
                "name": log.get("name"),
                "km": round(dist / 1000, 1),
                "paceSecPerKm": round(secs / dist * 1000) if dist > 500 else None,
                "avgHr": round(sum(hrs) / len(hrs)) if hrs else None,
                "landings": len(log.get("landings", [])),
            })
    except Exception as e:  # the script is a nicety; never block the morning job
        print(f"recent runs unavailable: {e}", file=sys.stderr)
    return out


def sleep_summary():
    """Last two nights from the health tracker, if its query tool exists."""
    q = Path.home() / "health-tracker" / "ask.py"
    if not q.exists():
        return None
    try:
        r = subprocess.run(
            ["uv", "run", "--project", str(q.parent), "python", str(q), "sleep hours and readiness for the last 2 nights, one line"],
            capture_output=True, text=True, timeout=60, cwd=q.parent)
        return r.stdout.strip()[:300] or None
    except Exception:
        return None


def main():
    workout = json.load(open(REPO / "data" / "next-workout.json"))
    today = dt.date.today().isoformat()
    steps = workout.get("steps", [])
    hard = [s for s in steps if s.get("kind") == "hard"]
    context = {
        "date": today,
        "workout": {"name": workout.get("name"), "date": workout.get("date"), "steps": steps, "efforts": len(hard)},
        "recentRuns": recent_runs(),
        "sleep": sleep_summary(),
    }
    prompt = f"""You are Ethan's running coach speaking in his earbuds during today's run. Write the SPOKEN lines for these slots as JSON only (no prose, no markdown):
{{
  "opening": one sentence spoken 12s into the run (readiness: sleep, what today is for; max 18 words),
  "pre30": [{len(hard)} strings, one per effort, spoken 30s before each effort starts; may use {{what}} (e.g. "800 meters"), {{target}} (pace like 3:20), {{n}}, {{total}}; max 12 words each],
  "repEnd": [{len(hard)} strings, one per effort, spoken when it ends; may use {{n}}, {{total}}, {{pace}}, {{delta}} (e.g. "5 seconds under target."), {{hr}}; max 14 words each],
  "halfway": [{len(hard)} strings, spoken halfway through each effort; may use {{hr}}, {{n}}; max 8 words each],
  "final": one short line for the final kilometer (max 8 words),
  "hrHigh": one line when heart rate runs high outside efforts; may use {{hr}} (max 12 words)
}}
Style: calm, specific, no hype, no exclamation marks, second person, numbers as digits. If there are 0 efforts, give empty arrays and make "opening" and "final" carry the day's intent. Context: {json.dumps(context)}"""
    r = subprocess.run(["claude", "-p", prompt], capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        sys.exit(f"claude -p failed: {r.stderr[:300]}")
    text = r.stdout.strip()
    start, end = text.find("{"), text.rfind("}")
    script = json.loads(text[start:end + 1])
    script["date"] = today
    script["workout"] = workout.get("name")
    OUT.write_text(json.dumps(script, ensure_ascii=False, indent=1))
    print(f"coach script for {today}: {script.get('opening')!r} · {len(script.get('pre30', []))} efforts")


if __name__ == "__main__":
    main()
