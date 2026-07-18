# Investigation: 5940's auto never started (2026-07-17 evening session)

## Goal

Explain why team 5940's robot never enabled during autonomous in the practice
matches around 18:14 on 2026-07-17, and determine whether the Jul 16 commits
(A-Stop `2de9068`, disable-echo `9b4594d`) caused it.

## Verdict (summary)

**The Jul 16 commits are exonerated.** The match engine entered auto and
enabled the station normally in both failed matches — no e-stop/a-stop/disable
latch fired (verified in journal windows that were reliably recorded). The
failure is in the DS↔FMS link: from 18:11:59 onward the DS never attached to
FMS (zero UDP 1160 heartbeats the entire session), so the robot never received
an enable. Two server-side robustness gaps turned that into a silent failure
(see "Systemic bugs" below). The trigger was a change in DS/laptop behavior
between ~17:00 and 18:11 — not a code deploy (deploy was Jul 16 16:22 and
Match 1 today at 16:54 worked).

## Timeline (all times PDT, 2026-07-17; server = steamboat, service PID 2843678 up since Jul 16 16:22)

- **16:54:10 Match 1** — auto 16:54:13, _paused mid-auto 16:54:27_, resumed,
  teleop 16:55:00 **worked** (paused/resumed again, completed normally, blue
  scored 2, 195 s). No telemetry flood, no type-29 errors, no journald
  suppression in this window. Auto-period score was 0 (autoWinner "red" via
  random tiebreak) — whether auto actually ran is ambiguous.
- **18:11:23–41** — WebSocket clients from DS laptop 10.55.65.16 connect.
- **18:11:59** — "First telemetry received: team 5940 -> slot1". From this
  exact moment: `Error parsing TCP message: Unknown message type 29` every
  ~3 s (218 total, none ever before), plus a type-22 (LogData) flood (~14/s,
  garbage-looking values: `brownout: true` at 12.4 V) that drove journald to
  suppress ~11 000 messages per 30 s.
- **18:12:22** — `DS stale: slot1 (last seen 23s ago)` + drive session/DNAT
  cleared. Proves NO teamNumber-bearing message (TCP 0x18 or UDP heartbeat)
  arrived after 18:11:59 → **DS never attached to FMS** (a DS in FMS mode
  heartbeats on UDP 1160 at 2 Hz).
- **18:14:04 Match 2** — countdown; auto entered at 18:14:07 (proven by
  match-history `startedAt`; the log line was suppressed). Robot never
  enabled. **18:14:24 user hit Global E-Stop** (recorded as endReason estop).
- **18:14:56 Match 3** — "Autonomous period started" 18:14:59. The journal
  window 18:14:51→~18:15:05 was reliably recorded (burst budget) and contains
  NO `DS e-stop/a-stop/disable reported`, no `A-Stop:`, no `E-Stop:` lines —
  so the engine had the station enabled; packets were the problem. Match 3
  has no match-history entry (history is only written on transition to
  postMatch; the station likely just left).
- **18:27:38** — DS TCP reconnect → 0x18 → "Drive started" (free-drive
  resumed). Still zero UDP 1160 traffic (confirmed by live tcpdump 18:28).
  Reconnect churn now ~every 40 s ("27 rapid reconnects in the last 18m") vs
  the historical ~6 s flapping.

## Root-cause chain

1. DS discovery/liveness (`matchEngine.dsConnections`) is refreshed ONLY by
   teamNumber-bearing messages: TCP 0x18 (sent once per TCP connection) or
   UDP 1160 heartbeats (sent only when the DS is attached to FMS).
2. This session the DS held a long-lived TCP connection (no 0x18 refreshes)
   and never attached to FMS (no UDP heartbeats) → the 20 s stale sweep
   repeatedly deleted the entry.
3. `sendDSPacket` (src/matchEngine.ts:955) does `if (!ip) return;` — control
   packets (including the auto ENABLE) were **silently dropped** whenever the
   entry was missing.
4. Even in windows where the entry was alive (~20 s after each reconnect,
   and 18:11:59–18:12:19 when 200 ms-cadence idle heartbeats were definitely
   sent — zero "Failed to send DS packet" errors), the DS still never
   attached → FMS→DS UDP 1121 was likely not reaching the DS application.
   Prime suspects: Windows firewall on the DS laptop (inbound UDP blocked
   after a network-profile change; TCP 1750 is DS-outbound so it still
   works), a DS software update (would also explain the brand-new type-29
   message), or a different laptop. Robot relay UDP (:1150) did reach the
   laptop, which weakens but doesn't kill the firewall theory (NI installs
   per-app rules; profiles differ).

## Why the Jul 16 commits are cleared

