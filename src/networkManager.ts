import { createServer } from 'dhcp';
import { StationName, StationNameList } from './types.js';
import networkManager from 'set-ip-address';
import {} from 'netlink';

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

export async function startDHCP(station: StationName, team: number | undefined) {
  if (team === undefined) {
    console.log(`No team for ${station}, skipping DHCP server`);
    return;
  }

  const te_am_ = teamIp(team);

  const ipStart = `${te_am_}100`;
  const ipEnd = `${te_am_}199`;
  const server = `${te_am_}1`; // us
  const router = [`${te_am_}1`];

  if (!process.env.YOLO) {
    console.log(`DHCP server not started for ${station} (${team})`);
    console.log(`  IP range: ${ipStart} - ${ipEnd}`);
    console.log(`  Server: ${server}`);
    console.log(`  Router: ${router}`);
    return;
  }

  return new Promise(async (resolve, reject) => {
    const s = createServer({
      range: [ipStart, ipEnd],
      server,
      router,
    });
    s.on('error', reject);
    s.on('listening', () => {
      console.log(`DHCP server started on ${server}`);
    });

    resolve(s);
  });
}

// cSpell:words vlanid ifname

// TODO: load this map from the radio config
const vlanMap = {
  red1: 10,
  red2: 20,
  red3: 30,
  blue1: 40,
  blue2: 50,
  blue3: 60,
};

async function updateNetworkConfig(stations: Stations, iface: string) {
  const config = StationNameList.map((station, i): networkManager.NetworkConfig | null => {
    const team = stations[station];
    const base = {
      interface: iface,
      vlanid: vlanMap[station],
      // Override the interface name to use the station name
      // Breaks from the convention of using the vlan id as part of the name
      ifname: `${iface}.${station}`,
      optional: true,
      dhcp: false,
    };

    if (!team) return { ...base, manual: true };

    // We take
    const us = teamIp(team, 254);
    const upstream = us;

    return {
      ...base,
      ip_address: us,
      prefix: 24,
      gateway: upstream,
      // Ensure we don't list the same nameserver multiple times
      nameservers: [us, upstream].filter((e, n, a) => a.indexOf(e) === n),
    };
  });

  console.log('Network configuration:');
  console.log(config);

  await networkManager.configure(config.filter(c => c !== null));

  if (!process.env.YOLO) {
    console.log('Skipping network configuration. Use YOLO to apply.');
    return;
  }

  await networkManager.restartService();

  // TODO: Update iptables and handle routing for DS to internet router?

  console.log('Network configuration applied');
}

type Stations = Record<StationName, number | undefined>;

export async function configureNetwork(stations: Stations, interfaceName: string) {
  await updateNetworkConfig(stations, interfaceName);

  await Promise.all(
    Object.entries(stations).map(([station, team]) =>
      startDHCP(station as StationName, team).catch(err => {
        console.log(`Failed to start DHCP server for ${station}${team ? ` team ${team}` : ''}`);
        console.log(err);
      }),
    ),
  );
}
