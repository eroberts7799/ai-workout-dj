#!/bin/bash
# Store build: null the dev crate default (shipping Ethan's music URL to
# every installer would be distribution), build the .iq, restore the file.
set -euo pipefail
cd "$(dirname "$0")"
export PATH=/opt/homebrew/opt/openjdk/bin:$PATH
SDK=$(ls -d ~/Library/Application\ Support/Garmin/ConnectIQ/Sdks/*/bin | head -1)
cp source/WatchSync.mc /tmp/WatchSync.mc.bak
python3 - << 'PY'
import re
p = 'source/WatchSync.mc'
src = open(p).read()
out = re.sub(r'const DEV_DEFAULT_MANIFEST = "[^"]*";', 'const DEV_DEFAULT_MANIFEST = null;', src)
assert out != src, "dev default not found"
open(p, 'w').write(out)
PY
"$SDK/monkeyc" -e -f monkey.jungle -o AWDJ.iq -y ../developer_key.der -r
mv /tmp/WatchSync.mc.bak source/WatchSync.mc
grep -q 'DEV_DEFAULT_MANIFEST = "https' source/WatchSync.mc && echo "dev source restored"
echo "STORE PACKAGE READY: $(pwd)/AWDJ.iq (dev default stripped)"
