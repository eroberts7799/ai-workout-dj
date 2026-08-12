#!/usr/bin/env python3
"""The critic: render a session's ACTUAL mix audio offline from its command
schedule (fades, bass swaps, tempo-lock — the deck's semantics), then score
every transition with objective mix-quality metrics:

  bass_mud_db    low-band energy during the overlap vs its surroundings
                 (positive = doubled bass, the classic amateur tell)
  dip_db         loudness hole at the cut (negative = the energy sagged)
  beat_jitter_ms inter-beat-interval spread across the boundary
                 (high = the groove broke)

Engine change -> render -> judge -> compare. Nobody's ears required.

Usage: render_and_judge.py mix-commands.json [--wav out.wav]
"""
import json
import sys

import numpy as np
import librosa
from scipy.signal import butter, sosfilt

SR = 22050
BASS_HZ = 180
BASS_CUT = 10 ** (-15 / 20)

doc = json.load(open(sys.argv[1]))
cmds = [c for c in doc["commands"] if c["file"]]
base = doc["dir"]

total_s = cmds[-1]["tMs"] / 1000 + 60
master = np.zeros(int(total_s * SR), dtype=np.float32)
sos = butter(2, BASS_HZ, btype="low", fs=SR, output="sos")

cache: dict[str, np.ndarray] = {}
def load(f):
    if f not in cache:
        cache[f], _ = librosa.load(f"{base}/{f}", sr=SR, mono=True)
    return cache[f]

def place(seg, at_s, fade_in_s, fade_out_at_s=None, fade_out_s=0.5):
    n = len(seg)
    env = np.ones(n, dtype=np.float32)
    fi = min(n, int(fade_in_s * SR))
    if fi > 0:
        env[:fi] = np.linspace(0, 1, fi)
    if fade_out_at_s is not None:
        fo_start = int(fade_out_at_s * SR)
        fo_len = min(n - fo_start, int(fade_out_s * SR)) if fo_start < n else 0
        if fo_len > 0:
            env[fo_start : fo_start + fo_len] = np.linspace(1, 0, fo_len)
            env[fo_start + fo_len :] = 0
    start = int(at_s * SR)
    end = min(len(master), start + n)
    master[start:end] += (seg * env)[: end - start]

for i, c in enumerate(cmds):
    t = c["tMs"] / 1000
    fade = max(0.05, c["fadeSec"])
    nxt = cmds[i + 1] if i + 1 < len(cmds) else None
    seg_dur = ((nxt["tMs"] / 1000) if nxt else total_s - 10) - t + (max(0.05, nxt["fadeSec"]) if nxt else 0) + 0.2
    y = load(c["file"])
    p0 = int(c["positionMs"] / 1000 * SR)
    seg = y[p0 : p0 + int(seg_dur / c["rate"] * SR)].copy()
    if abs(c["rate"] - 1) > 0.001 and len(seg) > SR:
        seg = librosa.effects.time_stretch(seg, rate=c["rate"])
    seg = seg[: int(seg_dur * SR)]
    if c["bassSwap"] and len(seg) > 0:
        # incoming enters bass-cut; low end restored just past mid-blend
        low = sosfilt(sos, seg).astype(np.float32)
        high = seg - low
        g = np.full(len(seg), 1.0, dtype=np.float32)
        half = int(fade * 0.5 * SR)
        ramp_end = min(len(seg), half + int(0.35 * SR))
        g[:half] = BASS_CUT
        if ramp_end > half:
            g[half:ramp_end] = np.linspace(BASS_CUT, 1, ramp_end - half)
        seg = high + low * g
    fade_out_at = (nxt["tMs"] / 1000 - t) if nxt else seg_dur - 1
    place(seg, t, fade, fade_out_at, max(0.05, nxt["fadeSec"]) if nxt else 1)

peak = np.max(np.abs(master)) or 1
master /= peak

if "--wav" in sys.argv:
    import soundfile as sf
    sf.write(sys.argv[sys.argv.index("--wav") + 1], master, SR)

# ---- judge every transition ----
def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(x**2)) + 1e-9)

print(f"{'t':>6} {'bass_mud':>9} {'dip':>7} {'jitter':>7}  transition")
rows = []
for i, c in enumerate(cmds[1:], 1):
    t = c["tMs"] / 1000
    fade = max(0.2, c["fadeSec"])
    a, b = int((t - 4) * SR), int((t + fade + 4) * SR)
    if a < 0 or b > len(master):
        continue
    win = master[a:b]
    ov = master[int(t * SR) : int((t + fade) * SR)]
    ctx = np.concatenate([master[a : int(t * SR)], master[int((t + fade) * SR) : b]])
    low_ov = sosfilt(sos, ov)
    low_ctx = sosfilt(sos, ctx)
    bass_mud = rms_db(low_ov) - rms_db(low_ctx)
    hop = int(0.2 * SR)
    frames = [rms_db(ov[j : j + hop]) for j in range(0, max(1, len(ov) - hop), hop)] or [rms_db(ov)]
    dip = min(frames) - rms_db(ctx)
    try:
        _, beats = librosa.beat.beat_track(y=win, sr=SR, trim=False)
        ibis = np.diff(librosa.frames_to_time(beats, sr=SR)) * 1000
        jitter = float(np.std(ibis)) if len(ibis) > 4 else float("nan")
    except Exception:
        jitter = float("nan")
    rows.append((t, bass_mud, dip, jitter, c["reason"][:48]))
    print(f"{t:6.0f} {bass_mud:+8.1f}dB {dip:+6.1f}dB {jitter:6.1f}ms  {c['reason'][:48]}")

bm = [r[1] for r in rows]
dp = [r[2] for r in rows]
jt = [r[3] for r in rows if not np.isnan(r[3])]
print(f"\nMEANS  bass_mud {np.mean(bm):+.1f}dB (target <= +1)  dip {np.mean(dp):+.1f}dB (target >= -6)  jitter {np.mean(jt):.0f}ms (target < 15)")
