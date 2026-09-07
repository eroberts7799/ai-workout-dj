# AI Workout DJ

Anticipatory music choreography for training. A deterministic engine reads live heart rate, GPS, and the structure of a planned workout, and lands the drop where the hill or interval starts.

Music apps react: read current effort, pick a song with matching BPM. This one anticipates. Because the training plan is known to the second and the route's elevation is known before the run starts, the engine can build toward a moment the way a DJ builds toward a drop. The music becomes the interface: the buildup starting means the hill is sixty seconds out.

Built for one runner's own training and used on real workouts since August 2026.

## How it works

- **Garmin Connect IQ data field** (`garmin/awdj-field`, Monkey C) streams heart rate, position, and workout step off the watch in real time.
- **TypeScript engine** (`src/live`, `src/conductor`) is the source of truth: workout clock, ETA to the next hill or interval, and the schedule that assigns song moments to workout moments, re-solved as pace drifts.
- **Swift port** (`ios/Sources`) runs the same engine on iPhone with a dual-deck audio player for owned music files, BLE heart rate, route matching, and a spoken coach. `ios/PARITY.md` is the ledger that keeps the two engines in step; `scripts/gen-parity-fixture.ts` generates truth cases from the TypeScript functions and `ParityTests.swift` replays every one.
- **Relay** (`relay/`) is a small Vercel service that passes the next workout, route library, and crate between the desktop tools and the phone.
- **Analysis** (`analysis/`) is Python: crate analysis (musical key, energy, structure tags), heart-rate response calibration, pace-over-grade, and the critic, `render_and_judge.py`, which judges engine changes by rendering actual audio rather than by inspection.
- **Replay Lab** (`src/replay`) replays logged real sessions through the engine so a change can be checked against runs that already happened.

Two audio tiers: owned files on the dual deck get real crossfades and blends; streaming tracks fall back to jump-cuts on musical boundaries.

## Working rules

The rules this project runs by are in `CLAUDE.md`. Each one was paid for by a real run going wrong: engine changes port to Swift in the same session or get a parity-ledger entry; "fixed" means verified on the phone build, not the copy last edited; data-tuned constants cite their evidence; engine changes ship with a critic verdict, not vibes.

## Commands

```
bun test                          # engine tests
bunx tsc --noEmit                 # typecheck
bun scripts/gen-parity-fixture.ts # regenerate the Swift parity fixture after engine changes
```

iOS builds with `xcodegen` and `xcodebuild` from `ios/`; see `ios/TESTFLIGHT.md`.

## What is not in this repo

Music files, the owner's run logs and positions, and the Garmin developer key are excluded. The code is public; the training data and the music stay with me.
