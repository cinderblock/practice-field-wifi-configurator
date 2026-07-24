# Radio commits silently failing ("Enable" does nothing) — team 8048 blocked on field

## Goal

Team 8048 is at the field now; clicking "Enable" (or applying staged changes) on
the team control page does nothing. Diagnose, fix, deploy. Also rename the
"Enable" button — "enable" has a reserved meaning in FIRST robotics (robot
enable) and must not be overloaded for radio config.

## Root cause (confirmed from steamboat journalctl)

Every radio commit since ~13:36 fails with:

```
Error enabling saved robot 8048-COMP on slot1: Command failed: ip addr del 10.30.49.254/24 dev br-slot2
Error: ipv4: Address not found.
```

- `10.30.49.x` = team 3049 — one of the six fake teams from
  `scripts/fake-six-teams.ts` (commit cc7a659, run today ~13:33).
- `networkManager.updateNetworkConfig` tears down the previous team's address
  before configuring the new set. `previousStations` still says slot2=3049 but
  the address is already gone from `br-slot2`.
- `removeAddress` (`src/node-ip/linux.ts:127`) tolerates stderr
  `Cannot assign requested address` and `does not exist`, but NOT this
  iproute2's `Error: ipv4: Address not found.` → throws → whole commit aborts.
- Self-perpetuating: `previousStations` is only updated at the END of a fully
  successful pass (`networkManager.ts:286`), so the stale entry survives every
  retry.
- Second bug: the backend DID send `{error, details}` to the browser each time,
  but `useBackend.ts` routes any error WITH `details` to `handleErrorEntry`
  (console.error only, line 540) instead of the `serverResponse` snackbar
  (which only catches errors WITHOUT details). Team saw nothing.

Note: `active-config.json` on steamboat already shows slot1=8048-COMP — the
immediate-apply path updated app state; only the kernel/radio commit failed.

## Environment

- Production = `steamboat` (`ssh steamboat`, repo at
  `~/practice-field-management-system`). `pfms.tsl` resolves to it on the field
  network. Deploy = `.claude/skills/deploy` → `ssh steamboat "cd
practice-field-management-system && ./update.sh"`.
- Service: `practice-field-management-system.service`, pid logs via journalctl.

## Decisions already made (don't re-ask)

- Rename team-page "Enable" → "Stage and Apply" (user request; "enable" is
  FRC-reserved). The match-control/admin "Enable" (actual robot enable) keeps
  its name — there it IS the FRC meaning.
- Fix is code + deploy, not manual `ip addr` surgery on steamboat (deploy
  restarts the service, which rebuilds `previousStations` from active config,
  clearing the stale 3049 entry).

## Follow-up round 2 — the REAL radio-wipe root cause (setSyslogIP)

Deploying the reconnect-reconcile fix at 14:15 kicked team 8048 off the radio
again, which exposed the actual mechanism: **`setSyslogIP()` POSTed a
syslog-only /configuration body, and the radio applies every POST as a full
replacement — wiping all station configs. It runs on EVERY service start**
(index.ts runSyslogServer callback). So each deploy cleared the radio; the
14:02 all-null radio was this wipe from the 13:59 deploy, not (only) the
connected-flag race. Corrected timeline: 13:36 enableSavedRobot DID push
8048 to the radio (configureRadio ran in Promise.all despite the
configureNetwork failure); 13:59 deploy wiped it; 14:02 manual applyConfig
restored; 14:15 deploy wiped again; 14:19 manual restore; 14:2x fixes below.

- [x] `setSyslogIP` now: waits for first status poll, **skips entirely when
      the radio already reports that syslog IP** (the every-deploy case →
      no radio reconfigure at all on normal restarts), and includes
      activeConfig stations when it does push. The PatchBug clear-all path
      in configureRadio posts syslog-only directly, bypassing the guard.
- [x] Reconcile hardened: transition-only check replaced by a continuous
      debounced check on every successful poll (`checkRadioConfigSync`,
      `RADIO_RECONCILE_DEBOUNCE_MS` default 15s) — catches ANY divergence
      (wipe mid-session, reboot, race), guarded by configuring/queuedCommits.
