#!/bin/bash
# One-time setup for the song analysis pipeline (allin1 + PyTorch).
#
# Version pins matter — this is a 2023-era ML stack:
#   - python 3.11 (torch 2.0.1 has no 3.12 wheels)
#   - torch 2.0.1 (natten 0.14.6's C++ won't compile against newer torch headers)
#   - natten 0.14.6 (newer natten renamed the APIs allin1 imports)
#   - madmom from git (PyPI release is broken on python 3.10+)
#   - numpy<2 (torch 2.0-era ABI)
set -euo pipefail
cd "$(dirname "$0")"

PY=/opt/homebrew/bin/python3.11
[ -x "$PY" ] || { echo "python3.11 not found — brew install python@3.11"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — brew install ffmpeg"; exit 1; }

[ -d .venv ] || "$PY" -m venv .venv
source .venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet "numpy<2" cython "setuptools==65.7.0" wheel
echo "installing torch 2.0.1 (large download, one time)…"
pip install --quiet torch==2.0.1 torchaudio==2.0.2
echo "installing madmom from git…"
pip install --quiet "git+https://github.com/CPJKU/madmom.git"
echo "building natten 0.14.6 from source (takes several minutes)…"
# -Wno-invalid-specialization: newer clang rejects torch 2.0's headers otherwise
CFLAGS="-Wno-invalid-specialization" CXXFLAGS="-Wno-invalid-specialization" \
  pip install --quiet "natten==0.14.6" --no-build-isolation
# torch re-pinned in the same command — allin1's deps upgrade torch otherwise,
# which breaks natten's compiled ABI (dlopen symbol errors)
pip install --quiet allin1 "torch==2.0.1" "torchaudio==2.0.2"
python -c "import allin1" || { echo "install verification failed"; exit 1; }
echo "OK — analyze with: analysis/.venv/bin/python analysis/analyze.py <files…>"
