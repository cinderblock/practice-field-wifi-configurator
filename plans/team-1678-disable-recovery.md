# Team 1678 Disable Recovery - Match Incident Investigation

## Goal

1. Investigate what happened with team 1678 during their recent auto period (disabled state)
2. Implement a recovery mechanism for teams that get disabled via their DS

## Context

- Team 1678 "went nuts during auto" and hit A-Stop, but they may have ended up hitting "disable" in their DS instead
- They then e-stopped the whole match
- Need to: (1) verify from logs, (2) allow re-enable if DS-initiated disable

## Key Code Locations

- Match state logic: `src/matchEngine.ts` (lines 642-675 handle `dsReportedStatus`)
- Robot state tracking: `src/types.ts` (StationControlState type)
- Frontend controls: `frontend/src/components/ControlPage.tsx`

## Current Disable Flow

When a DS reports disable (line 665-668):

1. `state.enabled` is set to false
2. The disable is latched — it persists in `state.enabled`
3. No automatic recovery mechanism exists
4. No tracking of "why" the station is disabled (FMS vs DS)

## Plan / Steps

- [x] Check match-history.json on steamboat for team 1678's last match
- [x] Understand the event sequence (A-Stop vs disable vs e-stop) — see VERIFIED FINDINGS below
- [x] Track disable source — became `disabledBy: 'ds' | 'self' | 'admin' | null` (not just a DS boolean)
- [x] Implement `undisable()` (self + admin), with phase guards, mode re-stamp, and enable-grace
- [x] Wire up UI: Re-enable on station page + pop-out window, Enable on both admin surfaces,
      two-tap E-Stop on the station page
- [x] Test the recovery flow — `scripts/test-undisable-recovery.ts` (engine-level, 17 checks, all pass)

## Open Questions

- What exact sequence happened? (A-Stop → DS Disable → E-Stop, or something else?)
- Should undisable be available only during specific phases, or always?

---

## VERIFIED FINDINGS (incident-analysis-agent, 2026-07-19 14:24 — from steamboat journal + match-history.json)

**The incident was NOT a DS disable. It was the E-Stop button in the station console UI.**
This changes what the recovery feature must cover — read before finishing the implementation.

Match 7 (in-memory "Match 1", service restarted since), 1678 = red1 on **slot3**, endReason `normal`:

- 14:09:22 slot3 joined red, DS 10.55.158.45 handed to FMS control
- 14:14:24 `stationStartMatch`; 14:14:27 auto started
- **14:14:34 — `Received message: { type: 'stationSelfEStop', station: 'slot3' }` → `E-Stop: slot3`** (10 s into auto)
- 14:14:47 auto-pause; 14:14:50 teleop — slot3 stays down (`enableParticipating` skips `eStop` stations)
- No `adminClearEStop` during the match; 14:17:14 slot3 left, DS released

Evidence quality: journald was NOT suppressing the service in this window (node lines every few
seconds, no `Suppressed` notices), so these absences are meaningful:

- **No `stationSelfAStop` was ever received** — they never pressed A-Stop; they went straight to
  the console E-Stop button (pop-out console shows both since e5e966f/ecb449d).
- **No `DS a-stop reported` / `DS e-stop reported` / `DS disable reported: slot3`** before 14:14:34 —
  the DS did not initiate anything first. (After 14:14:34 DS-side reports become invisible: all
  `dsReportedStatus` latch branches are guarded by `state.eStop`/`state.enabled` already being set,
  so we can't rule out that they ALSO pressed Enter/Space in the DS afterwards. Doesn't matter — the
  initiating and match-killing event was the UI E-Stop.)

## Design corrections for the fix (from the verified sequence)

1. **`disabledByDs`/`undisable()` alone would NOT have saved 1678.** The latched state was `eStop`,
   set via `stationEStop()` from the UI. Recovery must also cover e-stop: after `clearEStop`,
   nothing re-enables mid-phase (`enableParticipating` only runs at phase transitions), so a
   cleared station still sits disabled until the next phase. Need a re-enable path that works for
   a cleared e-stop, not just a DS disable.
2. **Phase guard bug in current `undisable()` draft:** it blocks only idle/postMatch/created. It
   must also block `countdown`, `autoPause`, and `paused` — every station is intentionally
   disabled in those phases; enabling one robot while the field is paused is unsafe. Allow only
   `auto` / `teleop` / `endgame` (mode is still correct from the last `enableParticipating`).
3. **Re-latch race:** after `undisable()`, the next DS UDP heartbeat (up to ~500 ms stale, 2 Hz)
   may still report disabled → `dsReportedStatus` `!dsEnabled && state.enabled` instantly re-latches
   the disable. Needs a short grace window (~1.5–2 s) after an FMS-initiated enable during which
   DS disabled-reports are ignored, or require 2+ consecutive disabled heartbeats to latch.
4. **`stationDisable()` sets `disabledByDs = false`** — so a team that presses their own console
   Disable button (`stationSelfDisable` routes there too) can never self-recover, only DS-initiated
   disables can. Probably want self/console disables recoverable too on a practice field.
5. **Unverified DS behavior (needs field test):** whether a real DS that latched a local
   Enter-disable actually re-enables when FMS resumes sending the enable bit. If the DS latches
   locally, `undisable` won't bring the robot back and the UI should say so.
6. **Prevention:** they hit E-Stop while (per Cameron) trying to A-Stop, 10 s into auto. The
   console E-Stop button needs friction (hold-to-activate or confirm) and the A-Stop button should
   be the prominent one during auto. Per global UI rules: no `title=` tooltips.

