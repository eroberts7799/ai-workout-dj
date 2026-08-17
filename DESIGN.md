# Design System — AWDJ "Field Manual"

## Product Context
- **What this is:** AI Workout DJ — anticipatory music choreography. This doc governs the web lab (Vite + React): Tagger, Conduct, Replay, Spike panels — an instrument the builder uses to tag tracks, conduct live sessions, and replay real workouts.
- **Who it's for:** The founder/DJ today; serious training-focused users later.
- **Space/industry:** Pro-audio / DJ tools × fitness. Peers: Serato, rekordbox, djay (all dark + chrome), Endel (dark wellness), WHOOP/Strava (loud fitness).
- **Project type:** Web app (instrument/control surface), iOS app is a separate surface (same spirit applies).
- **The memorable thing (every decision serves this):** "The music knew what was coming before I did." Expressed with grit, not polish: the interface is issued equipment — simple, gritty, clear.

## Aesthetic Direction
- **Direction:** Field Manual — military-hardcore, Rogue-Fitness-adjacent. Paper, ink, and olive drab. Grit from type weight, stamps, and grain — not darkness, not decoration.
- **Decoration level:** Intentional — paper-grain overlay (opacity ~.045, multiply), olive hazard-stripe dividers (repeating-linear-gradient -45°), stamp-style status labels. Nothing else.
- **Mood:** A printed field manual for a machine that already knows the next move. Blunt, functional, slightly severe. States snap like switches.
- **HARD RULE (user law, non-negotiable):** NO stacked boxes/cards, no rounded panels, no drop shadows, no toasts. Structure = 4px ink section bars, 1px seam rules, type scale, whitespace. Max ONE piece of filled chrome per screen (the olive ARM control).
- **Reference build:** `~/.gstack/projects/eroberts7799-ai-workout-dj/designs/design-system-20260817/preview-v3.html` (approved render — consult it before styling any screen). Rejected alternates for context: v1 refined dark "Night Meteorology" (too elegant), v2 black-steel/safety-orange (right grit, wrong palette).

## Typography
- **Display/Hero:** Big Shoulders Display 900 (800 for mid-level), UPPERCASE, line-height .88–.95 — gym-poster heavy, industrial without stencil cosplay. Headlines, countdown callouts, panel titles, the ARM label.
- **Subhead/UI labels:** Barlow Condensed 600, UPPERCASE, letter-spacing .12em — deck names, tab labels, track titles.
- **Body:** Barlow 400/500 — session notes, empty states, explanations. Never shouts.
- **Data/Tables:** JetBrains Mono 400/600/800 with `font-variant-numeric: tabular-nums` — ALL numbers: BPM, timecodes, keys, energy, latency. Micro-labels: 10–11px, 600, letter-spacing .14–.18em, uppercase.
- **Code:** JetBrains Mono.
- **Loading:** Google Fonts — `family=Big+Shoulders+Display:wght@700;800;900&family=Barlow:wght@400;500;600&family=Barlow+Condensed:wght@500;600&family=JetBrains+Mono:wght@400;600;800`
- **Scale:** 10/11 (mono micro-labels) · 12–13 (mono data) · 14 (body) · 15–19 (condensed subheads) · 22 (section headers) · 32–34 (display mid) · 64+ (display XL) · clamp(64px, 11vw, 148px) hero. Brutal jumps, no timid middle sizes.

## Color
- **Approach:** Restrained — five inks, one semantic rule.
- **Paper (bg):** `#FAF9F5` — warm off-white, print-like.
- **Ink (primary text + bars):** `#171711` — near-black with olive undertone. Never pure #000.
- **Seam (rules/borders):** `#DDDBCF` — 1px hairlines, input underlines.
- **Faded (muted text):** `#7C7C6D` — secondary labels, past events, timecodes.
- **Olive (accent):** `#4B5320` — olive drab. **SEMANTIC LAW: olive belongs to what happens next** — armed controls, committed cues, countdowns, cued-deck values. Never decorative.
- **Olive wash (tinted surface):** `#EEEFE3` — timeline band and similar full-bleed zones only. Not a card background.
- **Stamp red (fail):** `#B3402A` — ONLY for a miss (late cut, failed forecast, error). Never warnings, never highlights.
- **No blue, no gradients, no additional colors.** If a new need appears, it must be argued into the doc first.
- **Dark mode ("Night Ops"):** optional variant for live workout use — bg `#12130E`, ink `#EDEDE4`, seam `#2C2E24`, faded `#8C8C7A`, olive brightens to `#A8B36A`, wash `#1C1E14`, fail `#E05B41`. Paper/light is canonical.

## Spacing
- **Base unit:** 8px.
- **Density:** Compact inside data blocks (decks, status lists); generous between sections (~88px section gaps).
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(88).

## Layout
- **Approach:** Grid-disciplined, hard left alignment. Pages read as one continuous printed sheet: 4px ink bar + uppercase display header + olive index number per section.
- **Grid:** 12-col fluid; content max-width 1120px; 40px page gutters.
- **Border radius:** 0. Everywhere. No exceptions.
- **Signature pattern — the forward timeline:** NOW line (2px ink) sits at ~22% from the left; ~78% of the width is the future at full detail; the past fades to Faded. A 2px olive Horizon line marks the next committed transition, with the countdown ("NEXT CUT · T−00:12.4") as a display-face callout. Olive tick-rects mark committed future cues. Render only decisions the engine has actually committed — never speculative garnish.

## Motion
- **Approach:** Near zero — states snap like mechanical switches. No eases on state changes, no entrance animations, no scroll effects.
- **Exceptions:** (1) countdown digits tick in real time; (2) when NOW crosses the Horizon, the olive "next" annotation snaps to an ink past-log entry (instant, no tween).
- **Duration:** micro(0–80ms) only. Anything slower must justify itself in this doc.
- **Any operation >2s shows progress** (project hard rule #6) — as a mono text line ("ANALYZING · 14/38"), never a spinner-in-a-box.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-08-17 | Initial system created via /design-consultation | Researched Ableton/Teenage Engineering/Endel/Serato; two candidate directions rendered and rejected (refined dark "Night Meteorology", black-steel/orange "Issued Equipment") before user approved white+olive "Field Manual" |
| 2026-08-17 | White primary + olive drab accents, five inks, no blue | User: "keep the coloring simple... white and olive green is nice." White-primary is also ownable — every DJ tool is dark |
| 2026-08-17 | Olive = "what happens next"; stamp red = miss only | Carries the product's anticipation truth into the palette without ornament |
| 2026-08-17 | Big Shoulders 900 display + Barlow (Cond) + JetBrains Mono | Gritty gym-poster weight without stencil cosplay; industrial provenance; tabular data |
| 2026-08-17 | No boxes/cards/shadows/radius; one chrome element per screen | User's standing design law, elevated to system identity |
