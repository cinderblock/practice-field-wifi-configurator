# Robot can still move while match is "paused"

## Goal

A team ran a solo practice match (~1:49pm, Thu 2026-07-23), clicked **Pause**, and
could still occasionally move their robot. Diagnose and fix the enable/disable
signalling so a paused match reliably holds every robot disabled.

(Separate, tracked elsewhere: the UX that made Pause confusing to click.)

## Root cause — the FMS goes SILENT during a pause (not "thrashing")

In `src/matchEngine.ts`, `pauseMatch()` (lines ~688-700):

1. `stopTick()` — kills the 250ms tick, the ONLY caller of `sendPacketsToAll()`
   during a match.
2. `disableAll()` — sets `enabled=false` on all stations.
3. `sendPacketsToAll()` — sends **exactly one** disable packet per joined DS.

After that, nothing transmits until `resumeMatch()`:

- Tick is stopped.
- `sendJoinedHeartbeat()` (200ms fallback sender) returns early because
  `if (this.isMatchActive()) return;`, and `isMatchActive()` is TRUE for
  `'paused'` (only excludes idle/created/postMatch, lines ~919-921).

So a paused match = single disable packet, then radio silence to the DS.

### Why that lets a robot keep moving (both intermittent)

1. **Dropped disable is never retried.** Live match streams at 4Hz so a lost UDP
   disable self-corrects in 250ms. During pause there is ONE disable packet; if
   that datagram is lost (wifi/L2 — see field-l2-reachability-arp memory), the DS
   keeps relaying the pre-pause _enabled_ state and the FMS never corrects it.
   Probabilistic → "occasionally."
2. **FMS-comms watchdog stops being fed.** Real FMS streams the disabled state
   continuously through a hold so the DS/roboRIO watchdog stays alive. Going dark
   makes loss-of-FMS-comms behavior DS/firmware dependent; some revert toward
   local control instead of latched-disable.

### Paths that DON'T have the bug (confirms diagnosis)

- `stopMatch()` / end-of-match: tick keeps running for the postMatch counting
  period, so packets keep flowing.
- `resumeMatch()`: restarts the tick → packets flow again (why resume "fixes" it).
- Only `pauseMatch()` leaves the field with no transmitter.

## Fix (APPLIED)

`sendJoinedHeartbeat()` now keys on the tick being stopped (`if (this.tickTimer)
return;`) instead of `isMatchActive()`. Whenever the 250ms tick isn't running —
paused, autoPause frozen awaiting a winner, pre-match, postMatch-after-stop —
the 200ms heartbeat streams the current (disabled) state to every joined DS.
The tick remains the sole transmitter while it runs, so there's no double-send.

This also fixed a second instance of the same silence: `autoPause` with
`autoWinner: 'pause'` stops the tick while awaiting manual winner selection.

## Verification

`bun scripts/test-pause-stream.ts` — engine-level test with a fake DS bound to
127.0.0.1:1121. Confirms: teleop streams enabled packets; after `pauseMatch()`
packets KEEP flowing (~5-6/s) with the enabled bit clear on every one; after
`resumeMatch()` the enabled stream returns. ALL PASS (2026-07-24).

## Progress log

- [x] Read matchEngine.ts + fmsServer.ts, traced all packet transmitters.
- [x] Confirmed pause = one disable packet then silence.
- [x] Fix: heartbeat transmits whenever the tick is stopped.
- [x] Verified end-to-end via scripts/test-pause-stream.ts (real UDP on 1121).
- [x] Committed (matchEngine hunk + test + this plan only — shared worktree,
      other threads' staff-ready changes left unstaged).

## Things not to do

- Don't "fix" by sending the e-stop/a-stop bits — those are backend-only by design
  (see sendDSPacket comment, line ~1295). The disable bit is correct; it just has
  to be sent continuously.
