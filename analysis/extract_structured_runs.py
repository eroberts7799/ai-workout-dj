#!/usr/bin/env python3
"""Extract structured (Runna/Garmin-workout) runs from raw FIT files into
labeled decision-engine test cases.

Every structured run in the takeout carries three layers we need:
  - workout / workout_step messages: the PRESCRIPTIVE plan (what Runna asked
    for — duration type, meters/seconds, target speed band, step intensity)
  - lap messages with wkt_step_index: the EXECUTED truth — the exact wall
    time every step boundary actually happened
  - record messages: the 1Hz body stream (distance, HR, altitude, cadence)

The engine consumes the watch TIMER timeline (frozen during pauses), so all
times here are converted from wall clock to timer-ms via the timer
start/stop event log. A run with 9 manual pauses (seen in the wild,
2026-08-11) is ~4 minutes of wall/timer divergence — ignoring this poisons
every boundary label.

Output: data/garmin-history-structured/<date>-<id>.json
  { name, wktName, startTime, activityId, source,
    planSteps: [{kind, seconds?, meters?, open?, targetSpeedLow?, targetSpeedHigh?, notes?}],
    boundaries: [{tMs, stepIdx}],   # executed step STARTS on the timer timeline (+ final end)
    samples: [{tMs, distanceM?, hr?, altitude?, cadence?}] }

Privacy floor: no lat/lon is read or written (repo rule 10).

Run: <fitenv>/bin/python analysis/extract_structured_runs.py <fit-dir>
(stdlib + fitdecode — the fitenv from the history conversion has it; NOT the
fragile allin1 venv.)
"""

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import fitdecode

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "data" / "garmin-history-structured"

# FIT step intensity → engine step kind (src/conductor/types.ts)
KIND = {
    "warmup": "warmup",
    "active": "hard",
    "interval": "hard",
    "rest": "rest",
    "recovery": "easy",
    "cooldown": "cooldown",
}


class TimerTimeline:
    """Wall timestamp → watch timer ms, from FIT timer start/stop events."""

    def __init__(self):
        self.segments = []  # (wall_start_s, timer_ms_at_start)
        self._running_since = None
        self._timer_ms = 0

    def event(self, ts, event_type):
        t = ts.timestamp()
        if event_type == "start" and self._running_since is None:
            self.segments.append((t, self._timer_ms))
            self._running_since = t
        elif event_type in ("stop", "stop_all") and self._running_since is not None:
            self._timer_ms += (t - self._running_since) * 1000
            self._running_since = None

    def timer_ms(self, ts):
        """Timer ms at wall time ts; None if before the first start."""
        t = ts.timestamp()
        best = None
        for i, (start, timer_at) in enumerate(self.segments):
            if t < start:
                break
            seg_end = None
            # segment ends when the timer next stopped
            nxt_timer_at = self.segments[i + 1][1] if i + 1 < len(self.segments) else None
            if nxt_timer_at is not None:
                seg_end = start + (nxt_timer_at - timer_at) / 1000
            if seg_end is not None and t > seg_end:
                best = nxt_timer_at  # inside a pause: frozen at segment end
            else:
                best = timer_at + (t - start) * 1000
        return best


