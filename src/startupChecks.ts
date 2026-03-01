import { execFile } from 'node:child_process';
import { isValidRadioUpdate, type RadioUpdate } from './types.js';
import type { NetworkBackend } from './node-ip/index.js';

/**
 * Block startup until the radio responds to /status.
 * Retries every 10 seconds with a clear log message.
 */
export async function waitForRadio(url: string): Promise<RadioUpdate> {
  const statusUrl = `${url}/status`;
  let attempt = 0;

  while (true) {
    try {
      const response = await fetch(statusUrl, {
        signal: AbortSignal.timeout(3000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data: RadioUpdate = await response.json();

      if (!isValidRadioUpdate(data)) {
        throw new Error('Invalid radio status response');
      }

      console.log(`Radio connected (version: ${data.version})`);
      return data;
    } catch (err) {
      attempt++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Waiting for radio at ${url} (attempt ${attempt}: ${msg}) — retrying in 10s`);
      await delay(10_000);
    }
  }
}

/**
 * Parse the firmware mode from the radio version string.
 * Expected format: VH-109_AP_PRACTICE_1.2.9-02102025
 */
export function detectFirmwareMode(version: string): 'PRACTICE' | 'OFFSEASON' | 'FRC' | 'UNKNOWN' {
  const upper = version.toUpperCase();

  if (upper.includes('OFFSEASON')) {
    console.log(`Radio firmware: OFFSEASON (${version})`);
    return 'OFFSEASON';
  }

  if (upper.includes('PRACTICE')) {
    console.log(`Radio firmware: PRACTICE (${version})`);
    console.warn(
      'WARNING: PRACTICE firmware detected. VLAN management and routing will not work as expected. Switch to OFFSEASON firmware for full functionality.',
    );
    return 'PRACTICE';
  }

  if (upper.includes('FRC')) {
    console.log(`Radio firmware: FRC (${version})`);
    console.warn('WARNING: FRC firmware detected. This mode requires bearer token authentication.');
    return 'FRC';
  }

  console.warn(`Radio firmware: UNKNOWN (${version})`);
  return 'UNKNOWN';
}

/**
 * Ensure that the VLAN interface has the expected IPs configured.
 * Adds any missing IPs automatically.
 */
export async function checkInterfaceIps(iface: string, expectedIps: string[], net: NetworkBackend): Promise<void> {
  const interfaces = await net.listInterfaces(iface);

  if (interfaces.length === 0) {
    console.error(`Interface check: ${iface} does not exist`);
    return;
  }

  const info = interfaces[0];
  const assignedIps = info.addresses.filter(a => a.family === 'inet').map(a => a.address);

  console.log(
    `Interface ${iface}: ${assignedIps.length > 0 ? assignedIps.join(', ') : 'no IPv4 addresses'} (${info.state})`,
  );

  for (const expected of expectedIps) {
    if (assignedIps.includes(expected)) {
      console.log(`  OK: ${expected}`);
    } else {
      console.log(`  Adding ${expected}/24 to ${iface}`);
      await net.addAddress({ interfaceName: iface, address: expected, prefixLength: 24 });
    }
  }
}

/**
 * Periodically verify that the parent network's static route (10.0.0.0/8 → Steamboat)
 * is in place so that laptops on the guest/main network can reach team subnets.
 *
 * We test this by pinging the router (10.0.100.1) from a team VLAN interface.
 * The router can only reply if it has the static route, since the source IP
 * (on 10.0.100.0/24) falls within 10.0.0.0/8.
 *
 * Logging:
 * - Success after failure/startup: print once, then suppress
 * - Failure: print every 30s (not every 2s), reset success so recovery is logged
 */
export function startRoutingCheck(routerIp: string, iface: string): void {
  if (!process.env.YOLO) {
    console.log(`[dry-run] Routing check skipped (would ping ${routerIp} from ${iface})`);
    return;
  }

  let lastSuccess: boolean | null = null;
  let lastFailureLogTime = 0;

  const check = () => {
    execFile('ping', ['-I', iface, '-c', '1', '-W', '1', routerIp], err => {
      const now = Date.now();

      if (!err) {
        if (lastSuccess !== true) {
          console.log(`Routing check: OK — static route is working (${routerIp} replied via ${iface})`);
          lastSuccess = true;
        }
      } else {
        if (lastSuccess !== false || now - lastFailureLogTime >= 30_000) {
          console.warn(
            `Routing check: FAILED — ${routerIp} unreachable from ${iface}. Is the static route (10.0.0.0/8 → Steamboat) configured on the gateway?`,
          );
          lastFailureLogTime = now;
        }
        lastSuccess = false;
      }
    });
  };

  check();
  setInterval(check, 2000);
  console.log(`Routing check started: pinging ${routerIp} from ${iface} every 2s`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