- [x] Harness extended to 8 checks incl. syslog no-op, syslog+stations POST,
      and mid-session wipe auto-repair. All green.

## Follow-up round 1 (user: "do it") — radio-push race fixed

- [x] `reconcileAfterConnect()` in radioManager: on the poller's
      connected false→true transition (radio ACTIVE, no commit in flight),
      compare radio `stationStatuses` SSIDs to activeConfig; re-commit on
      mismatch. Covers both the startup race and a radio that
      rebooted/cleared while the service ran.
- [x] Commit-queue poisoning fix (found while implementing): commitQueue
      chained with bare `.then()`, so ONE rejected commit made every
      subsequent commit re-reject instantly with the stale error without
      executing — this is why every retry at 13:36–13:40 replayed the
      identical `ip addr del` error. Now chains `.catch(() => {}).then(...)`;
      `queuedCommits` counter lets reconcile skip redundant commits.
- [x] `retryDeferredCommit()` no longer drops commit rejections on the floor.
- [x] Harness: `scripts/test-radio-reconcile.ts` (fake radio HTTP API +
      real RadioManager, `DRY_RUN=1 bun scripts/test-radio-reconcile.ts`
      on Windows). Replays the incident (empty radio on connect → auto
      re-push) and the poisoned-queue regression. All green.

## Plan / steps — ALL DONE 2026-07-24 ~14:05

- [x] Diagnose (logs on steamboat; traced code path)
- [x] Fix 1: `removeAddress` tolerates `Address not found` (f3c3921)
- [x] Fix 2: surface `{error, details}` messages in the snackbar (af86b4e)
- [x] Fix 3: rename "Enable"→"Stage and Apply" + related wording (e37892a)
- [x] typecheck, commit, deploy via deploy skill (pushed cc7a659..e37892a)
- [x] Verify live: startup re-applied kernel config ("Network configuration
      applied", br-slot1 has 10.80.48.254/24); radio needed a manual nudge
      (below) — after which red1 = 8048-COMP, isLinked:true, -50dBm,
      quality "excellent". Team 8048 unblocked.

## Findings / gotchas

- **Third bug found during verification (now in ISSUES.md):** after the deploy
  restart, the kernel network was rebuilt but the radio push was silently
  skipped — startup's re-apply runs after `waitForRadio()`, but
  `configureRadio()` gates on `radioManager.connected`, which only the 100ms
  status poller sets; the commit beat the first poll. Nothing reconciles on
  the connected transition. Radio showed all-null `stationStatuses` while
  active-config had 8048. Manual fix: sent `{"type":"applyConfig"}` over the
  local websocket (script left at `/tmp/apply-config.js` on steamboat; run
  with `~/.bun/bin/bun`), radio went CONFIGURING→ACTIVE with red1=8048-COMP.
- Deploy hiccup: steamboat had an untracked `scripts/fake-six-teams.ts`
  (written server-side before it was committed) blocking `git pull`; verified
  byte-identical to the committed version, removed it, redeployed.
- Radio status oracle: `curl -s http://10.0.100.2/status` from steamboat —
  shows per-station config + link state. `stationStatuses.red1 = null` means
  NOT configured on the radio, regardless of what active-config.json says.

- `fake-six-teams.ts` cleanup ran/failed partway: slot2's address got deleted
  but a later step failed, so `previousStations` kept 3049 → poisoned state.
- `radioManager.configure()` also silently no-ops when `this.configuring` is
  true, and `commitConfiguration()` silently defers when a match is active or
  any robot telemetry says enabled (`enabledStations` entries are never aged
  out). Not today's bug, but same "silent failure" family — candidates for
  ISSUES.md later.

## Things not to do

- Don't run `fake-six-teams.ts` on the live field while teams are present.
- Don't "fix" by flushing addresses manually on steamboat — deploy restart
  self-heals and the code fix prevents recurrence.
