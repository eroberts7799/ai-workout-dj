# AI Workout DJ — working rules

Anticipatory music choreography: deterministic engine (TS = source of truth,
Swift port for iOS), owned-file DualDeck tier is the product, streaming is a
jump-cut funnel. Full context: design doc in `docs/`, session memory in the
agent's memory dir.

## Hard rules (each one was paid for)

1. **Two brains, one product.** Any change to `src/live/` or `src/conductor/`
   either ports to `ios/Sources/` in the same session or gets a line in
   `ios/PARITY.md`. Then run `bun scripts/gen-parity-fixture.ts` and the iOS
   test suite — `ParityTests.swift` replays TS-generated truth cases.
   (2026-08-13: a stale port looped one song for a whole real-world run.)
2. **Verify on the artifact the user touches.** "Fixed" means verified on the
   phone build / the exported bundle / the deployed relay — not on the copy
   you last edited. Claiming web-engine behavior for the phone ruined a run.
3. **Never fabricate identifiers.** URLs, store links, slugs, IDs — read them
   from API responses or saved artifacts, never reconstruct from memory.
   (Fabricated iTunes links, guessed 1001tracklists slugs — both bit.)
4. **In matchers, false positives beat false negatives — wrongly.** A dropped
   match is recoverable; a wrong match poisons everything downstream. Prefer
   honest local-only identity over a plausible external match. Require
   word boundaries, artist overlap, duration proximity. ("ten" once claimed
   every "exTENded" file; "Stay" once became the Bee Gees.)
5. **Per-field provenance when merging sources.** One record, two sources =
   every field needs an explicit truth decision. (`durationMs` was Spotify's
   while markers were the file's; never-silence math broke.)
6. **Any user-facing operation >2s shows progress.** Silent loops read as
   broken and burn user trust/time.
7. **Fix the failure class, not the instance.** After any matching/parsing
   bug: enumerate the class, test with the nastiest real data in the repo
   (actual Beatport filenames, actual Garmin exports).
8. **Constants carry provenance.** Data-tuned parameters cite their evidence
   in a comment (e.g. MIN_CLIMB_GAIN_M: 562 real runs). Invented numbers are
   marked as guesses until data replaces them.
9. **Evaluators before optimizers.** The critic (`analysis/render_and_judge.py`)
   judges engine changes by rendering actual audio; the Replay Lab replays
   real session logs. Ship engine changes with a critic verdict, not vibes.
10. **Privacy floor.** No lat/lon extraction from fitness files, friend data
    stays local-only until the cloud store has per-user auth, never
    redistribute analyzed audio.

## Commands

- Web: `bun test` (fast), `bunx tsc --noEmit`
- iOS: `cd ios && xcodegen && DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project AwdjPlayer.xcodeproj -scheme AwdjPlayerTests -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build test`
- Parity fixture: `bun scripts/gen-parity-fixture.ts` (after any beat.ts change)
- Critic: generate commands via the bun snippet pattern in git history
  ("mix-commands"), then `analysis/render_and_judge.py <commands.json>`
- Analysis venv is FRAGILE (`analysis/setup.sh` recipe) — never upgrade its
  pins; use a separate venv for new Python deps.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that doesn't match DESIGN.md.
