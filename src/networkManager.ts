import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { StationName, StationNameList } from './types.js';
import { appInfo, appWarn } from './appLogger.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';

const net: NetworkBackend = process.env.DRY_RUN ? createDryRunBackend() : createBackend();
const commentPrefix = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';
const vlanHostOctet = Number(process.env.VLAN_HOST_OCTET) || 254;
if (vlanHostOctet < 220 || vlanHostOctet > 254) {
  throw new Error(`VLAN_HOST_OCTET must be between 220 and 254 (got ${vlanHostOctet})`);
}

function teamIp(team: number, end: number | string = '') {
  if (team < 1 || team > 25599) {
    throw new Error(`Invalid team number: ${team}`);
  }
  if (typeof end === 'number' && (end < 0 || end > 255)) {
    throw new Error(`Invalid end number: ${end}`);
  }
  if (typeof end === 'string') {
    if (end.includes('.')) throw new Error(`Invalid end string: ${end}`);
  } else if (typeof end !== 'number') {
    throw new Error(`Invalid end type: ${typeof end}`);
  }

  const low = team % 100;
  const high = Math.floor(team / 100);

  return `10.${high}.${low}.${end}`;
}

// ── DHCP Server (dnsmasq, OFFSEASON mode) ──────────────────────────

/** Track running dnsmasq processes per station */
const dhcpServerProcesses = new Map<StationName, ChildProcess>();

/** Stop a running DHCP server for a station */
function stopDHCPServer(station: StationName) {
  const proc = dhcpServerProcesses.get(station);
  if (proc) {
    proc.kill();
    dhcpServerProcesses.delete(station);
    console.log(`DHCP server stopped for ${station}`);
  }
}

export async function startDHCPServer(station: StationName, team: number | undefined, interfaceName: string) {
  // Always stop the previous instance for this station (in-process tracking)
  stopDHCPServer(station);

  const ifName = `${interfaceName}.${station}`;

  // Kill any orphaned dnsmasq processes from a previous session that we no longer
  // have a handle to (pkill exits 1 when nothing matched — that is expected and ignored).
  try {
    await execFileAsync('pkill', ['-f', `--interface=${ifName}`]);
  } catch {
    // No matching process found, or pkill not available — both are fine.
  }

  if (team === undefined) {
    console.log(`No team for ${station}, skipping DHCP server`);
    return;
  }

  const gateway = teamIp(team, vlanHostOctet);
  const rangeStart = teamIp(team, 100);
  const rangeEnd = teamIp(team, 199);

  if (process.env.DRY_RUN) {
    console.log(`[dry-run] DHCP server not started for ${station} (${team})`);
    console.log(`  Interface: ${ifName}`);
    console.log(`  Range: ${rangeStart} - ${rangeEnd}`);
    console.log(`  Gateway: ${gateway}`);
    return;
  }

  const proc = spawn(
    'dnsmasq',
    [
      '--no-daemon',
      '--port=0', // disable DNS
      `--interface=${ifName}`,
      '--bind-interfaces',
      `--dhcp-range=${rangeStart},${rangeEnd},255.255.255.0,1h`,
      `--dhcp-option=3,${gateway}`, // router
      '--dhcp-option=6', // no DNS servers
      `--dhcp-leasefile=/tmp/dnsmasq-${station}.leases`,
      '--log-dhcp',
      '--log-facility=-', // log to stderr instead of syslog
      '--no-ping',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  proc.stdout!.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.log(`[dhcp:${station}] ${line}`);
    }
  });

  proc.stderr!.on('data', (data: Buffer) => {
    for (const line of data.toString().trim().split('\n')) {
      console.log(`[dhcp:${station}] ${line}`);
    }
  });

  proc.on('exit', (code, signal) => {
    dhcpServerProcesses.delete(station);
    if (signal) {
      console.log(`DHCP server for ${station} killed by ${signal}`);
    } else if (code !== 0) {
      console.error(`DHCP server for ${station} exited with code ${code}`);
    }
  });

  dhcpServerProcesses.set(station, proc);
  console.log(`DHCP server started for ${station} (team ${team}) on ${ifName}`);
}

// ── Cleanup ────────────────────────────────────────────────────────

/** Stop all running DHCP servers (for cleanup on shutdown) */
export function stopAllDHCP() {
  for (const station of dhcpServerProcesses.keys()) {
    stopDHCPServer(station);
  }
}

// ── Network configuration ──────────────────────────────────────────

// TODO: load this map from the radio config
const vlanMap = {
  red1: 10,
  red2: 20,
  red3: 30,
  blue1: 40,
  blue2: 50,
  blue3: 60,
};

