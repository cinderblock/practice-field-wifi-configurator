/**
 * Check the setup surface closes once a field is claimed
 * (`bun scripts/test-setup-auth.ts`).
 *
 * Needs a backend running with a scratch config, e.g.:
 *   DRY_RUN=1 WEBSOCKET_PORT=3500 SETUP_CONFIG_FILE=setup.tmp.json \
 *   ADMIN_AUTH_FILE=admin.tmp.json bun src/index.ts
 *
 * Before a passphrase exists the wizard must be writable by anyone (that's how
 * a fresh install gets set up). Once one exists, setup writes must require
 * admin — `radioUrl` decides where every team's WPA key gets POSTed.
 */
import WebSocket from 'ws';

const PORT = process.env.WEBSOCKET_PORT ?? '3500';

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const seen: Record<string, unknown[]> = {};
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(String(raw)) as { type?: string; error?: string };
      const key = msg.type ?? (msg.error ? 'error' : 'other');
      (seen[key] ??= []).push(msg);
    } catch {
      /* ignore non-JSON */
    }
  });
  await new Promise<void>((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  await sleep(600);
  return { ws, seen };
}

const radioOf = (seen: Record<string, unknown[]>) =>
  (seen.setupConfigState?.at(-1) as { config?: { settings?: { radioUrl?: string } } } | undefined)?.config?.settings
    ?.radioUrl;

// ── Before a passphrase exists: writable ────────────────────────────
{
  const { ws, seen } = await connect();
  ws.send(JSON.stringify({ type: 'updateSetupSettings', settings: { radioUrl: 'http://10.0.100.7' } }));
  await sleep(900);
  check('unclaimed field accepts setup writes', radioOf(seen) === 'http://10.0.100.7', `got ${radioOf(seen)}`);

  // Claim the field.
  ws.send(JSON.stringify({ type: 'adminSetPassphrase', passphrase: 'test-passphrase' }));
  await sleep(1200);
  ws.close();
}

// ── After a passphrase exists: refused on a fresh, unauthenticated socket ──
{
  const { ws, seen } = await connect();
  const before = radioOf(seen);

  ws.send(JSON.stringify({ type: 'updateSetupSettings', settings: { radioUrl: 'http://10.0.100.99' } }));
  await sleep(1000);

  check(
    'claimed field refuses unauthenticated setup writes',
    radioOf(seen) === before,
    `radioUrl became ${radioOf(seen)}`,
  );
  check(
    'refusal is reported to the client',
    (seen.error ?? []).some(e => String((e as { error: string }).error).includes('Admin authentication required')),
  );

  ws.send(JSON.stringify({ type: 'markSetupStep', step: 'host', status: 'done' }));
  await sleep(800);
  const steps = (seen.setupConfigState?.at(-1) as { config?: { steps?: Record<string, unknown> } } | undefined)?.config
    ?.steps;
  check('claimed field refuses unauthenticated step marks', steps?.host === undefined);

  ws.close();
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
