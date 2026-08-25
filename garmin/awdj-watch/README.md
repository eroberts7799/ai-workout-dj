# AWDJ watch tier — sensor-driven selection on the wrist

First ever on Garmin (research found zero prior art). Boundary-mode: at
every song end/skip the Brain reads live timer/HR/altitude (spike-proven)
and picks the next song by mix compatibility + freshness + effort state.

Sideload: AWDJWATCH.PRG → GARMIN/Apps/, empty AWDJWATCH.TXT →
GARMIN/Apps/LOGS/ (log enable). Open provider → auto-syncs manifest + 15
crate tracks from the Mac (dev server up, same wifi, IP baked in
WatchSync.mc — rebuild on network change). START = play.

Build: monkeyc -f monkey.jungle -d fr57042mm -o AWDJWATCH.PRG -y ../developer_key.der
