# FMS DS TCP churn + stale scoreboard team numbers

## Goal

Two issues found during the 2026-07-12 field session (teams 846 + 2854 on site):

1. Scoreboard showed "slot2" instead of team 2854 + logo even though the radio
   config was correct and telemetry was flowing.
2. Every DS reconnects TCP to the FMS port (1750) every ~6 seconds, spamming the
   journal with `DS connected` / `DS connection closed` churn, and dead NAT'd
   sockets pile up as ESTAB forever.

## Findings (evidence from steamboat, 2026-07-12 ~14:30–15:00 PDT)

- **Deployed state:** steamboat runs commit `8470107` (= local HEAD = origin/master),
  deployed 2026-05-13 15:01 PDT, service up since. The May 13–17 uncommitted batch
  (`plans/feature-batch.md`) is NOT deployed.
- **Scoreboard "slot2" root cause:** the match engine snapshots team numbers at
  match start and `getState()` serves that frozen snapshot during the match AND
  during `postMatch` (`src/matchEngine.ts:585`). The engine only leaves `postMatch`
  via manual `clearMatch()` (`src/matchEngine.ts:779`). Journal: "Match 2 ended —
  all stations left" at 13:34:18, never cleared. Slot2's `2854-comp` config was
  committed at 14:31:10 — after the snapshot — so slot2 stayed `teamNumber: null`
  → scoreboard falls back to station name (`ScoreboardPage.tsx:750`), no logo.
  **Remedy at the field: clear the match from match control.**
- **6s TCP churn root cause:** `startFMSServer` (src/fmsServer.ts) never writes
  anything on the DS TCP socket. The DS sends its team number (0x18) and expects
  the FMS station-assignment reply (0x19); without it, the DS times out after ~6s,
  closes, and reconnects forever. The code even documents the flap as expected
  (comment near `src/index.ts:1125`).
- **Ghost ESTAB sockets:** team VLANs are MASQUERADEd, so every device on a team
  network appears as the VLAN gateway IP (e.g. all of slot2 = 10.55.20.254). Node
  doesn't enable TCP keepalive, so a DS that vanishes without FIN leaves an ESTAB
  socket forever. `ss -tino` showed sockets from 10.55.20.254 with lastrcv 6.9 and
  12.9 DAYS, each having received exactly 5 bytes (one 0x18 frame). So
  "(4 remaining)" in the logs = corpses, NOT extra driver stations. 2854 is
  running ONE active DS (single 6s telemetry cadence, no doubled lines).
- 23 ESTAB connections to :1750 from ~12 IPs, including FRC-style static DS IPs
  10.80.48.200 (team 8048) and 10.69.62.201 (team 6962) — other DS laptops at the
  venue can reach 10.0.100.5 and connect. Mostly stale corpses.
- 846's DS traffic arrives from 10.55.211.40 (not a slot gateway .254) — 846's DS
  is apparently NOT behind a slot VLAN NAT. Unexplained; robots drive fine.
- slot2 had a real ~30s network dropout at 14:46 (ECONNRESET, "DS stale: slot2"),
  which matches 2854's reported connection problems. RF/laptop side, not FMS.

## Decisions

- **The 0x19 reply must ONLY go to stations that have joined a match.** Answering
  the handshake flips the DS into FMS-controlled mode, which locks out local
  enable — that is WHY the server historically never replied (user confirmed;
  also hinted by `UdpSendPort = 1121; // 1120 to assert control over DS`).
  matchEngine already only sends UDP control packets to joined stations for the
  same reason. Freeplay DSes get NO reply (not even status-2 "waiting" — untested
  whether waiting also locks the DS) and keep churning; the log dampener keeps
  that churn out of the journal. TournamentLevel only changes labeling.
- **UDP port semantics (frcture.readthedocs.io/en/latest/driverstation/fms_to_ds.html):**
  FMS→DS control packets go to UDP 1121 (official FMS — DS enters FMS control
  immediately) or UDP 1120 (offseason FMS — DS prompts the operator to approve
  FMS control first). pFMS sends to 1121; the old comment claiming "1120 to
  assert control" was backwards and has been fixed. Two unexplored options:
  (a) freeplay consent flow — send UDP to 1120 so teams can opt in to FMS
  control; (b) the docs tie FMS control to the UDP stream, so a TCP-only 0x19
  reply (no UDP) MIGHT not lock the DS — bench-testable someday; until proven,
  the joined-only gating stays.
- Log dampening carries the journal-noise fix for freeplay; the 0x19 reply fixes
  churn only during matches (where lockout is intended anyway).
