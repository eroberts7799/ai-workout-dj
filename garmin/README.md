# Garmin Connect IQ field — AI Workout DJ

Streams live workout data (HR, GPS, elevation, timer) from the watch to the
conductor, and auto-starts the music session the instant you press start.

## Status

Source is ready; manifest targets fr570 (Forerunner 570)
(target: Forerunner 570, device id fr570).

## Setup (once we know the watch model)

1. Install the Connect IQ SDK: https://developer.garmin.com/connect-iq/sdk/
   (SDK manager installs `monkeyc` and the device files)
2. Generate a developer key: `openssl genrsa -out developer_key.pem 4096`
   then convert per SDK docs (or let VS Code's Monkey C extension do it).
3. Build: `monkeyc -f monkey.jungle -d <device_id> -o awdj.prg -y developer_key.der`
4. Sideload: plug the watch in via USB, copy `awdj.prg` to `GARMIN/APPS/`.
5. On the watch: add the "AI DJ" data field to your run activity's data screen.
6. In Garmin Connect (phone) → Connect IQ fields → AI DJ → settings → set
   `endpoint` to `http://<your-Mac-LAN-IP>:5173/api/garmin`
   (find the IP with `ipconfig getifaddr en0`; Mac and phone must share wifi).

## How the sync works

Pressing start on the watch fires `onTimerStart` → posted within ~a second →
the conductor reads the included timer value and backdates its clock, so music
t=0 aligns with your actual button press, not with message arrival.
