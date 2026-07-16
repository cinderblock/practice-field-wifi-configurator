# Scoreboard Video Mode

## Goal

Add an alternate, browser-local mode to the `/scores` scoreboard page: a nearly
full-screen video stream view. Scores stay across the top; battery voltage
cards move up to flank the scores on either side. No server configurability —
the mode and stream source persist in `localStorage` per browser.

## Decisions already made (don't re-ask)

- **Local to one browser** — localStorage (`scoreboard-video-mode`,
  `scoreboard-video-source`), plus `?video=1` / `?videoSrc=` URL param
  overrides mirroring the existing `?swap=` pattern.
- **Stream source is user-supplied**: a URL (MJPEG → `<img>`, media file →
  `<video>`, anything else → `<iframe>` for go2rtc/WebRTC/YouTube pages) or
  the sentinel `camera` for a locally attached webcam via `getUserMedia`.
- No HLS.js dependency for now — `.m3u8` only plays natively (Safari).

## Plan

1. [x] Read ScoreboardPage.tsx, StationChart telemetry plumbing, MatchTimer.
2. [x] Hoist battery telemetry state out of `BatteryPanel` into a
       `useBatteryRobots` hook (single telemetry subscription shared by both
       layouts — `handleTelemetryUpdate` appends to shared TimeSeries so double
       subscription would double-append).
3. [x] Extract `BatteryCard` (with `compact` variant) + `BatteryGroup`
       (flanking columns); keep `BatteryPanel` as the normal-mode bottom row.
4. [x] Add `compact` prop to `AllianceScoreBox` (smaller padding/fonts).
5. [x] Video-mode layout: timeline bar stays; compact header row
       `[batteries | left score | title+timer | right score | batteries]`;
       video fills the rest (`object-fit: contain`, black letterbox).
6. [x] Source config panel (TextField + Save / Use local camera / Cancel)
       shown when no source or when editing; small "⚙ source" affordance over
       the video. 🎥 toggle next to the existing ⇄ swap control.
7. [x] Typecheck, update README page table line, commit.
8. [x] Verified end-to-end: fake backend (Bun ws server on :3000 feeding
       scoreState/matchState/telemetry) + vite dev + playwright-core driving
       headless Chrome. 15/15 assertions passed, zero console errors — normal
       layout unchanged, video layout geometry, localStorage persistence,
       reload, URL params, source editing, fake-camera getUserMedia, toggle-off
       restores. Harness kept at `%TEMP%\pfms-verify\drive.mjs` +
       `%TEMP%\pfms-fake-backend.mjs`.

## Findings / gotchas

- Scores root (`frontend/src/roots/scores.tsx`) wraps in a dark MUI theme —
  TextField/Button render fine.
- `useTelemetryCallback` is a plain event listener; the "handler deduplicates"
  comment in StationChart applies to status updates, not
  `handleTelemetryUpdate` — hence the single-subscription hoist.
- Unassigned-alliance robots get balanced across left/right flanks (robots
  list is already sorted left / unassigned / right).
- Cast receivers hide the controls; video mode is per-browser so receivers
  are unaffected unless their own localStorage sets it.
- **Pre-existing dev-only bug in `frontend/vite.config.ts`** (not fixed here):
  the 404 fallback in `stationRoutes()` tests the stale `url` variable after
  the named-route rewrites set `req.url`, so `/scores`, `/admin`, etc. all
  serve `404.html` under `vite dev`. Use `/scores.html` directly in dev.
  Production (Caddy → dist) is unaffected.
- Compact battery cards needed 170px width — at 150px the team number and
  voltage overlapped (caught in screenshot review).
- The t3-code preview MCP tools were broken this session (snapshot failed on
  every page); playwright-core + installed Chrome worked fine as the driver.

## Things not to do

- No `title=` attributes (global rule).
- Don't subscribe `handleTelemetryUpdate` twice (double-appends TimeSeries).
