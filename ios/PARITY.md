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
(the native player owns playback), loop machinery, wkStep/follow mode.
It DOES have (parity law 2026-09-01: tiers move together): learned pairs,
taste (manifest 'aff', capped ±2) and energy fit (manifest 'energy',
(e−0.5)×4 capped ±2 on effort/climb moments; bpm-greater heuristic remains
the fallback for untagged tracks). Crate energies are FILE-derived,
rank-normalized 0.5–1.0 (analysis/crate_energy.py — the preview formula
saturates on full-file masters). Climb detection is altitude-delta-since-last-boundary
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

## Terrain module (2026-09-02) — TS-only, lab stage
`src/live/terrain.ts` (profile smoothing, GradeTracker-driven cue
extraction, GAP-prior arrival prediction) has NO Swift port yet: its only
consumer is `scripts/terrain-backtest.ts` (the Approach A replay lab).
Port lands with Approach B's live wiring, same-session per the parity
rule. The GAP curve is a literature prior (personal fit failed honestly:
flat-city corpus + altimeter jitter + hill-repeat effort confound).

## Streaming handoff (2026-09-03) — engine ported, executor iOS-only
`LiveEngine` option `streamingHandoff` (TS + Swift, same session): under it a
song end is the player's own roll into the advertised spare — the engine
emits a `handoff` command (no play, queue the next spare) at its modeled end
instead of a cut 1.5s early, `syncExternalPlayback` gains a `natural` flag
(a read right after a modeled end is never a skip; finding the OLD song
still playing steps the model back) and returns the commands an adoption
emits. `peekSpare` now scores taste like a real pick (Swift already did —
that was a silent divergence, closed). The EXECUTOR half — predicted-roll
verification read, `/me/player/queue` for the next spare, early/drift/
rescue outcomes — lives in `ios/Sources/SessionEngine.swift` only. The web
conductor's Spotify path (`src/spike/webapi-path.ts`) still issues plain
cuts with the option off; port the executor if the web tier ever conducts
Spotify for real.

Two Spotify behaviors are ASSUMED until the first field log says otherwise
(every outcome is recorded in the session log's `delivery` events):
1. Queue items play after a uris-context is exhausted (chain continues).
2. A new `play` with uris does NOT clear a previously queued item, so after
   a real cut the leaked item may play before the cut's spare — handled by
   adopting whatever the verification read finds, never by a skip.

## Route awareness (2026-09-06) — engine + matcher ported, SHADOW mode
`src/live/route-match.ts` → `ios/Sources/RouteMatch.swift`, `src/live/terrain.ts`
→ `ios/Sources/Terrain.swift` (the 9/2 ledger debt above is paid), and the
LiveEngine integration (LiveSample lat/lon, `routes` + `terrainDrivesMusic`
options, terrainPredictions/terrainLandings, crest-ahead rule, reactive
suppression) — all same-session, tests mirrored (5 matcher + 3 engine each
side). Both engines default to SHADOW: predictions are logged and graded
against the reactive crest detector, music untouched. Flip
`terrainDrivesMusic` only on field evidence — the route backtest
(scripts/route-backtest.ts, chronological leave-one-out over 300 GPS runs)
found cross-run summit disagreement p50 ~100m (n=28), far outside the 4s
fresh-cut window. Executor pieces are iOS-only: phone GPS in LIVE mode
(PhoneSensors.freshFix), the route library fetch (/api/routes, cached a
day), log fields (lat/lon, terrainPredictions, terrainLandings, route). The
web conductor passes no routes (matcher off). Watch tier: no positions, no
matcher — reduced surface by platform physics, as with terrain.

## Live coaching (2026-09-06) — engine ported, voice iOS-only
`src/live/coach.ts` → `ios/Sources/Coach.swift` (CoachEngine: the intent
channel beside the music — pre-rep 30s/10s, halfway, pace drift vs the
Runna target, rep end with pace and delta, recovery, HR-high on easy days,
crest/climb ahead from trusted route cues, route lock and final kilometer;
8s minimum gap; nothing from T−6s to T+3s around a drop landing).
LiveEngine's coaching view (step/hardDone/hardTotal/nextHard/entered/
crest/pAhead1k) is in both engines; `WorkoutStep.targetPaceSecPerKm` rides
from pull_next_workout.py through both step types. Tests mirrored (4 each).
Executor pieces are iOS-only: CoachVoice (AVSpeechSynthesizer; own audio
session on the Spotify tier so Spotify ducks, deck.duck on the owned tier),
the morning script fetch (/api/coach-script, today's date only), the
session-log `coach` field. The morning script itself is a Mac job
(scripts/coach_script.py → claude -p → publish-coach-script.sh). Watch tier:
no speech (CIQ) — reduced surface, as with terrain.
