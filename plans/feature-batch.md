# Feature Batch Plan

## Goal

Implement several new features for pFMS:

1. WPA key auto-detect from savedTeamStore (quick)
2. Match history persistence + UI on /match page (medium)
3. Network bandwidth warning/threshold bars (medium)
4. Field usage tracking + /usage page (large)

## Decisions Already Made

- Dedup window default is already 0 — no change needed
- Battery alerts: teams handle their own minimums — skip
- Scheduling: separate system — skip
- No match replay on scoreboard
- No multi-field support
- Usage tracking: count from first connection to last disconnect daily, 2-hour disconnect threshold, backtrack to last actual connection time (or SSID unconfigured time, whichever first). Multiple robots from same team don't double field time but do count for "on hours".

## Progress Log

- [x] Verified dedup default is 0
- [x] WPA key auto-detect — added `getWpaKeyForTeam()` to SavedTeamStore, chained as fallback in firmware update callback
- [x] Match history — new MatchHistoryStore with persistence, WebSocket broadcast, and MatchHistorySection UI on /match page
- [x] Network bandwidth warning — added 4 Mbps threshold line to bandwidth chart via SmoothieChart horizontalLines, with legend label
- [x] Field usage tracking — new UsageTracker with radio link tracking, 2h disconnect timeout, config-change session close, persistence, and /usage page with summary stats, per-team breakdown bars, and daily summaries

## Files Changed

### WPA Key Auto-Detect

- `src/savedTeamStore.ts` — added `getWpaKeyForTeam(team)` method
- `src/index.ts` — added savedTeamStore fallback in firmware update callback

### Match History

- `src/types.ts` — added MatchHistoryEntry, MatchHistoryState, MatchHistoryTeam, ClearMatchHistory types
- `src/matchHistoryStore.ts` — **new** — persistence store, listens to match engine phase transitions
- `src/index.ts` — instantiate and attach MatchHistoryStore
- `src/websocketServer.ts` — broadcast, initial state send, clearMatchHistory handler
- `frontend/src/hooks/useBackend.ts` — useMatchHistory hook, sendClearMatchHistory
- `frontend/src/components/MatchControlPage.tsx` — MatchHistorySection with per-match rows showing teams, scores, duration, end reason

### Network Bandwidth Warning

- `frontend/src/components/StationChart.tsx` — added horizontalLines to ChartConfig type, 4 Mbps threshold to bandwidth config, render threshold in SmoothieComponent and legend

### Field Usage Tracking

- `src/types.ts` — added UsageSession, UsageState types
- `src/usageTracker.ts` — **new** — tracks radio link state per station, 2h disconnect timeout, config-change session close, persistent sessions
- `src/index.ts` — instantiate and attach UsageTracker
- `src/websocketServer.ts` — broadcast, initial state send
- `frontend/src/hooks/useBackend.ts` — useUsageState hook
- `frontend/src/components/UsagePage.tsx` — **new** — summary cards, per-team usage bars, daily breakdown
- `frontend/src/roots/usage.tsx` — **new** — root entry point
- `frontend/usage.html` — **new** — HTML entry
- `frontend/vite.config.ts` — added /usage route and build input

## Findings / Gotchas

- `savedTeamStore` stores teams by SSID, not team number. Solved by iterating entries and matching SSID prefix.
- `radioManager.getWpaKeyForTeam()` provides active station WPA key — savedTeamStore is the offline fallback.
- Match engine has no persistence — match data was transient. Fixed with MatchHistoryStore.
- Charts use react-smoothie (canvas streaming). `horizontalLines` prop works via SmoothieChart options passthrough.
- Caddy uses `try_files {path} {path}.html` so `/usage` automatically resolves to `/usage.html`.
- UsageTracker closes orphaned sessions on startup (backtrack to lastSeenAt) for server restart resilience.
- Short sessions (<10s) are dropped to filter glitches.
- Usage summary script (`scripts.local/usage-summary.ts`): multi-station configs span multiple log lines — single-line regex missed them. Fixed by also matching individual station lines. Sessions must be closed on service restart and nightly config clears (`Configuring stations: {}`), otherwise they span days and get dropped by the 12h filter. DS heartbeat (`Received object from TCP stream: { type: 24, teamNumber: N }`) is the key signal for days when stations were configured previously and teams just connected — without it, ~half of active days were invisible.
