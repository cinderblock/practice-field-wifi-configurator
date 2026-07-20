# Battery voltage "256.0V" for disconnected robots

## Goal

Stop reporting `256.0V` for robots that aren't connected to their Driver
Station, and show a proper "no reading" placeholder instead.

## Root cause

When a DS is connected to the FMS but the robot (RIO) is not connected to the
DS, the DS fills the battery-voltage field of its telemetry with the sentinel
`0xFFFF`. The parse does `readNumber(2) / 256`, and `0xFFFF / 256 = 255.996`,
which `toFixed(1)` rounds to `256.0` → displayed as "256.0V". It also polluted
the battery charts and scoreboard cards with a bogus ~256V sample.

## Fix (at the parse layer — single source of truth)

Treat the raw 16-bit value `0xFFFF` as "no reading" and represent it as
`undefined` from the parse onward. Everything downstream already tolerates an
absent `batteryVoltage` (`telemetryThrottle` guards `!== undefined`;
`StationChart`/`ScoreboardPage` guard before appending/noting), so the bogus
value simply never enters the pipeline.

Narrow sentinel: only `0xFFFF` is treated as absent. `0.0V` is left as-is (a
genuinely dead pack can read low; 0 is not misleading garbage the way 256 is).

## Changes

- `src/fmsServer.ts` — add `parseBatteryVoltage(raw)` helper returning
  `number | undefined`; `UdpMessage.BatteryVoltage` and `LogDataMessage.voltage`
  become `number | undefined`; both parse sites (UDP + TCP LogData) use it.
- `src/types.ts` — `TelemetryUpdate.batteryVoltage` becomes optional.
- `src/robotPacketCapture.ts` — guard the `0xFF 0xFF` sentinel (defensive; this
  packet-driven path only fires when the robot IS connected); fix the debug log.
- `frontend/src/components/StationStatus.tsx` and `ControlPage.tsx` — render the
  battery cell as `— ` when voltage is absent, matching the neighboring
  RTT/Lost-Pkts/CAN/DS-CPU cells.

## Status

- [x] Implement backend parse guard + type changes
- [x] Implement frontend placeholder
- [x] typecheck — my six files clean; a pre-existing `onPlayGetReady` error in
      `MatchControlPage.tsx` (another thread's in-progress work) is unrelated.

Not committed: the shared worktree currently fails `tsc` on another thread's
`MatchControlPage.tsx`, and the pre-commit hook typechecks the whole tree — a
commit would fail until that's resolved. Stage/commit once the tree is green.
