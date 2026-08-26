#!/bin/bash
# Store build: swap Ethan's crate default for the DEMO crate (royalty-free
# Pixabay tracks - redistributable) so a store installer hears music in
# minute one with zero configuration. Ethan's purchased-music URL must
# never ship. Build the .iq, restore the dev file (trap-guaranteed).
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
SDK=$(ls -d ~/Library/Application\ Support/Garmin/ConnectIQ/Sdks/*/bin | head -1)
cp source/WatchSync.mc /tmp/WatchSync.mc.bak
trap 'mv /tmp/WatchSync.mc.bak source/WatchSync.mc 2>/dev/null || true' EXIT
python3 - << 'PY'
import re
p = 'source/WatchSync.mc'
src = open(p).read()
DEMO = "https://xo5ag40y70msuxua.public.blob.vercel-storage.com/demo-crate/manifest-OM2deLobF67q8meGwiGMDACvCq4Nmb.json"
out = re.sub(r'const DEV_DEFAULT_MANIFEST = "[^"]*";', 'const DEV_DEFAULT_MANIFEST = "%s";' % DEMO, src)
assert 'demo-crate' in out
assert out != src, "dev default not found"
open(p, 'w').write(out)
PY
"$SDK/monkeyc" -e -f monkey.jungle -o AWDJ.iq -y ../developer_key.der -r
grep -q 'DEV_DEFAULT_MANIFEST = "https' source/WatchSync.mc && echo "dev source restored"
echo "STORE PACKAGE READY: $(pwd)/AWDJ.iq (default = demo crate)"
