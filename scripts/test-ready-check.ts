/**
 * Engine-level test for the host-gated ready check + staff roles
 * (`bun scripts/test-ready-check.ts`).
 *
 * Verifies:
 *   - teams can't ready until the host opens the ready check
 *   - a match won't start until the check is open, all teams ready, and every
 *     non-ignored staff role is ready
 *   - ignoring a staff role drops it from the start gate (and clears its ready)
 *   - a roster change (join/leave) re-closes the ready check
 *   - staff "ignore" choices persist across a new match; readiness resets
 *
 * Runs against MatchEngine directly — no sockets, no DS needed.
 */
import { MatchEngine } from '../src/matchEngine.js';
import { StaffRoleList } from '../src/types.js';
import type { StationName, StaffRole } from '../src/types.js';

const engine = new MatchEngine(s => (s === 'slot1' ? 111 : s === 'slot2' ? 222 : null));

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const st = (name: StationName) => engine.getState().stationStates[name]!;
const staff = (role: StaffRole) => engine.getState().staffStates[role];
const phase = () => engine.getState().phase;
const readyRequested = () => engine.getState().readyRequested;

// ── Setup ──────────────────────────────────────────────────────────
engine.createMatch();
check('new match: ready check closed', readyRequested() === false);
check(
  'new match: all staff required, not ready',
  StaffRoleList.every(r => !staff(r).ignored && !staff(r).ready),
);

engine.joinStationAlliance('slot1', 'red');
engine.joinStationAlliance('slot2', 'blue');

// ── Ready is gated on the host opening the check ────────────────────
engine.setReady('slot1', true);
check('team cannot ready before host opens check', st('slot1').ready === false);

engine.setReadyRequested(true);
check('host opened the ready check', readyRequested() === true);
engine.setReady('slot1', true);
engine.setReady('slot2', true);
check('teams can ready once check is open', st('slot1').ready && st('slot2').ready);

// ── Staff gate the start ────────────────────────────────────────────
engine.startMatch();
check('start blocked while required staff not ready', phase() === 'created');

// Ready two of three staff, ignore the third
engine.setStaffReady('headRef', true);
engine.setStaffReady('scorekeeper', true);
engine.startMatch();
check('start still blocked with one required staff unready', phase() === 'created');

engine.setStaffIgnored('safety', true);
check('ignoring a role marks it not required', staff('safety').ignored === true);

engine.startMatch();
check('start succeeds once teams + non-ignored staff ready', phase() === 'countdown');

// ── Ignoring clears that role's ready ───────────────────────────────
engine.abortCountdown();
check('abort returns to setup', phase() === 'created');
check('abort keeps the ready check open', readyRequested() === true);
engine.setStaffReady('headRef', true); // re-affirm (still ready after abort)
engine.setStaffIgnored('headRef', true);
check('ignoring a ready role clears its ready', staff('headRef').ready === false);

// ── Roster change re-closes the check ───────────────────────────────
engine.setStaffIgnored('headRef', false); // require it again for this test
engine.setStaffIgnored('safety', false);
engine.setReadyRequested(true);
engine.setReady('slot1', true);
engine.joinStationAlliance('slot3', 'red'); // late joiner
check('a late join re-closes the ready check', readyRequested() === false);
check('a late join clears prior readies', st('slot1').ready === false);

// ── Ignore persists across a new match; readiness resets ────────────
engine.setStaffIgnored('safety', true);
engine.cancelMatch();
engine.createMatch();
check('ignore choice persists across a new match', staff('safety').ignored === true);
check(
  'staff readiness resets on a new match',
  StaffRoleList.every(r => !staff(r).ready),
);
check('ready check closed again on a new match', readyRequested() === false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