- 0x19 packet format (from Cheesy Arena's driver_station_connection.go):
  `[0x00, 0x03, 0x19, stationCode, status]` — 2-byte big-endian length prefix,
  stationCode red1..blue3 = 0..5, status 0 = assigned here, 1 = wrong station,
  2 = waiting/unknown team.
- `resolveTeamSlot` callback wired from index.ts: team → station via
  `radioManager.getStationForTeam`, slot via live match `portToSlot` else
  `defaultSlotToRadio`.
- Enable `socket.setKeepAlive(true, 30s)` so dead NAT'd sockets get reaped.
- Log changes: dedupe repeated 0x18 logs (log team↔addr only on change); suppress
  connect/close logs for reconnects within 30s of a close, summarizing at most
  every 5 min per address.

- **E-stop is unaffected by the TCP gating** (user flagged; verified): globalEStop
  sends UDP disable packets to ALL stations with known DS addresses, joined or
  not (matchEngine.ts:497-513). A freeplay DS hit by those packets enters FMS
  control and disables — that's the intended safety behavior and no TCP change
  touches it.
- **Opt-in experiment knob:** `FMS_TCP_REPLY_STATIONS` env var (`slot1,slot2` or
  `all`) makes the resolver grant the 0x19 reply outside matches for those
  stations only — test the lockout hypothesis on one robot before any default-on.
  Chosen over an admin-UI toggle because the websocketServer/useBackend/
  MatchControlPage regions are all dirty with the uncommitted feature-batch work;
  a UI toggle design was mapped (send fn in useBackend.ts ~l.933 pattern,
  ActiveParticipantRow in MatchControlPage.tsx ~l.580, type guards in types.ts
  ~l.619 pattern) and can be added after feature-batch lands if wanted.
- **Team checks stuck on error (2854 Radio Firmware/SystemCore):** auto-re-run
  only fired when a NEW alive IP appeared in the subnet scan (index.ts, scan
  callback) — but radio HTTP failures happen while the radio stays pingable, so
  the alive set never changes and errored results sat until a manual re-run.
  Fixed: errored results now also retry on a backoff timer (30s, 1m, 2m, 4m,
  then every 8m indefinitely); manual re-run still resets the backoff.

- **Laptop-swap lockout (2854, 2026-07-12 ~16:02):** team shut down the DS on one
  laptop and opened it on another; the new DS (10.55.99.231) was blocked as a
  "duplicate DS" every 6s for 10+ minutes until they wiped and re-applied the
  station config. Root cause: three checks treated an open TCP socket as
  proof-of-life via `connectedDsIps` — trySetDSAddress (blocked takeover), the
  periodic stale-session cleanup (refused to clear the dead session), and
  addDnatRule (refused to swap). A laptop that sleeps/drops WiFi never sends FIN,
  so its ghost ESTAB socket pinned the old session forever; the activity tracker
  correctly said stale ("DS stale: slot2" in journal) but was short-circuited.
  Fixed: liveness is activity-recency only (isDsStale, 20s); `connectedDsIps`
  removed. TCP keepalive (earlier commit) also reaps ghosts but takes ~10 min on
  Linux defaults — far too slow for swaps; it's a backstop, not the fix.

## Progress

- [x] Diagnose scoreboard "slot2" (postMatch snapshot, needs clearMatch at field)
- [x] Diagnose TCP churn (missing 0x19 handshake reply)
- [x] Implement 0x19 reply + keepalive + log dampening in fmsServer.ts
- [x] Wire resolveTeamSlot in index.ts
- [x] Typecheck, commit (only these hunks — tree shared with feature-batch work)
- [x] Gate the 0x19 reply on station joined (user caught the FMS-lockout risk);
      amended into the same commit
- [x] FMS_TCP_REPLY_STATIONS opt-in env var + README row
- [x] Timed backoff retry for errored team checks
- [x] Fix laptop-swap lockout: activity-based DS liveness, connectedDsIps removed
- [x] Unify duplicate-DS display on driveSessionState: ControlPage + NetworkPage
      now read the authoritative broadcast (like StationStatus); removed the
      matchEngine blockedDsIps plumbing whose silent early-return hid the
      "multiple DSes" warning during the 2854 laptop-swap incident
- [x] Delete orphaned /slotN station page (station.html, roots/station.tsx,
      StationPage.tsx): superseded by per-team control pages (/<team#>) and
      /overview; vite routing already 404'd /slotN and nothing linked to it.
      README Pages table corrected. NOTE: earlier analysis in this plan wrongly
      described "/slot2 station page" as a live surface — the StationStatus
      duplicate-DS banner actually lives on /overview.
- [ ] Check steamboat's Caddy config for stale /slot\* rewrite rules (server
      config — needs per-change authorization)
- [ ] Remove the now-unpopulated `blockedDsIps` field from DSConnectionInfo in
      types.ts once the feature-batch work lands (left in place because types.ts
      carries uncommitted feature-batch types that other worktree files import —
      staging a types.ts hunk breaks the pre-commit typecheck)
- [ ] Bench test: set FMS_TCP_REPLY_STATIONS=slot1 (846), restart service, watch
      whether the DS shows FMS Connected and whether local enable still works
- [x] Auto-clear postMatch → idle after 2 min (POST_MATCH_AUTO_CLEAR_MS): fixes
      abandoned practice matches leaving the scoreboard/scoring stuck in match
      mode forever (2854 incident: match started, never cleared, scores kept
      accumulating). Scoring follows the postMatch→idle transition back to
      freeplay automatically. E-stop endings exempt — human must clear. Also
      fixes the earlier "slot2 on scoreboard" staleness by bounding postMatch.
- [ ] Deploy: all seven commits are live-field relevant; the swap fix and
      postMatch auto-clear especially. User decides when (live session).
      Verify on-site after deploy: 846's DS holds TCP during a match, churn
      logs quiet, laptop swap reconnects in ~20s, abandoned match returns to
      freeplay after 2 min.
- [ ] (Optional follow-up) live-resolve never-joined stations in postMatch so
      late robots appear during the (now max 2 min) postMatch window

## Things not to do

- Don't deploy mid-session without the user's go-ahead (graceful reload preserves
  network state, but a DS-facing protocol change should be tested between runs).
- Don't commit the May 13–17 feature-batch working-tree changes with this fix —
  index.ts is dirty with that batch; stage only the resolveTeamSlot hunk.
- The DS only sends 0x18 once per connection: if a team gets assigned AFTER their
  DS connected (status 2 sent), the DS won't learn its station until it
  reconnects. Acceptable for now; note for the follow-up.
