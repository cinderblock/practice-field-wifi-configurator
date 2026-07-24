/**
 * Harness for RadioManager's reconnect reconcile and commit-queue isolation
 * (`bun scripts/test-radio-reconcile.ts`). No radio or root needed — spins a
 * fake radio HTTP API on 127.0.0.1 and points a real RadioManager at it
 * (no radioManagementInterface, so no kernel network calls).
 *
 * Scenario 1 (2026-07-24 incident): active-config has a team but the radio
 * comes up empty → expect an automatic POST /configuration with that SSID
 * shortly after the first successful status poll, with no user action.
 *
 * Scenario 2: a commit whose POST /configuration returns 500 must not poison
 * the commit queue — a subsequent commit must still reach the radio.
 */
import { createServer } from 'node:http';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const activeConfigPath = join(tmpdir(), `test-reconcile-active-${process.pid}.json`);
const stagedConfigPath = join(tmpdir(), `test-reconcile-staged-${process.pid}.json`);
process.env.ACTIVE_CONFIG_FILE = activeConfigPath;
process.env.STAGED_CONFIG_FILE = stagedConfigPath;

writeFileSync(activeConfigPath, JSON.stringify({ slot1: { ssid: '8048-COMP', wpaKey: '80488048' } }));

const { default: RadioManager } = await import('../src/radioManager.js');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Fake radio ───────────────────────────────────────────────────────
let radioStatus: 'ACTIVE' | 'CONFIGURING' = 'ACTIVE';
let fail500 = false;
const configPosts: any[] = [];

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/status') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        channel: 13,
        channelBandwidth: '40MHz',
        redVlans: '10_20_30',
        blueVlans: '40_50_60',
        status: radioStatus,
        stationStatuses: { red1: null, red2: null, red3: null, blue1: null, blue2: null, blue3: null },
        syslogIpAddress: '10.0.100.5',
        version: 'VH-109_AP_PRACTICE_TEST',
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/configuration') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      if (fail500) {
        res.statusCode = 500;
        res.end('injected failure');
        return;
      }
      configPosts.push(JSON.parse(body));
      radioStatus = 'CONFIGURING';
      setTimeout(() => (radioStatus = 'ACTIVE'), 300);
      res.end('{}');
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});

await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;

let failures = 0;
const check = (name: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failures++;
};

// ── Scenario 1: reconcile on first connect ───────────────────────────
const radioManager = new RadioManager(`http://127.0.0.1:${port}`);

await sleep(2000); // first poll connects ~100ms in; reconcile commit + fake 300ms configure fit well within this

check(
  'reconcile pushed active config to empty radio on connect',
  configPosts.length === 1 && configPosts[0]?.stationConfigurations?.red1?.ssid === '8048-COMP',
  `posts=${configPosts.length} body=${JSON.stringify(configPosts[0] ?? null)}`,
);

// ── Scenario 2: failed commit must not poison the queue ──────────────
fail500 = true;
const firstErr = await radioManager.commitConfiguration().then(
  () => null,
  (err: unknown) => err,
);
check('commit with radio 500 rejects', firstErr instanceof Error, String(firstErr));

fail500 = false;
const secondErr = await radioManager.commitConfiguration().then(
  () => null,
  (err: unknown) => err,
);
check('next commit succeeds after a failed one', secondErr === null, String(secondErr));
check('next commit actually reached the radio', configPosts.length === 2, `posts=${configPosts.length}`);

// ── Cleanup ──────────────────────────────────────────────────────────
radioManager.stopPolling();
server.close();
rmSync(activeConfigPath, { force: true });
rmSync(stagedConfigPath, { force: true });

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