/** Track what's currently configured per station to avoid unnecessary teardown */
let previousStations: Stations = {} as Stations;

async function updateNetworkConfig(stations: Stations, physical_interface: string, practiceMode: boolean) {
  for (const station of StationNameList) {
    const team = stations[station];
    const prevTeam = previousStations[station];
    const vlanId = vlanMap[station];
    const ifName = `${physical_interface}.${station}`;

    // Ensure the VLAN interface exists
    await net.createVlan({ parent: physical_interface, vlanId, name: ifName });

    // Skip stations that haven't changed
    if (team === prevTeam) continue;

    // Tear down the old config for this station
    if (prevTeam) {
      // Remove the specific old team IP rather than flushing all addresses — avoids
      // disturbing IPv6 link-local and other addresses managed outside this code.
      await net.removeAddress({ interfaceName: ifName, address: teamIp(prevTeam, vlanHostOctet), prefixLength: 24 });
      await net.iptables({
        chain: 'FORWARD',
        inInterface: ifName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-${station}`,
        action: '-D',
      });
      await net.iptables({
        chain: 'FORWARD',
        outInterface: ifName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-in-${station}`,
        action: '-D',
      });
      await net.iptables({
        table: 'nat',
        chain: 'POSTROUTING',
        outInterface: ifName,
        jump: 'MASQUERADE',
        comment: `${commentPrefix}nat-vlan-${station}`,
        action: '-D',
      });
    }

    if (team) {
      await net.setInterfaceUp(ifName);

      const us = teamIp(team, vlanHostOctet);

      // Remove any stale IPv4 addresses that don't belong to this team.
      // This covers the process-restart case where previousStations is empty
      // and the teardown above was skipped, leaving addresses from a prior session.
      const interfaces = await net.listInterfaces(ifName);
      for (const addr of interfaces[0]?.addresses ?? []) {
        if (addr.family === 'inet' && addr.address !== us) {
          appWarn(`Removing stale address ${addr.address}/${addr.prefixLength} from ${ifName}`);
          await net.removeAddress({ interfaceName: ifName, address: addr.address, prefixLength: addr.prefixLength });
        }
      }

      if (!practiceMode) {
        const conflict = await net.arping({ interfaceName: ifName, address: us });
        if (conflict) {
          appWarn(`Address conflict: ${us} is already in use on ${ifName}, skipping`);
          continue;
        }
      }

      await net.addAddress({ interfaceName: ifName, address: us, prefixLength: 24 });

      // Add forwarding rules
      await net.iptables({
        chain: 'FORWARD',
        inInterface: ifName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-${station}`,
        action: '-A',
      });
      await net.iptables({
        chain: 'FORWARD',
        outInterface: ifName,
        jump: 'ACCEPT',
        comment: `${commentPrefix}fwd-in-${station}`,
        action: '-A',
      });
      // MASQUERADE traffic entering the VLAN so return traffic comes back to the same host
      await net.iptables({
        table: 'nat',
        chain: 'POSTROUTING',
        outInterface: ifName,
        jump: 'MASQUERADE',
        comment: `${commentPrefix}nat-vlan-${station}`,
        action: '-A',
      });
    } else {
      await net.setInterfaceDown(ifName);
    }
  }

  previousStations = { ...stations };
  appInfo('Network configuration applied');
}

/** Enable or disable internet access (NAT + forwarding) for a team subnet. */
export async function setInternetAccess(
  station: StationName,
  team: number,
  physicalInterface: string,
  enabled: boolean,
): Promise<void> {
  // FORWARD rules are handled by updateNetworkConfig (interface-based, always on).
  // Internet toggle only controls MASQUERADE — without it, return traffic from the internet
  // can't find its way back (the robot's 10.TE.AM.x source IP isn't routable externally).
  const subnet = teamIp(team, '0/24');

  const action = enabled ? '-A' : '-D';

  await net.iptables({
    action,
    table: 'nat',
    chain: 'POSTROUTING',
    source: subnet,
    notDestination: '10.0.0.0/8',
    outInterface: physicalInterface,
    jump: 'MASQUERADE',
    comment: `${commentPrefix}nat-${station}`,
  });

  console.log(`Internet access ${enabled ? 'enabled' : 'disabled'} for ${station} (team ${team})`);
}

type Stations = Record<StationName, number | undefined>;

export async function configureNetwork(stations: Stations, interfaceName: string, practiceMode = false) {
  console.log('configureNetwork');
  await updateNetworkConfig(stations, interfaceName, practiceMode);

  if (practiceMode) return;

  for (const station of StationNameList) {
    await startDHCPServer(station, stations[station], interfaceName);
  }
}
