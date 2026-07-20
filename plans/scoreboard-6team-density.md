# Scoreboard density with 6 teams

## Goal

On the normal (non-video) scoreboard, a 6-team match over-fills the screen:

1. **Battery encroachment** — the bottom battery panel wraps to two rows and the
   big alliance score boxes overflow their flex region and overlap the batteries.
2. **Edge label cutoff** — the `PeriodBreakdown` labels (Auto / Transition /
   Period 1 / Period 2 / Endgame) that flank the score boxes get clipped at the
   left and right screen edges.

Both were reported from a photo of a wall TV mid-match (blue 32 / red 74, 6 robots).

## Environment / context

- File: `frontend/src/components/ScoreboardPage.tsx` (normal-mode branch, ~L749–878).
- Layout is a column flex at `100dvh`:
  Title → `MatchTimeline` → score grid (`flex:1`) → `BatteryPanel` (auto height).
- Score grid: `gridTemplateColumns: minmax(0,1fr) auto minmax(0,1fr)`,
  `alignItems:center`, `px: max(16px,3vw)`. Flank columns have `overflow:hidden`.
- Hero number font: `clamp(4rem, 15vw, 12rem)` — pure viewport units, independent
  of remaining vertical space, so it overflows onto the batteries when the region
  is short. Its width also squeezes the `1fr` flank columns → label clipping.
- `BatteryPanel` (~L1301) renders full-width `flexWrap` cards, 180px each,
  `justifyContent:center`. Six wrap to two rows on a narrow-effective-width TV.
- The effective CSS width of the problem display is unknown (the cards wrapped,
  so it is < ~1140px — likely a 720p-class or display-scaled TV). Fixes must not
  depend on a specific width.

## Root cause

Single root cause with two symptoms: the hero score is sized in viewport units,
so it does not shrink when the score region is short (vertical overlap) and its
width crowds out the flank columns (horizontal clipping).

## Decisions already made (don't re-ask)

- **The batteries must never wrap to a second row.** Wrapping is itself the bug:
  the cards are sorted red → unassigned → blue to read left-to-right in line with
  the score boxes, and a centered second row breaks that grouping. One row always;
  cards shrink to fit. (Superseded the earlier "two rows are acceptable" note.)
- Keep the 2-team / normal case visually unchanged — fixes should only bite when
  the display is height- or width-constrained.

## Plan / steps

1. Cap the hero number to a fraction of the **score region's own height** with a
   container query: make the score grid a `containerType:size` /
   `containerName:scoreboard`, and set the non-compact font to
   `min(clamp(4rem,15vw,12rem), 42cqh)`. Self-correcting: two battery rows shrink
   the region → the number shrinks to fit → no overlap, at any resolution. A
   smaller number is also narrower, freeing horizontal room for the flank labels.
   (A plain `vh` cap was rejected: the number is already clamped to 12rem/192px,
   so `40vh` only bites below a 480px-tall viewport — inert on realistic TVs. The
   cqh cap is relative to the region, so it works regardless of display size.)
2. Recover horizontal room for the period labels (insurance): trim the score
   grid outer padding, the flank `pr/pl` + gap, the score-box `px`, and the
   `PeriodBreakdown` internal gap — all modest.
3. Force the bottom battery panel onto **one row** regardless of robot count:
   `flexWrap:nowrap`, and give each card `flex:1 1 0; minWidth:0; maxWidth:190`
   (a new `fill` prop) so N cards share the row width and shrink to fit. Each card
   becomes an `inline-size` container; when a card gets narrow the header drops the
   least-critical figure (the ↓min voltage, hidden ≤132px) and nudges fonts down
   (≤150px), so shrinking degrades gracefully instead of clipping the team number.
   The video-mode groups keep fixed-width cards (no `fill`), unchanged.
4. `bun run typecheck`.

## Findings / gotchas

- cq (container-query) units are the _self-correcting_ fix (scale the number to
  the score region's own height). Safe here because the `42cqh` value lives only
  in the **non-compact** font string, which is used only in normal mode — inside
  the `scoreboard` container. The video layouts use the separate `compact` font
  and never evaluate cqh, so there's no cross-contamination. `container-type:size`
  is valid on the grid because its size comes from `flex:1` (determinate), not its
  content. Requires container-query support (Chrome 105+/Safari 16+ — fine for the
  modern WHEP/wakeLock browser on the display).
- Could not drive a live 6-robot render here (no mock/sim harness; needs backend
  - six robots). Changes are reasoned from the CSS; the wall display should be
    sanity-checked, or tell me the TV's effective resolution to tune the 40vh cap
    and dense-card threshold.

## Progress log

- [x] Hero number capped to `42cqh`; score grid made a `scoreboard` size container.
- [x] Horizontal tightening: grid px `max(16px,3vw)`→`max(10px,1.5vw)`; flank
      `pr/pl` 2→1.5 and gap 2→1.5; score-box px 6→`clamp(1.5rem,3vw,3rem)`;
      PeriodBreakdown row gap 1.5→1.
- [x] Bottom battery panel forced to one row (`flexWrap:nowrap` + `fill` cards
      that flex-shrink, capped at 190px); ↓min voltage and font sizes degrade via
      inline-size container queries. Replaces the earlier count-based dense-width
      attempt (which could still wrap).
- [x] `bun run typecheck` clean; prettier clean.
- [ ] Live verify on the wall display (couldn't drive 6 robots here). Watch: six
      batteries stay on one row reading red→blue left-to-right; the hero number
      shrinks to clear them; period labels stop clipping at the edges.

## Things not to do

- Don't shrink the hero number unconditionally (spectators read it) — only cap by
  height so normal displays are untouched.
- Don't put cq units in the shared score box (breaks video mode).
