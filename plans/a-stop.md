# A-Stop (autonomous stop) for practice matches

## Goal

Add per-team A-Stop, matching official FMS semantics: a team can stop their
robot during the autonomous period; the robot stays disabled for the rest of
auto and is automatically re-enabled for teleop. Triggered from each team's
station page (button visible during countdown/auto) and from the DS itself
(the 2024+ DS→FMS status byte carries an A-Stop bit).

Prompted by user question "do we have A-Stop?" — answer was no. User asked to
add it, with buttons on each team's page during auto.

## E-stop race analysis (user's concern — answered, no code change)

User worried: backend e-stops → DS latches e-stop → admin clears backend
e-stop → DS still reports e-stop → backend re-latches → stuck forever.

**This loop cannot start from a backend e-stop.** The backend never sends the
e-stop bit to the DS — `sendDSPacket` always builds `new Control(false, ...)`
(`src/matchEngine.ts:905-907`); backend e-stop reaches the DS as plain
_disable_. The DS only reports EStop=true when e-stopped locally (spacebar).
In that case the DS/roboRIO latch until the rio reboots, so backend re-latching
after a clear mirrors physical reality; once the rio reboots the DS reports
clear and `adminClearEStop` sticks.

**Adjacent real race found (not fixed, flagged to user):**
`dsReportedStatus`'s disable path (`!dsEnabled && state.enabled`,
`src/matchEngine.ts:547`) can eat a _stale_ DS heartbeat right after
`enableParticipating()` enables stations at auto/teleop start. DS UDP is ~2 Hz,
so an up-to-~500 ms-old `enabled=false` report can arrive after we enable and
disables the station with nothing re-enabling it. Possible fix: track
per-station enable timestamp and ignore DS disable reports for ~1 s after
enabling. Left for user decision (safety-relevant behavior).

The new A-Stop DS-report path has no such race: we latch only on
`AStop=true`, never clear from DS reports, and never send an a-stop bit out.

## Design decisions

- Follow the existing e-stop pattern: **backend-only state, never send a
  special bit to the DS** — A-Stopped stations just get disable packets.
- A-Stop accepted in phases: `countdown`, `auto`, and `paused` when
  `prePausePhase === 'auto'`. Ignored (warn) otherwise — including DS-reported
  A-Stop bits outside those phases, so a DS that keeps asserting the bit in
  teleop can't wedge the station.
- Cleared automatically in `enableParticipating('teleOp')` (teleop start /
  resume), and reset in `createMatch`/`startMatch` like eStop.
- No admin "clear A-Stop" — it self-clears; official FMS behaves the same.
- DS status byte bit 0x40 = A-Stop (2024+ FMS protocol).

## Files touched

- `src/fmsServer.ts` — parse `AStop` (0x40) in `byteToDsStatus`, add to `DsStatus`.
- `src/types.ts` — `aStop` on `StationControlState`; `StationSelfAStop` message + guard. (shared file, peer thread has uncommitted edits)
- `src/matchEngine.ts` — `stationAStop()`, phase gating helper, latch in `dsReportedStatus`, clear/skip in `enableParticipating`, resets, belt-and-braces `!state.aStop` in `sendDSPacket`.
- `src/index.ts` — pass `udp.status.AStop` into `dsReportedStatus`. (shared file)
- `src/websocketServer.ts` — route `stationSelfAStop`. (shared file)
- `frontend/src/hooks/useBackend.ts` — `sendStationSelfAStop`. (shared file)
- `frontend/src/components/MatchPanel.tsx` — A-Stop button in both panels during countdown/auto; "A-Stopped until teleop" chip while latched.
- `frontend/src/components/AdminPage.tsx` — A-STOP chip on station cards.
- `README.md`, `TECHNICAL.md` — mention A-Stop.

## Progress

- [x] Investigate e-stop race (see above)
- [x] Backend implementation (fmsServer, types, matchEngine, index,
      websocketServer, telemetryManager, robotPacketCapture)
- [x] Frontend implementation (useBackend sender, MatchPanel buttons+chip both
      panels, AdminPage chip, ControlPage telemetry chip)
- [x] Docs (README, TECHNICAL)
- [x] `bun run typecheck` — passes clean
- [x] Commit — done as the last of a 5-commit split of the shared worktree
      (bandwidth warning, WPA fallback, match history, usage tracking, A-Stop),
      each commit built as a self-consistent tree so lefthook never saw a
      partially-staged file.
- [x] Deployed to steamboat (1f562c9 → 9b4594d, incl. dropping the redundant
      disable echo in dsReportedStatus).
- [x] Follow-up: pre-match A-Stop arming — `canAStop()` accepts `created`
      (joined stations only), `startMatch` preserves pre-armed A-Stops for
      joined stations, new `stationClearAStop` lets a team cancel until the
      countdown begins (latched after), cleared on leave/kick/cancelMatch.
      UI: arm/cancel button + "A-Stop armed" chip in both MatchPanel created
      blocks.

## Gotchas / notes

- The worktree was shared with a peer thread's uncommitted feature batch
  (plans/feature-batch.md); its four features were committed first as
  separate commits, then A-Stop on top. The peer's separate dhcpcd DNS fix
  commit also swept in the WPA-fallback files that were staged at the time
  (`aa5e8d4`) — content is correct, attribution message doesn't mention it.
- `dsReportedStatus` has exactly one caller (`src/index.ts` fms.on('message')).
