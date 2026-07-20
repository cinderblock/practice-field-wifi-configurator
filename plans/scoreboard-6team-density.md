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

1. ~~Cap the hero number by `42cqh` via a size container on the grid.~~ **Tried,
   shipped, reverted** — collapsed the idle-freeplay 0–0 font to ~0 (see
   Findings). The single-row battery fix (step 3) removes the overlap this was
   meant to solve, so the hero font stays plain `clamp(4rem,15vw,12rem)`.
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

- **The `42cqh` container-query cap shipped and REGRESSED — reverted.** On the
  live scoreboard the idle-freeplay 0–0 score stopped rendering: `container-type:
size` on the grid did not give a usable resolved height in that state, so
  `42cqh` collapsed toward 0 and `min(clamp(4rem,15vw,12rem), 42cqh)` drove the
  hero font to ~0 (invisible "0"). `container-type:size` is too finicky (needs a
  definite size in both axes and establishes size containment) to rely on here.
- With the batteries now on a **single row**, the original two-row overlap that
  the cap was meant to solve no longer occurs — the shorter battery band leaves
  enough vertical room for the (12rem-capped) hero number. So the cap isn't
  needed; hero font is back to the plain `clamp(4rem,15vw,12rem)`.
- If hero-vs-battery overlap ever resurfaces on a very short display, use a
  JS-measured cap (ResizeObserver on the score region → px max-height), which is
  deterministic — NOT `cqh`/`vh`.
- Could not drive a live 6-robot / freeplay render here (no mock/sim harness;
  needs backend + robots). Changes reasoned from the CSS + the live regression
  report; sanity-check on the wall display.

## Progress log

- [x] ~~Hero number capped to `42cqh`; score grid made a size container.~~
      REVERTED — regressed idle-freeplay 0–0 (font collapsed to ~0). Hero font
      back to `clamp(4rem,15vw,12rem)`; size container removed.
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

- Don't shrink the hero number unconditionally (spectators read it).
- **Don't use `cqh`/`container-type:size` to cap the hero number** — it collapsed
  the idle-freeplay 0–0 to an invisible font. If a height cap is ever needed
  again, measure with JS (ResizeObserver → px max-height).
