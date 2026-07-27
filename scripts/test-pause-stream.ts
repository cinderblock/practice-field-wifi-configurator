/**
 * Engine-level test that the DS control-packet stream never goes silent while
 * a match is paused (`bun scripts/test-pause-stream.ts`).
 *
 * Background (2026-07-23): pausing a match sent a single disable packet and
 * then stopped transmitting entirely — if that one datagram was lost, the DS
 * kept the pre-pause enabled state and the robot could still drive "while
 * paused". The fix keys the 200ms heartbeat on the tick being stopped, so a
 * paused match keeps streaming the disabled state.
 *
 * Also covers the resume countdown (2026-07-27): resuming no longer enables
 * instantly — robots stay disabled through a 3s "3… 2… 1…" warning, and
 * pausing again during it cancels the resume.
 *
 * Verifies, with a fake DS listening on 127.0.0.1:1121:
 *   - packets stream during teleop with the enabled bit set
 *   - packets KEEP streaming after pauseMatch(), all with enabled bit clear
 *   - resumeMatch() starts a countdown without leaving 'paused'
 *   - pausing during the countdown cancels it, still disabled
 *   - the enabled bit stays clear for the whole countdown (no early enable)
 *   - after the countdown the match is in teleop with the enabled bit set
 */
import dgram from 'dgram';
import { MatchEngine } from '../src/matchEngine.js';
import { UdpSendPort } from '../src/fmsServer.js';

const engine = new MatchEngine(s => (s === 'slot1' ? 111 : null));

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Control byte is offset 3 (seq:2, commVersion:1, control:1); enabled = 0x04
const ENABLED_BIT = 0x04;
let received: number[] = [];

const dsSocket = dgram.createSocket('udp4');
await new Promise<void>(resolve => dsSocket.bind(UdpSendPort, '127.0.0.1', resolve));
dsSocket.on('message', msg => received.push(msg[3]));

async function sample(ms: number) {
  received = [];
  await sleep(ms);
  return received.slice();
}

// ── Drive a match into teleop ───────────────────────────────────────
engine.setDSAddress('slot1', '127.0.0.1');
engine.createMatch();
engine.joinStationAlliance('slot1', 'red');
engine.updateMatchConfig({
  autoDuration: 20,
  teleopDuration: 140,
  endgameDuration: 30,
  pauseDuration: 3,
  skipAuto: true,
  autoWinner: 'red',
});
engine.setReadyRequested(true);
engine.setReady('slot1', true);
for (const role of ['headRef', 'scorekeeper', 'safety'] as const) engine.setStaffIgnored(role, true);
engine.startMatch();
check('match started (countdown)', engine.getState().phase === 'countdown');

// Countdown is 3s; wait it out plus a little margin
await sleep(3_500);
check('reached teleop (auto skipped)', engine.getState().phase === 'teleop');

const teleopPackets = await sample(1_000);
check('teleop: packets streaming (got ' + teleopPackets.length + ' in 1s)', teleopPackets.length >= 3);
check('teleop: enabled bit set', teleopPackets.length > 0 && teleopPackets.every(b => (b & ENABLED_BIT) !== 0));

// ── Pause: the stream must continue, all-disabled ───────────────────
engine.pauseMatch();
check('paused', engine.getState().phase === 'paused');

const pausedPackets = await sample(1_000);
check('paused: packets STILL streaming (got ' + pausedPackets.length + ' in 1s)', pausedPackets.length >= 3);
check(
  'paused: enabled bit clear on every packet',
  pausedPackets.length > 0 && pausedPackets.every(b => (b & ENABLED_BIT) === 0),
);

// ── Resume countdown cancelled: stays paused and disabled ───────────
engine.resumeMatch();
check('resume countdown started', engine.getState().resumeAt !== undefined);
check('resume countdown: still paused', engine.getState().phase === 'paused');

engine.pauseMatch(); // pausing during the countdown cancels the resume
check('resume cancelled: resumeAt cleared', engine.getState().resumeAt === undefined);
check('resume cancelled: still paused', engine.getState().phase === 'paused');

const cancelledPackets = await sample(500);
check(
  'resume cancelled: enabled bit still clear',
  cancelledPackets.length > 0 && cancelledPackets.every(b => (b & ENABLED_BIT) === 0),
);

// ── Resume: robots stay disabled for the whole 3s countdown ─────────
engine.resumeMatch();
check('resume countdown restarted', engine.getState().resumeAt !== undefined);

// Sample most of the countdown — robots must NOT enable early
const countdownPackets = await sample(2_000);
check(
  'resume countdown: packets still streaming (got ' + countdownPackets.length + ' in 2s)',
  countdownPackets.length >= 5,
);
check(
  'resume countdown: enabled bit clear for the whole countdown',
  countdownPackets.length > 0 && countdownPackets.every(b => (b & ENABLED_BIT) === 0),
);
check('resume countdown: still paused mid-count', engine.getState().phase === 'paused');

// Let the countdown finish
await sleep(1_500);
check('resumed to teleop after countdown', engine.getState().phase === 'teleop');
check('resumed: resumeAt cleared', engine.getState().resumeAt === undefined);

const resumedPackets = await sample(1_000);
check('resumed: packets streaming (got ' + resumedPackets.length + ' in 1s)', resumedPackets.length >= 3);
check(
  'resumed: enabled bit set again',
  resumedPackets.length > 0 && resumedPackets.every(b => (b & ENABLED_BIT) !== 0),
);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
