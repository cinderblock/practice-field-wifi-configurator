/**
 * Minimal fake backend for eyeballing the DS-client operator guard
 * (`bun scripts/fake-backend-ds-guard.ts [ds|clean]`).
 *
 * Serves /ws on :3000 (the vite dev proxy target) and feeds every client a
 * MatchEngine-built matchState plus a routePreferenceState. In `ds` mode
 * (default) the client's reported IP matches slot3's connected DS, so /match
 * and /staff must show the "This is a Driver Station" block; in `clean` mode
 * the IPs differ and the pages must render normally.
 */
import { WebSocketServer } from 'ws';
import { MatchEngine } from '../src/matchEngine.js';
import type { RoutePreferenceState } from '../src/types.js';

const mode = process.argv[2] === 'clean' ? 'clean' : 'ds';
const DS_IP = '10.16.78.101';
const YOUR_IP = mode === 'ds' ? DS_IP : '10.255.0.99';

const engine = new MatchEngine(s => (s === 'slot3' ? 1678 : null));

const wss = new WebSocketServer({ port: 3000, path: '/ws' });
wss.on('connection', ws => {
  const state = {
    ...engine.getState(),
    connectedStations: { slot3: { ip: DS_IP, lastSeen: Date.now() } },
  };
  ws.send(JSON.stringify(state));
  ws.send(
    JSON.stringify({
      type: 'routePreferenceState',
      yourIp: YOUR_IP,
      preference: null,
      conflictingTeams: {},
    } satisfies RoutePreferenceState),
  );
  console.log(`client connected — mode=${mode} yourIp=${YOUR_IP} dsIp=${DS_IP}`);
  // Log inbound messages — the staff page must NOT send staffHeartbeat while blocked
  ws.on('message', raw => console.log(`recv: ${raw.toString()}`));
});
console.log(`fake backend on :3000 (mode=${mode})`);
