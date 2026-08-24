# AWDJ Spike — the watch-tier gate experiment

One question: does `Activity.getActivityInfo()` return live data (timer,
HR, distance) inside a media provider's callbacks during a native run?
If yes → boundary-mode sensor-driven DJing on the watch is buildable
(a first — nobody has shipped it on Garmin). If `act=NULL` → the watch
tier dies and the phone stays in the pocket.

## Sideload (OpenMTP, SDK Manager must be QUIT)
1. `AWDJSPIKE.PRG` → watch `GARMIN/Apps/`
2. `AWDJSPIKE.TXT` (empty) → watch `GARMIN/Apps/LOGS/`  ← without this no logs are written

## Protocol (~10 min, wifi: watch must be on the same network as the Mac)
1. Mac: dev server running (`bun dev` / already up on 5173).
2. Watch: Settings → Music → Music Providers → **AWDJ Spike** → open it;
   the sync view requests a sync immediately (3 songs over wifi, ~25MB).
   If sync fails: check the LAN IP baked in `source/SpikeSync.mc` still
   matches `ipconfig getifaddr en0`, rebuild if not.
3. Start a **Run** activity (any plain run, GPS not required — treadmill ok).
4. Hold DOWN → music controls → source **AWDJ Spike** → play.
5. Run/walk 2–3 min. Press track-skip a couple times (each skip = a
   logged `next()` call). Pause/resume music once.
6. Stop + discard the activity, stop music.
7. OpenMTP: copy back `GARMIN/Apps/LOGS/AWDJSPIKE.TXT` → drop it in
   `~/Downloads/` and tell the session.

## Reading the verdict
`grep AWDJ AWDJSPIKE.TXT` — every line ends with the activity state:
- `timer=123456 dist=456.2 hr=142 state=1` during the run → **GATE OPEN**
- `act=NULL` (or frozen values) in `next`/`onSong` lines → gate closed;
  fall back to the recorder-app hack investigation (spike #2).

Build: `monkeyc -f monkey.jungle -d fr57042mm -o AWDJSPIKE.PRG -y ../developer_key.der`
(PATH needs /opt/homebrew/opt/openjdk/bin)