def extract(path):
    laps, steps, records, sport = [], [], [], None
    timeline = TimerTimeline()
    wkt_name, start_time = None, None
    try:
        with fitdecode.FitReader(path) as fr:
            for frame in fr:
                if not isinstance(frame, fitdecode.FitDataMessage):
                    continue
                n = frame.name
                if n == "sport":
                    sport = frame.get_value("sport", fallback=None)
                elif n == "session":
                    sport = sport or frame.get_value("sport", fallback=None)
                    start_time = frame.get_value("start_time", fallback=None)
                elif n == "workout":
                    wkt_name = frame.get_value("wkt_name", fallback=None)
                elif n == "workout_step":
                    steps.append({f.name: f.value for f in frame.fields if f.value is not None})
                elif n == "event":
                    if frame.get_value("event", fallback=None) == "timer":
                        ts = frame.get_value("timestamp", fallback=None)
                        et = frame.get_value("event_type", fallback=None)
                        if ts is not None and et is not None:
                            timeline.event(ts, et)
                elif n == "lap":
                    laps.append({
                        "start": frame.get_value("start_time", fallback=None),
                        "timer_s": frame.get_value("total_timer_time", fallback=None),
                        "wkt": frame.get_value("wkt_step_index", fallback=None),
                        "intensity": frame.get_value("intensity", fallback=None),
                    })
                elif n == "record":
                    records.append((
                        frame.get_value("timestamp", fallback=None),
                        frame.get_value("distance", fallback=None),
                        frame.get_value("heart_rate", fallback=None),
                        frame.get_value("enhanced_altitude", fallback=None)
                        or frame.get_value("altitude", fallback=None),
                        frame.get_value("cadence", fallback=None),
                    ))
    except Exception:
        return None
    if sport != "running" or not any(l["wkt"] is not None for l in laps):
        return None

    # Executed steps: collapse consecutive laps sharing a wkt_step_index
    # (a 2mi tempo step autolaps into 2+ laps). Trailing wkt=None laps are
    # free running after the workout finished — the session for the engine
    # ends at the workout's end.
    executed = []  # (wkt_idx, intensity, start_ts)
    for l in laps:
        if l["wkt"] is None or l["start"] is None:
            continue
        if executed and executed[-1][0] == l["wkt"]:
            continue
        executed.append((l["wkt"], l["intensity"], l["start"]))
    if len(executed) < 2:
        return None
    # Workout end = start of first trailing non-workout lap, else last record.
    end_ts = None
    for l in laps:
        if l["wkt"] is None and executed and l["start"] is not None and l["start"] > executed[-1][2]:
            end_ts = l["start"]
            break
    if end_ts is None and records:
        end_ts = records[-1][0]

    boundaries = []
    for wkt_idx, intensity, ts in executed:
        tms = timeline.timer_ms(ts)
        if tms is None:
            return None
        boundaries.append({"tMs": round(tms), "stepIdx": len(boundaries), "wktStepIndex": wkt_idx,
                           "intensity": str(intensity)})
    end_tms = timeline.timer_ms(end_ts) if end_ts is not None else None
    if end_tms is not None:
        boundaries.append({"tMs": round(end_tms), "stepIdx": len(boundaries), "end": True})

    # Plan steps in EXECUTED order, prescriptive amounts from workout_step.
    by_index = {s.get("message_index"): s for s in steps}
    plan_steps = []
    for wkt_idx, intensity, _ in executed:
        ws = by_index.get(wkt_idx, {})
        kind = KIND.get(str(ws.get("intensity", intensity)), "easy")
        step = {"kind": kind}
        if ws.get("duration_type") == "time" and ws.get("duration_time") is not None:
            step["seconds"] = ws["duration_time"]
        elif ws.get("duration_type") == "distance" and ws.get("duration_distance") is not None:
            step["meters"] = ws["duration_distance"]
        else:
            step["open"] = True  # press-lap / unknown: only wkStep truth can end it
        if ws.get("custom_target_speed_low"):
            step["targetSpeedLow"] = ws["custom_target_speed_low"]
        if ws.get("custom_target_speed_high"):
            step["targetSpeedHigh"] = ws["custom_target_speed_high"]
        if ws.get("notes"):
            step["notes"] = str(ws["notes"])[:80]
        plan_steps.append(step)

    t0 = timeline.timer_ms  # alias
    samples = []
    for ts, dist, hr, alt, cad in records:
        if ts is None:
            continue
        tms = t0(ts)
        if tms is None or (end_tms is not None and tms > end_tms + 1000):
            continue
        s = {"tMs": round(tms)}
        if dist is not None:
            s["distanceM"] = round(float(dist), 1)
        if hr is not None:
            s["hr"] = hr
        if alt is not None:
            s["altitude"] = round(float(alt), 1)
        if cad is not None:
            s["cadence"] = cad
        samples.append(s)
    if len(samples) < 60:
        return None

    activity_id = path.stem.split("_")[-1]
    day = start_time.date().isoformat() if start_time else "unknown"
    return {
        "file": f"{day}-{activity_id}.json",
        "data": {
            "name": f"{wkt_name or 'structured run'} {day}",
            "wktName": wkt_name,
            "startTime": start_time.isoformat() if start_time else None,
            "activityId": activity_id,
            "source": "garmin-fit-structured",
            "planSteps": plan_steps,
            "boundaries": boundaries,
            "samples": samples,
        },
    }


def main():
    fit_dir = Path(sys.argv[1])
    files = sorted(fit_dir.glob("*.fit"))
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    kept = 0
    with ProcessPoolExecutor(max_workers=8) as pool:
        for res in pool.map(extract, files, chunksize=32):
            if res is None:
                continue
            (OUT_DIR / res["file"]).write_text(json.dumps(res["data"]))
            kept += 1
            d = res["data"]
            print(f"{res['file']}: {d['wktName'] or '?'} — {len(d['planSteps'])} steps, "
                  f"{len(d['samples'])} samples")
    print(f"\n{kept} structured runs → {OUT_DIR}")


if __name__ == "__main__":
    main()
