"""Pull the next planned workout from Garmin Connect and emit it engine-shaped.

Run via health-tracker's venv (it owns the garminconnect dependency + the
cached OAuth tokens at ~/.garminconnect):

    uv run --project ~/health-tracker python scripts/pull_next_workout.py > data/next-workout.json

Why this exists: the watch's CIQ stream can't express step IDENTITY beyond
intensity — Runna authors tempo floats as plain "interval" steps, so a
Rolling 800s day streams six indistinguishable "hard" steps. The Garmin
workout JSON carries the target speed bands, so HERE is where floats become
'easy' and efforts stay 'hard'. On the phone the watch still owns the
boundaries (wkStepSeq); this plan supplies the WHAT.
"""

import json
import os
import sys
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv
from garminconnect import Garmin

load_dotenv(Path.home() / "health-tracker" / ".env")

# A speed-targeted step is a true EFFORT only if its target midpoint is
# within 90% of the day's fastest target midpoint. Provenance: Rolling 800s
# 2026-09-01 — floats (7:45/mi) sit at 0.84 of the efforts (6:30/mi); a
# workout with two genuine effort tiers stays all-hard. GUESS until more
# workout shapes calibrate it.
EFFORT_SPEED_RATIO = 0.9

KIND_BY_STEP_TYPE = {
    "warmup": "warmup",
    "cooldown": "cooldown",
    "rest": "rest",
    "recovery": "easy",
    "interval": "hard",  # provisional — target-speed pass may demote to easy
    "other": "easy",
}


def flatten(steps):
    out = []
    for s in steps:
        if s.get("type") == "RepeatGroupDTO":
            for _ in range(int(s.get("numberOfIterations") or 1)):
                out.extend(flatten(s.get("workoutSteps", [])))
        else:
            out.append(s)
    return out


def convert(workout):
    raw = flatten(workout["workoutSegments"][0]["workoutSteps"])
    mids = []
    for s in raw:
        t1, t2 = s.get("targetValueOne"), s.get("targetValueTwo")
        if t1 and t2:
            mids.append((t1 + t2) / 2)
    fastest = max(mids) if mids else None

    steps = []
    for s in raw:
        step_type = (s.get("stepType") or {}).get("stepTypeKey") or "other"
        kind = KIND_BY_STEP_TYPE.get(step_type, "easy")
        t1, t2 = s.get("targetValueOne"), s.get("targetValueTwo")
        if kind == "hard" and t1 and t2 and fastest:
            if (t1 + t2) / 2 < EFFORT_SPEED_RATIO * fastest:
                kind = "easy"  # a float: quality pace, but not the effort
        cond = (s.get("endCondition") or {}).get("conditionTypeKey")
        val = s.get("endConditionValue")
        step = {"kind": kind}
        if cond == "distance" and val:
            step["meters"] = round(val, 2)
        elif cond == "time" and val:
            step["seconds"] = val
        steps.append(step)
    return steps


def main():
    api = Garmin(os.getenv("GARMIN_EMAIL", ""), os.getenv("GARMIN_PASSWORD", ""))
    api.login(tokenstore=os.path.expanduser("~/.garminconnect"))
    today = date.today()
    # Garmin's calendar service months are 0-indexed.
    seen = {}
    for probe in (today, today + timedelta(days=27)):
        cal = api.connectapi(f"/calendar-service/year/{probe.year}/month/{probe.month - 1}")
        for it in cal.get("calendarItems", []):
            if it.get("itemType") == "workout" and it.get("date") and it.get("workoutId"):
                # Two workouts on one date (e.g. a test scheduled after the
                # morning's run): the newest-created wins — it's the intent.
                cur = seen.get(it["date"])
                if cur is None or it["workoutId"] > cur["workoutId"]:
                    seen[it["date"]] = it
    upcoming = sorted(d for d in seen if d >= today.isoformat())
    if not upcoming:
        print("no upcoming workout found", file=sys.stderr)
        sys.exit(1)
    item = seen[upcoming[0]]
    workout = api.connectapi(f"/workout-service/workout/{item['workoutId']}")
    out = {
        "name": workout.get("workoutName") or item.get("title") or "workout",
        "date": item["date"],
        "steps": convert(workout),
    }
    json.dump(out, sys.stdout, indent=1)
    hard = sum(1 for s in out["steps"] if s["kind"] == "hard")
    easy = sum(1 for s in out["steps"] if s["kind"] == "easy")
    print(f"\n{out['name']} ({out['date']}): {len(out['steps'])} steps, {hard} hard, {easy} easy/float", file=sys.stderr)


if __name__ == "__main__":
    main()
