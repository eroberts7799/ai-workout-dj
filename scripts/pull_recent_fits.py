#!/usr/bin/env python3
"""Download recent Garmin activity FIT files (the takeout stops where it was
requested; the routes Ethan runs THIS month are the ones the matcher needs).

Run via health-tracker's venv (garminconnect + cached tokens at ~/.garminconnect):
  uv run --project ~/health-tracker python scripts/pull_recent_fits.py [since YYYY-MM-DD]
Writes data/routes/fits-recent/<activityId>.fit (skips ones already there).
Default `since`: 60 days ago. Then: scripts/publish-route-library.sh rebuilds.
"""

import datetime as dt
import io
import os
import sys
import zipfile
from pathlib import Path

from garminconnect import Garmin

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "data" / "routes" / "fits-recent"
RUN_TYPES = {"running", "trail_running", "track_running", "treadmill_running"}


def main():
    since = sys.argv[1] if len(sys.argv) > 1 else (dt.date.today() - dt.timedelta(days=60)).isoformat()
    OUT.mkdir(parents=True, exist_ok=True)
    api = Garmin(os.getenv("GARMIN_EMAIL", ""), os.getenv("GARMIN_PASSWORD", ""))
    api.login(tokenstore=os.path.expanduser("~/.garminconnect"))
    acts = api.get_activities_by_date(since, dt.date.today().isoformat())
    got, skipped = 0, 0
    for a in acts:
        t = (a.get("activityType") or {}).get("typeKey", "")
        if t not in RUN_TYPES:
            continue
        aid = a["activityId"]
        dest = OUT / f"{aid}.fit"
        if dest.exists():
            skipped += 1
            continue
        blob = api.download_activity(aid, dl_fmt=api.ActivityDownloadFormat.ORIGINAL)
        # ORIGINAL is a zip carrying the .fit
        try:
            with zipfile.ZipFile(io.BytesIO(blob)) as z:
                names = [n for n in z.namelist() if n.lower().endswith(".fit")]
                if not names:
                    continue
                dest.write_bytes(z.read(names[0]))
        except zipfile.BadZipFile:
            dest.write_bytes(blob)  # some accounts get the bare FIT
        got += 1
        print(f"  {a.get('startTimeLocal', '')[:10]} {a.get('activityName', '')} → {dest.name}")
    print(f"{got} new FITs, {skipped} already present (runs since {since})")


if __name__ == "__main__":
    main()
