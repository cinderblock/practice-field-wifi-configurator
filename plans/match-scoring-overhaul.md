# Match Scoring Overhaul

## Goal

Fix match scoring so freeplay mode correctly transitions to match mode, implement
REBUILT-accurate goal-active scoring with 3-second grace periods, and improve the
scoreboard UI (background colors, layout, title, half-freeplay).

## Bugs Found

1. **Match mode never activates**: `onMatchStateChange` checks `prevPhase === 'idle'`
   but match goes `idle -> created -> countdown`. The transition `created -> countdown`
   is never caught, so scoring stays in freeplay the entire match.

## REBUILT Match Timing (from user + code)

- **Auto**: 20s (both goals active)
- **Pause**: 3s (both goals off, auto winner determined)
- **Transition**: 10s into teleop (both goals active)
- **Shifts 1-4**: 25s each, alternating which alliance's goal is inactive
  - Shifts 1,3: auto winner's goal INACTIVE (loser scores)
  - Shifts 2,4: auto loser's goal INACTIVE (winner scores)
- **Endgame**: 30s (both goals active)
- **PostMatch**: both goals stay active until match cleared

**Grace period**: 3 seconds after a goal turns off, scores still count.
Total "both active" from game start: 20 + 3 + 10 + 3(grace) = 36 seconds.

## Key Changes

### Backend

1. **`src/shiftState.ts`** (new) - Move `getAllianceShiftState` from frontend to shared
   location so both backend scoring engine and frontend can use it.

2. **`src/types.ts`** - Add:
   - `goalInactive?: boolean` to `ProcessedScoreEvent`
   - `matchAlliances?: Alliance[]` to `ScoreState`
   - `inactiveScores?: { red: AllianceScore; blue: AllianceScore }` to `ScoreState`

3. **`src/scoringEngine.ts`** - Major changes:
   - Fix transition bug: `(prevPhase === 'idle' || prevPhase === 'created')`
   - Per-alliance match mode: track `matchAlliances` set, only switch alliances with
     joined robots to match mode
   - Goal-active scoring: compute shift state at event time, mark events as
     `goalInactive` when goal has been off > 3 seconds
   - Inactive score tracking: separate calculation for goals scored while hub was off
   - `isGoalActive(alliance)`: uses estimated remaining time + shift state + 3s grace

4. **`frontend/src/utils/shiftState.ts`** - Re-export from shared `src/shiftState`

### Frontend (`ScoreboardPage.tsx`)

1. **Background color** matches period: green (auto/transition), grey (pause),
   red/blue (shifts), gold (endgame), purple (postMatch)
2. **50/50 split** using CSS grid `1fr auto 1fr` so scores stay centered
3. **Title at top** of screen, larger and more legible
4. **Inactivity text** more visible in freeplay
5. **Hide recent batches** during match (already conditional on freeplay, but bug
   prevented mode switch)
6. **Half-freeplay**: if one alliance has no robots, show that side in freeplay style
7. **Inactive scores**: show "off-goal" count during match for clarity

## Progress

- [x] Create shared shiftState (`src/shiftState.ts`, frontend re-exports)
- [x] Update types (`goalInactive`, `matchAlliances`, `inactiveScores`)
- [x] Fix scoring engine (transition bug + per-alliance mode + goal-active scoring)
- [x] Update frontend scoreboard (bg color, 50/50 split, title, half-freeplay, inactive scores)
- [x] Typecheck passes clean
