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
- **WHEP/WebRTC support (2026-07-17)**: `whep:<stream>` sources play via a
  built-in WHEP client (`WhepVideo` in ScoreboardPage.tsx) that signals
  same-origin through `/api/video-proxy/*` (`src/videoProxy.ts`, hooked in
  websocketServer's createServer; target fixed by `VIDEO_PROXY_TARGET` env —
  not an open proxy). Full `.../whep` URLs are also accepted and used
  directly. Sub-second latency; auto-reconnects; DELETE teardown with
  keepalive. Externally, /api/\* is behind pfms.caddy's forward_auth cookie
  check → internet playback is privileged-clients-only for free. Internet
  MEDIA additionally needs (ops repo, user approval): UDP port-forward of
  MediaMTX's webrtcLocalUDPAddress + `webrtcAdditionalHosts` advertising the
  public address in restitch's mediamtx config. LAN needs none of that.
  Verified end-to-end against a real MediaMTX v1.15.5 (WHIP-publish fake
  camera → scoreboard WHEP playback through the real proxy code via
  `%TEMP%\pfms-verify\harness.ts` + `drive4.mjs`; teardown DELETE observed
  with rewritten session Location).
- Vite dev gotcha (fixed): stationRoutes' 404 fallback also swallowed
  `/api/*` paths before the dev proxy could forward them (team-avatar
  included) — now exempted.
- **Two layouts** (user request, 2026-07-17): `landscape` (scores/status bar
  across the top — wide streams) and `square` (video fills the height,
  scores + batteries in the black side bars, timer overlaid on the video
  top). Stored in `scoreboard-video-layout` / `?videoLayout=`; switchable
  from the ▭/▯ control chip and the source-config panel.
- **Square layout is aspect-fit** (user follow-up): the video box sizes to
  the stream's measured width/height ratio (`aspectRatio` CSS; reported by
  the media elements via `onAspectRatio` — video/img/WHEP; iframes can't
  report, which falls back to fixed panels + flex video). Side panels
  `flex: 1 1 0` to absorb ALL leftover width, so no black bars remain
  around the video content. Verified: 4:3 WHEP stream → video box exactly
  4:3 (1354×1016 @1080p), panels symmetric 283px; landscape unaffected
  (`%TEMP%\pfms-verify\drive5.mjs`).
- **Controls must be discoverable** (user couldn't find the original tiny
  🎥 glyph): top-right controls are labeled chips ("🎥 video", "▭ wide"/
  "▯ square", "⇄ swap") that brighten to full opacity on mouse/touch
  activity and fade to 0.2 after 3 s idle.

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
- **Pre-existing dev-only bug in `frontend/vite.config.ts`** (fixed in a
  follow-up commit): the 404 fallback in `stationRoutes()` tested the stale
  `url` variable after the named-route rewrites set `req.url`, so `/scores`,
  `/admin`, etc. all served `404.html` under `vite dev`. Now re-derives the
  path from `req.url`. Production (Caddy → dist) was never affected.
- Compact battery cards needed 170px width — at 150px the team number and
  voltage overlapped (caught in screenshot review).
- The t3-code preview MCP tools were broken this session (snapshot failed on
  every page); playwright-core + installed Chrome worked fine as the driver.
- **Clock-skew bug (FIXED)**: battery charts on `/scores`
  plot raw server timestamps. `timeOffset` is only calibrated in
  `handleStatusEntry` (useBackend.ts ~305), but the public `/ws/scores`
  socket whitelist is `['scoreState','matchState','telemetry']`
  (websocketServer.ts ~230) — StatusEntry never arrives, so
  `serverToBrowserTime()` is the identity on the scoreboard. Smoothie
  renders against the browser clock, so any server↔display skew shifts the
  trace off the ~35 s window while the numeric voltage (timestamp-free)
  stays fine. The `serverInfo` sent on connect has no current-time field.
  Fix (committed with the battery-text move): `noteServerTimestamp()` in
  useBackend.ts seeds the offset from the first sample then EMA-smooths;
  called from handleStatusEntry, handleTelemetry (the steady beacon on
  /ws/scores — updated before dispatch so charts convert with fresh data),
  and handleServerInfo via the new optional `ServerInfo.now` field that the
  backend now sends on connect for both sockets. Verified with the fake
  backend's `CLOCK_SKEW_MS` env (+1 h, −2 min, 0): traces draw and anchor at
  the right edge in all three cases (`%TEMP%\pfms-verify\drive3.mjs`).
  Note: the fake backend normally runs on the same machine as the browser,
  so skew never shows up in dev unless simulated via `CLOCK_SKEW_MS`.

## Things not to do

- No `title=` attributes (global rule).
- Don't subscribe `handleTelemetryUpdate` twice (double-appends TimeSeries).