- A-Stop DS-bit latch (`DS a-stop reported`), DS disable race
  (`DS disable reported`), and station A-Stop button (`A-Stop:`) all log
  one-liners. None appear in the reliably-recorded window around Match 3's
  countdown/auto start where they would have been captured.
- The DS never sent a single UDP heartbeat this session, so
  `dsReportedStatus` (the only consumer of the new AStop bit) never even ran.
- `9b4594d` only removed an immediate echo packet after a DS-reported stop;
  no DS-reported stop occurred.

## Systemic bugs exposed (fix candidates, in rough priority)

1. **Silent packet drop**: `sendDSPacket` returns silently with no DS
   address. A joined, "ready" station can play a whole match receiving
   nothing. Should surface loudly (admin UI + log) when a joined station has
   no live DS connection at countdown/auto start.
2. **Liveness too narrow**: a TCP connection actively streaming type-22
   telemetry does not count as "alive". Refresh `lastSeen` on ANY message
   from the DS's connection/IP.
3. **"Ready" doesn't imply FMS-attached**: the UI let the match start while
   the DS had never heartbeated. Consider gating ready/start (or at least a
   warning chip) on "DS attached" (recent UDP 1160).
4. **Unknown message type 29**: new DS TCP message appeared 18:11:59.
   Identify it (DS version bump?) and parse/ignore without erroring. Also
   verify the type-22 flood isn't a framing/desync artifact of the parser
   (`ByteToObjectTransform` recovery paths) — garbage values suggest
   misparse.
5. **Log spam vs journald**: "Received object from TCP stream" dumps caused
   ~11 k suppressed messages per 30 s, nearly destroying the evidence. Gate
   the telemetry dumps behind a debug flag (or separate sink) and/or raise
   journald RateLimitBurst for the unit.
6. **Known enable race still open** (plans/a-stop.md "Adjacent real race"):
   stale DS heartbeat can disable a station right after auto/teleop enable
   with nothing re-enabling it. Did NOT fire here, but remains a plausible
   intermittent auto-killer for past/future sessions.
7. **Minor**: matches ending via "all stations left" are never written to
   match history (Match 3 vanished).

## Fixes applied (2026-07-17 evening, deployed while team practiced)

- [x] Scoreboard stuck in match mode after the failed matches — reset live via
      `PUT /api/score/mode` (X-API-Key from api-keys.json on steamboat), AND
      fixed the root cause: scoring now returns to freePlay on ANY transition
      into idle, not just postMatch→idle (`src/scoringEngine.ts`).
- [x] Fix #2 (liveness too narrow): telemetry-only TCP messages from the DS
      that owns a drive session now refresh `touchDsActivity` +
      `trySetDSAddress` (`src/index.ts` fms message handler).
- [x] Fix #4 (partial): unknown DS TCP message types are skipped gracefully,
      logged once per type with hex payload for identification
      (`src/fmsServer.ts`).
- [x] Fix #5: per-message TCP/UDP dumps gated behind `FMS_LOG_DS_MESSAGES`
      env var (`src/fmsServer.ts`).
- [ ] Fix #1 (loud warning on silent packet drop in `sendDSPacket`) — NOT
      done; matchEngine.ts has a peer thread's uncommitted changes.
- [x] Related (deployed a35019d): joining a match now force-closes the DS's
      TCP connection so the re-handshake hands the DS to FMS (disabled)
      immediately; leave/kick/post-match release force a re-handshake that
      returns local control. Fixes takeover/release lag on long-lived DS
      connections.
- [ ] Fix #3 (gate ready/start on FMS-attached), #6 (enable race), #7 (match
      history for abandoned ends) — follow-ups.

## Open questions

1. What is on 10.55.65.16 now — same laptop as 16:54? DS version? Windows
   firewall profile? (Needs a human at the field; check DS "FMS Connected"
   indicator during a test match.)
2. Was any server/network change applied on steamboat between 17:00 and
   18:11 today (dhcpcd DNS-isolation work is in progress in the tree —
   uncommitted plan edits — but the deployed code predates working Match 1)?
3. Did Match 1's auto actually run? (0 auto points + mid-auto pause is
   suspicious; user says autos "may never have worked".)

## Things not to do

- Don't trust absence of a journal line during 18:12–18:25 as evidence —
  journald dropped ~11 k messages/30 s. Reliable burst windows: ~14 s after
  each `Suppressed ...` notice (e.g. 18:14:51→18:15:05).
- Don't trust the type-22 `ds:`/`robot:`/`brownout` dumps from this session —
  values look misparsed.
- `tcpdump udp port 1160` on steamboat is the ground truth for "DS attached
  to FMS" (read-only, safe).