## The spacebar report (driver says they hit Space)

Cameron relayed that the 1678 driver hit the **spacebar**. How that squares with the logs:

- **Our UI has no key listeners anywhere** — but the browser natively activates a _focused_
  button on Space/Enter. A backend `stationSelfEStop` is therefore indistinguishable between a
  tap and a spacebar press landing on a previously-tapped, still-focused E-Stop button. Likely
  chain: tapped the popout E-Stop once (arming it — intending A-Stop or DS E-Stop), then Space
  confirmed the still-focused armed button. Or they just tapped the station page's then-single-
  click E-Stop.
- **The real FRC Driver Station treats Space as E-Stop globally** (works without DS focus, per
  WPILib docs; a DS-level e-stop latches until the roboRIO reboots). So the same Space press
  plausibly e-stopped the robot at the DS too — invisible in our logs because every
  `dsReportedStatus` latch branch was already masked by the UI e-stop that arrived first
  (websocket ~ms vs 2 Hz DS heartbeat).
- Hardening added (in the recovery commit): every stop/re-enable button in the station page and
  popout **blurs itself on activation**, so a stray Space/Enter aimed at the DS can never
  activate the last-tapped button. A DS-level e-stop remains unrecoverable field-side by design
  (roboRIO reboot required) — that's the DS's own safety latch, not ours.
- Considered and NOT done (product call for Cameron): mapping Space in the popout to A-Stop
  during auto (matches driver muscle memory, low harm since A-Stop self-releases). Global key
  handlers that stop robots can misfire while typing; needs a deliberate decision.

## Where the E-Stop came from (frontend)

`stationSelfEStop` is sent from exactly two places, indistinguishable in backend logs:

- `frontend/src/components/AStopPopout.tsx:204` — pop-out console, **two-tap confirm** (3 s arm window).
- `frontend/src/components/MatchPanel.tsx:633` (and :312) — station page, **single click, no
  confirm**, rendered immediately next to the A-Stop button during auto. This is the likely
  culprit: contained warning "A-Stop" and contained error "E-Stop" side by side, small size, one
  click = match-long latch.

Fix: give MatchPanel's E-Stop the same two-tap arm as the popout (shared pattern), and make
A-Stop visually dominant during countdown/auto.

## Implementation design (incident-analysis-agent — for whichever thread finishes it)

Backend (`matchEngine.ts`):

- `undisable(station)` — keep peer's name. Guards: joined; `!eStop && !aStop`; phase in
  `auto | teleop | endgame` ONLY. On success: `enabled = true`, **and stamp `mode` from the
  current phase** (`auto` → `'auto'`, else `'teleOp'`). Gotcha: `enableParticipating` only writes
  `state.mode` for stations it enables, so a station stopped during auto still has `mode: 'auto'`
  when re-enabled in teleop — without the re-stamp the robot would run its auto code.
- Track disable source instead of a boolean: `disabledBy?: 'ds' | 'self' | 'admin'` (cleared on
  enable/reset). Team-facing undisable allowed for `'ds'` and `'self'`; `'admin'` requires the
  admin console (staff disabled it for a reason). `adminStationEnable` can clear any.
- Grace window: stamp `lastFmsEnableAt` per station on `enableParticipating`/`undisable`; in
  `dsReportedStatus`, ignore `!dsEnabled` reports within ~2 s of it (2 Hz heartbeats — a stale
  packet otherwise re-latches the disable immediately and undisable silently fails).
- E-stop recovery path: `clearEStop` stays admin-only and leaves the station disabled; the
  station then becomes undisable-eligible (or admin hits Enable). No auto-re-enable on clear.

Messages (`types.ts` / `websocketServer.ts`): `stationSelfUndisable` (team), `adminStationEnable`
(staff). Frontend: Re-enable button on station page + popout when
`!enabled && !eStop && !aStop && phase in auto/teleop/endgame`; per-station Enable in admin
console next to the existing Disable; two-tap E-Stop in MatchPanel.

Field test needed: whether a DS that latched a local Enter-disable actually re-enables when FMS
resumes the enable bit. If it latches DS-side, undisable can't recover and the UI hint should say
"re-enable from the Driver Station won't work — rejoin/restart DS" (whatever the test shows).

## Coordination

Two sessions got this task. incident-analysis-agent verified the incident (above), waited for the
peer's uncommitted `disabledByDs` edits to go quiet (>10 min, see `.agent.status`), then took over
and finished the implementation on top of that diff, applying all the design corrections. If you
are the original peer session: your groundwork was kept in spirit (`disabledBy` source tracking +
`undisable()`), reworked per the corrections, committed, and verified — nothing further to do.

## Outcome (2026-07-19)

Implemented and committed. Backend: `disabledBy` source tracking, `undisable(station, byAdmin)`
with phase/e-stop/a-stop/admin guards + mode re-stamp, `FMS_ENABLE_GRACE_MS = 2s` DS-report grace,
`stationSelfUndisable`/`adminStationEnable` messages. Frontend: shared `SelfServiceControls`
(station page, both panels) with Re-enable and two-tap E-Stop; RE-ENABLE ROBOT in the pop-out
match window; Enable buttons on `/admin` and `/match` admin rows. Verified by
`scripts/test-undisable-recovery.ts` (replays the 1678 sequence exactly, plus grace/guard cases).

Still open (needs a robot on the field): confirm a real DS that latched a local Enter-disable
re-enables when the FMS resumes the enable bit. If it doesn't, the Re-enable UI needs an extra
hint about restarting the DS. NOT deployed to steamboat — deploy is the user's call (live field).
