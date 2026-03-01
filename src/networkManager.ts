import { spawn, type ChildProcess } from 'node:child_process';
import { StationName, StationNameList } from './types.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';

const net: NetworkBackend = process.env.YOLO ? createBackend() : createDryRunBackend();
const commentPrefix = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';

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

/** Track running dnsmasq processes per station */
const dhcpProcesses = new Map<StationName, ChildProcess>();

/** Stop a running DHCP server for a station */
function stopDHCP(station: StationName) {
  const proc = dhcpProcesses.get(station);
  if (proc) {
    proc.kill();
    dhcpProcesses.delete(station);
    console.log(`DHCP server stopped for ${station}`);
  }
}

/** Stop all running DHCP servers (for cleanup on shutdown) */
export function stopAllDHCP() {
  for (const station of dhcpProcesses.keys()) {
    stopDHCP(station);
  }
}

export function startDHCP(station: StationName, team: number | undefined, interfaceName: string) {
  // Always stop the previous instance for this station
  stopDHCP(station);

  if (team === undefined) {
    console.log(`No team for ${station}, skipping DHCP server`);
    return;
  }

  const gateway = teamIp(team, 3);
  const rangeStart = teamIp(team, 100);
  const rangeEnd = teamIp(team, 199);
  const ifName = `${interfaceName}.${station}`;

  if (!process.env.YOLO) {
    console.log(`[dry-run] DHCP server not started for ${station} (${team})`);
    console.log(`  Interface: ${ifName}`);
    console.log(`  Range: ${rangeStart} - ${rangeEnd}`);
    console.log(`  Gateway: ${gateway}`);
    return;
  }

  const proc = spawn('dnsmasq', [
    '--no-daemon',
    '--port=0', // disable DNS
    `--interface=${ifName}`,
    '--bind-interfaces',
    `--dhcp-range=${rangeStart},${rangeEnd},255.255.255.0,1h`,
    `--dhcp-option=3,${gateway}`, // router
    '--dhcp-option=6', // no DNS servers
    `--dhcp-leasefile=/tmp/dnsmasq-${station}.leases`,
    '--log-dhcp',
    '--no-ping',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

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
    dhcpProcesses.delete(station);
    if (signal) {
      console.log(`DHCP server for ${station} killed by ${signal}`);
    } else if (code !== 0) {
      console.error(`DHCP server for ${station} exited with code ${code}`);
    }
  });

  dhcpProcesses.set(station, proc);
  console.log(`DHCP server started for ${station} (team ${team}) on ${ifName}`);
}

// TODO: load this map from the radio config
const vlanMap = {
  red1: 10,
  red2: 20,
  red3: 30,
  blue1: 40,
  blue2: 50,
  blue3: 60,
};

async function updateNetworkConfig(stations: Stations, physical_interface: string) {
  for (const station of StationNameList) {
    const team = stations[station];
    const vlanId = vlanMap[station];
    const ifName = `${physical_interface}.${station}`;

    await net.createVlan({ parent: physical_interface, vlanId, name: ifName });
    await net.flushAddresses(ifName);

    // Forwarding rules use the VLAN interface name, so they're team-number-independent
    const fwdOut = {
      chain: 'FORWARD',
      inInterface: ifName,
      jump: 'ACCEPT',
      comment: `${commentPrefix}fwd-${station}`,
    } as const;
    const fwdIn = {
      chain: 'FORWARD',
      outInterface: ifName,
      jump: 'ACCEPT',
      comment: `${commentPrefix}fwd-in-${station}`,
    } as const;

    if (team) {
      const us = teamIp(team, 3);
      await net.addAddress({ interfaceName: ifName, address: us, prefixLength: 24 });
      await net.setInterfaceUp(ifName);

      // Allow traffic to/from this VLAN through the FORWARD chain (default policy is DROP due to Docker)
      await net.iptables({ ...fwdOut, action: '-A' });
      await net.iptables({ ...fwdIn, action: '-A' });
    } else {
      await net.setInterfaceDown(ifName);

      // Remove forwarding rules when station is cleared
      await net.iptables({ ...fwdOut, action: '-D' });
      await net.iptables({ ...fwdIn, action: '-D' });
    }
  }

  console.log('Network configuration applied');
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

export async function configureNetwork(stations: Stations, interfaceName: string) {
  console.log('configureNetwork');
  await updateNetworkConfig(stations, interfaceName);

  for (const station of StationNameList) {
    startDHCP(station, stations[station], interfaceName);
  }
}
