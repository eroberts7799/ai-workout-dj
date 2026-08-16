# Engine parity ledger — two brains, one product

The TypeScript engine (`src/live/`, `src/conductor/`) is the source of truth.
The Swift port must match it. **Every TS engine change either ports to Swift
in the same session or gets a line here.** Drift ships field failures — the
2026-08-13 morning run looped one song for the whole workout because
freshness + selection existed only in TS.

Mechanical guard: `bun scripts/gen-parity-fixture.ts` regenerates
`ios/Tests/parity-fixture.json` from the TS functions; `ParityTests.swift`
replays every case against `BeatMath`. Regenerate after any `beat.ts` change.

## Current parity debt (Swift missing vs TS)

- [ ] Crest/HR rules (GradeTracker, HrTracker, crest reward + 30m data-tuned
      gain bar). Blocker: iOS RelayPoller doesn't parse `altitude` yet.
      2026-08-16: web HrTracker now runs with a CALIBRATED per-athlete hrMax
      (analysis/hr_calibration.py — ethan 197, not the invented 190).
      Delivery to the phone is already wired: bundles carry `hrMax`, import
      stores it at UserDefaults `awdj.hrMax`. The rules port must read that
      key (fallback DEFAULT 190), never hardcode.
- [ ] Static-conductor path: freshness in `ensureCoverage` (web TODO too —
      an all-easy static schedule still loops one song on both platforms;
      LIVE mode unaffected).
- [ ] Deck: web LocalDeck holds outgoing at full volume until the beat-wait
      cut moment; verify DualDeck's delayed-fade path matches exactly.

## Ported and guarded

- [x] BeatMath: grid delays, tempo lock, blend plan, camelot, mixScore,
      deck opts (ParityTests, 31 fixture cases)
- [x] LiveEngine: freshness (maxFillRideMs), DJ-crate selection with
      recency penalty, beat-snapped buildups
- [x] DualDeck: tempo-locked blends, bar cuts, bass swap
