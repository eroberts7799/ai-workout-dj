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

- [x] Crest/HR rules PORTED 2026-08-21 (Rules.swift, forced by the 17mi
      trail run): GradeTracker + HrTracker decision-for-decision, calibrated
      hrMax from UserDefaults `awdj.hrMax` (fallback 190), crest block in
      both drop styles, altitude flows from the relay AND the new phone
      sensors (PhoneSensors.swift — offline trail mode). 2 mirror tests.
- [ ] Static-conductor path: freshness in `ensureCoverage` (web TODO too —
      an all-easy static schedule still loops one song on both platforms;
      LIVE mode unaffected).
- [ ] Deck: web LocalDeck holds outgoing at full volume until the beat-wait
      cut moment; verify DualDeck's delayed-fade path matches exactly.

- [ ] Beat-snapped commit entries: TS snaps buildup entry positions to the
      incoming song's grid (snapToBeat in fill/ride/re-aim commits); Swift
      LiveEngine uses unsnapped positions — BeatMath has no snapToBeat port.
      (Found 2026-08-16 during the decision-engine port; the ledger previously
      claimed this was ported. It was not.)

## Ported and guarded

- [x] BeatMath: grid delays, tempo lock, blend plan, camelot, mixScore,
      deck opts (ParityTests, 31 fixture cases)
- [x] LiveEngine: freshness (maxFillRideMs), DJ-crate selection with
      recency penalty
- [x] LiveEngine decision core 2026-08-16 (same-session port, 4 new
      port-parity tests): wkStepSeq watch-driven step tracking +
      boundaryEstimate interpolation, non-compounding distance advance,
      next-rep anticipation (hard→hard buildups), opening-hard drop,
      mid-build funnel re-aim. Backtest on 41 real structured runs went
      88%→95-98% on-time, max error 34.8s→3-5s, 0 missed.
- [x] Cruise listening model 2026-08-16 (same-session port): loop-backs
      removed entirely — songs play through, chains at song end / ~3min
      freshness, buildup commits watched every tick from cruise AND ride.
      Critic: 51→19 transitions per session, landings unchanged. Known
      open: freshness chains can land mid-breakdown (dip −9.6dB) —
      energy-aware chain points from analysis segments are the next rung.
- [x] DualDeck: tempo-locked blends, bar cuts, bass swap

## Watch tier (garmin/awdj-watch) — DELIBERATELY REDUCED surface, not a port
The Monkey C Brain is boundary-mode only (the platform physics: code runs
only at song boundaries, no mid-song cuts). It mirrors EXACTLY: mixScore
(+2 bpm≤3%, +1 camelot-compatible), camelotCompatible, recency -1 (last 6),
hrMax 197. It does NOT have: buildups/drops, chain points, never-silence
(the native player owns playback), loop machinery, wkStep/follow mode,
learned pairs (yet). Climb detection is altitude-delta-since-last-boundary
(CLIMB_GAIN_M 8m, GUESS) — not GradeTracker. Engine changes to selection
scoring in TS must consider Brain.mc; everything else is out of its scope
by design.

## SyntheticRunner divergence (2026-08-31)
Swift `syntheticSamples` now emits the watch-style step stream (wkStepSeq +
wkKind/duration/wkNextKind) so the in-app Simulate exercises FOLLOW MODE —
the same engine path a real structured run drives. TS `src/replay/simulate.ts`
still emits bare t/d samples (its consumers replay logged runs or drive
plan-loaded engines). Port the wk-stream emission to TS if the replay lab
ever needs to simulate follow mode.
