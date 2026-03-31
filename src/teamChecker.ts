import dgram from 'node:dgram';
import type { StationName, CheckResult, TeamCheckResults, DiscoveredHost } from './types.js';

const FETCH_TIMEOUT = 1500;
/** roboRIO's NI SysAPI is slower than the radio — give it more time. */
const RIO_FETCH_TIMEOUT = 3000;
const MDNS_PORT = 5353;

// ── Help URLs ───────────────────────────────────────────────────────

const HELP_URLS = {
  radioSystemCore: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  radioFirmware: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/radio-programming.html',
  roboRIOHostname: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/roborio2-setup.html',
  roboRIOIP: 'https://docs.wpilib.org/en/stable/docs/networking/networking-introduction/ip-configurations.html',
  roboRIOImage: 'https://docs.wpilib.org/en/stable/docs/zero-to-robot/step-3/imaging-your-roborio.html',
} as const;

// ── NI SysAPI property tags ─────────────────────────────────────────

// Tags from the system PropertyBag (//localhost/nisyscfg/system)
const TAG_HOSTNAME = '101F000';
const TAG_IMAGE_VERSION = 'D15C000';
// Tags from the eth0 PropertyBag (//localhost/nisyscfg/eth0)
const TAG_IP_ADDRESS = 'D107000';
// Tag that identifies which bag we're looking at
const TAG_ITEM_NAME = '1000000';

// ── Expected values ─────────────────────────────────────────────────

/** Expected radio firmware version prefix. Updated each season. */
const EXPECTED_RADIO_FIRMWARE_PREFIX = '2.0.1';

/** Expected roboRIO image year. Updated each season. */
const EXPECTED_IMAGE_YEAR = '2026';

// ── Helpers ─────────────────────────────────────────────────────────

export function teamSubnet(team: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}`;
}

function expectedHostname(team: number): string {
  return `roboRIO-${team}-FRC`;
}

function expectedIP(team: number): string {
  return `${teamSubnet(team)}.2`;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = FETCH_TIMEOUT): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── NI SysAPI XML parsing ───────────────────────────────────────────

interface NISysAPIBag {
  itemName: string; // e.g. //localhost/nisyscfg/system
  properties: Map<string, string>; // tag → value
}

function parseNISysAPIResponse(xml: string): NISysAPIBag[] {
  const bags: NISysAPIBag[] = [];
  // Match each <PropertyBag>...</PropertyBag>
  const bagPattern = /<PropertyBag>([\s\S]*?)<\/PropertyBag>/g;
  let bagMatch: RegExpExecArray | null;
  while ((bagMatch = bagPattern.exec(xml)) !== null) {
    const properties = new Map<string, string>();
    const propPattern = /<Property\s+tag='([^']+)'\s+type='[^']*'[^>]*>([^<]*)<\/Property>/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propPattern.exec(bagMatch[1])) !== null) {
      properties.set(propMatch[1], propMatch[2]);
    }
    bags.push({
      itemName: properties.get(TAG_ITEM_NAME) ?? '',
      properties,
    });
  }
  return bags;
}

// ── Standalone check functions ──────────────────────────────────────

const FACTORY_DEFAULT_IP = '192.168.69.1';

/**
 * Send a raw mDNS multicast query on a specific interface and wait for a response.
 * Returns the first A record IP, or null on timeout.
 */
function mdnsQuery(hostname: string, sourceIp: string, timeoutMs: number): Promise<string | null> {
  return new Promise(resolve => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      sock.close();
      resolve(null);
    }, timeoutMs);

    sock.on('error', () => {
      clearTimeout(timer);
      sock.close();
      resolve(null);
    });

    sock.on('message', msg => {
      // Parse DNS response — look for an A record (type 1) in the answers section
      const ip = parseARecord(msg);
      if (ip) {
        clearTimeout(timer);
        sock.close();
        resolve(ip);
      }
    });

    // Bind to port 5353 (with SO_REUSEADDR already set above) so we receive
    // multicast responses. Binding to an ephemeral port fails when the mDNS
    // reflector is running because multicast responses go to port 5353.
    sock.bind(MDNS_PORT, sourceIp, () => {
      try {
        sock.addMembership('224.0.0.251', sourceIp);
      } catch {
        // May fail if already a member
      }
      // Must set the outgoing multicast interface explicitly — otherwise the
      // OS sends on the default-route interface (main network) and the query
      // never reaches the team VLAN where the roboRIO lives.
      sock.setMulticastInterface(sourceIp);
      sock.setMulticastTTL(255); // mDNS spec requires TTL=255
      const query = buildMdnsQuery(hostname);
      sock.send(query, 0, query.length, 5353, '224.0.0.251');
    });
  });
}

/** Build a minimal DNS query packet for an A record. */
function buildMdnsQuery(hostname: string): Buffer {
  // DNS header: ID=0, flags=0, 1 question, 0 answers
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  // Encode hostname labels (e.g. "roboRIO-1234-FRC.local" → \x12roboRIO-1234-FRC\x05local\x00)
  const labels = hostname.split('.').map(label => {
    const buf = Buffer.alloc(1 + label.length);
    buf[0] = label.length;
    buf.write(label, 1);
    return buf;
  });
  const name = Buffer.concat([...labels, Buffer.from([0])]);
  // Type A (1), Class IN (1) with unicast-response bit
  const qtype = Buffer.from([0, 1, 0x80, 1]);
  return Buffer.concat([header, name, qtype]);
}

/** Parse the first A record from a DNS response. Returns the IP string or null. */
function parseARecord(msg: Buffer): string | null {
  if (msg.length < 12) return null;
  const qdcount = msg.readUInt16BE(4);
  const ancount = msg.readUInt16BE(6);
  if (ancount === 0) return null;

  // Skip the question section
  let offset = 12;
  for (let i = 0; i < qdcount && offset < msg.length; i++) {
    while (offset < msg.length && msg[offset] !== 0) {
      if ((msg[offset] & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      offset += msg[offset] + 1;
    }
    if (offset < msg.length && msg[offset] === 0) offset++; // null terminator
    offset += 4; // qtype + qclass
  }

  // Parse answer records
  for (let i = 0; i < ancount && offset < msg.length; i++) {
    // Skip name (may be compressed)
    while (offset < msg.length && msg[offset] !== 0) {
      if ((msg[offset] & 0xc0) === 0xc0) {
        offset += 2;
        break;
      }
      offset += msg[offset] + 1;
    }
    if (offset < msg.length && msg[offset] === 0) offset++;

    if (offset + 10 > msg.length) break;
    const rtype = msg.readUInt16BE(offset);
    const rdlength = msg.readUInt16BE(offset + 8);
    offset += 10;

    if (rtype === 1 && rdlength === 4 && offset + 4 <= msg.length) {
      return `${msg[offset]}.${msg[offset + 1]}.${msg[offset + 2]}.${msg[offset + 3]}`;
    }
    offset += rdlength;
  }
  return null;
}

/** Check mDNS resolution for a hostname via multicast on a specific interface. */
export async function checkMdns(
  name: string,
  hostname: string,
  expectedIp: string | undefined,
  sourceIp?: string,
): Promise<CheckResult[]> {
  if (!sourceIp) return [];
  try {
    const resolved = await mdnsQuery(hostname, sourceIp, FETCH_TIMEOUT);
    if (!resolved) {
      return [{ name, status: 'error', message: `${hostname} — no response` }];
    }
    if (!expectedIp || resolved === expectedIp) {
      return [{ name, status: 'pass', actual: `${hostname} → ${resolved}` }];
    }
    return [
      {
        name,
        status: 'warn',
        expected: expectedIp,
        actual: `${hostname} → ${resolved}`,
        message: 'Resolved to unexpected IP',
      },
    ];
  } catch {
    return [{ name, status: 'error', message: `${hostname} — query failed` }];
  }
}

/**
 * Check if the radio is reachable at the factory default IP (192.168.69.1).
 * Radios always respond here as a recovery fallback — this is normal.
 * Only warn if the radio responds at the factory IP but NOT at the team IP,
 * which means the radio hasn't been configured with a team number yet.
 */
export async function checkFactoryDefault(team: number): Promise<CheckResult[]> {
  const teamIp = `${teamSubnet(team)}.1`;

  const [factoryResult, teamResult] = await Promise.all([
    fetchWithTimeout(`http://${FACTORY_DEFAULT_IP}/status`).catch(() => null),
    fetchWithTimeout(`http://${teamIp}/status`).catch(() => null),
  ]);

  if (!factoryResult?.ok) return []; // Factory IP not reachable — no radio connected
  if (teamResult?.ok) return []; // Both respond — normal operation

  let factoryData: { teamNumber?: number; version?: string } | undefined;
  try {
    factoryData = (await factoryResult.json()) as { teamNumber?: number; version?: string };
  } catch {
    // Ignore parse errors
  }

  // Radio responds at factory IP but not team IP — needs configuration
  return [
    {
      name: 'Radio Not Configured',
      status: 'fail',
      actual: `Reachable at ${FACTORY_DEFAULT_IP} only${factoryData?.version ? ` (${factoryData.version})` : ''}`,
      message:
        'Radio responds at factory default IP but not at the team IP — it needs to be configured with a team number',
    },
  ];
}

function evaluateSystemCore(data: { systemcoreEnabled?: boolean; version?: string }): CheckResult {
  if (data.systemcoreEnabled === undefined) {
    // Older firmware doesn't report systemcoreEnabled — skip the check
    return {
      name: 'Radio SystemCore',
      status: 'pass',
      message: `Not reported by firmware${data.version ? ` (${data.version})` : ''} — update radio firmware to enable this check`,
    };
  }
  if (data.systemcoreEnabled === false) {
    return { name: 'Radio SystemCore', status: 'pass', expected: 'disabled', actual: 'disabled' };
  }
  return {
    name: 'Radio SystemCore',
    status: 'fail',
    expected: 'disabled',
    actual: 'enabled',
    message: 'SystemCore mode must be disabled for competition use',
    helpUrl: HELP_URLS.radioSystemCore,
  };
}

function evaluateRadioFirmware(data: { version?: string }): CheckResult {
  if (!data.version) {
    return {
      name: 'Radio Firmware',
      status: 'error',
      message: 'Version field missing from radio status',
      helpUrl: HELP_URLS.radioFirmware,
    };
  }
  // Version format: "VH-109_2.0.1-02062026"
  // Extract the version part after the underscore
  const versionPart = data.version.includes('_') ? data.version.split('_')[1] : data.version;
  if (versionPart.startsWith(EXPECTED_RADIO_FIRMWARE_PREFIX)) {
    return { name: 'Radio Firmware', status: 'pass', actual: data.version };
  }
  return {
    name: 'Radio Firmware',
    status: 'fail',
    expected: `Version ${EXPECTED_RADIO_FIRMWARE_PREFIX}+`,
    actual: data.version,
    message: 'Radio firmware is outdated',
    helpUrl: HELP_URLS.radioFirmware,
  };
}

/** Fetch radio /status and run all radio checks. Firmware first; SystemCore skipped if outdated. Includes detected team number. */
export async function checkRadio(team: number, sourceIp?: string): Promise<CheckResult[]> {
  const radioIp = `${teamSubnet(team)}.1`;
  const results: CheckResult[] = [];
  try {
    const res = await fetchWithTimeout(`http://${radioIp}/status`);
    if (!res.ok) {
      const msg = `Radio returned HTTP ${res.status}`;
      return [
        { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
        { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
      ];
    }
    const data = (await res.json()) as { systemcoreEnabled?: boolean; version?: string; teamNumber?: number };
    const fwCheck = evaluateRadioFirmware(data);
    results.push(fwCheck);
    if (fwCheck.status === 'fail') {
      results.push({ name: 'Radio SystemCore', status: 'warn', message: 'Skipped — update firmware first' });
    } else {
      results.push(evaluateSystemCore(data));
    }
    // Report detected team number for consistency checking
    if (data.teamNumber !== undefined) {
      results.push({
        name: 'Radio Team',
        status: data.teamNumber === team ? 'pass' : 'fail',
        actual: `${data.teamNumber}`,
        ...(data.teamNumber !== team && {
          expected: `${team}`,
          message: 'Radio team number does not match DHCP subnet',
        }),
      });
    }
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError' ? 'Radio unreachable (timeout)' : String(err);
    return [
      { name: 'Radio Firmware', status: 'error', message: msg, helpUrl: HELP_URLS.radioFirmware },
      { name: 'Radio SystemCore', status: 'error', message: msg, helpUrl: HELP_URLS.radioSystemCore },
    ];
  }

  // radio.local mDNS check
  const mdns = await checkMdns('Radio mDNS', 'radio.local', radioIp, sourceIp);
  results.push(...mdns);

  return results;
}

/**
 * Find the roboRIO on the team's subnet by probing the NI SysAPI endpoint.
 * Try the standard .2 address first, then any other IPs provided.
 */
async function findRoboRIO(team: number, extraIps: string[]): Promise<{ ip: string; bags: NISysAPIBag[] } | null> {
  const standardIp = expectedIP(team);
  const ipsToTry = [standardIp, ...extraIps.filter(ip => ip !== standardIp)];

  for (const ip of ipsToTry) {
    try {
      const res = await fetchWithTimeout(
        `http://${ip}/nisysapi/server`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/xml',
          },
          body: 'Function=SearchForItemsAndProperties&Version=00010001&response_encoding=UTF-8&Plugins=nisyscfg&FilterMode=00000002',
        },
        RIO_FETCH_TIMEOUT,
      );
      if (!res.ok) continue;
      const xml = await res.text();
      if (!xml.includes('NISysAPI_Results')) continue;
      // Check for success (hr='0')
      const hrMatch = xml.match(/hr='([^']+)'/);
      if (hrMatch && hrMatch[1] !== '0') continue;
      const bags = parseNISysAPIResponse(xml);
      if (bags.length > 0) return { ip, bags };
    } catch {
      // Not a RIO, try next
    }
  }
  return null;
}

/** Run roboRIO checks. `extraIps` are additional addresses to probe beyond the standard .2. */
export async function checkRoboRIO(team: number, extraIps: string[] = [], sourceIp?: string): Promise<CheckResult[]> {
  const result = await findRoboRIO(team, extraIps);
  if (!result) {
    return [
      {
        name: 'roboRIO',
        status: 'error',
        message: 'roboRIO not found on team subnet',
        helpUrl: HELP_URLS.roboRIOIP,
      },
    ];
  }

  const { ip, bags } = result;
  const systemBag = bags.find(b => b.itemName.endsWith('/system'));
  const eth0Bag = bags.find(b => b.itemName.endsWith('/eth0'));

  const checks: CheckResult[] = [];

  // Hostname check
  const hostname = systemBag?.properties.get(TAG_HOSTNAME);
  const expectedName = expectedHostname(team);
  if (hostname) {
    checks.push({
      name: 'roboRIO Hostname',
      status: hostname === expectedName ? 'pass' : 'fail',
      expected: expectedName,
      actual: hostname,
      ...(hostname !== expectedName && {
        message: 'Hostname does not match expected FRC format',
        helpUrl: HELP_URLS.roboRIOHostname,
      }),
    });
  } else {
    checks.push({
      name: 'roboRIO Hostname',
      status: 'error',
      message: 'Could not read hostname from roboRIO',
      helpUrl: HELP_URLS.roboRIOHostname,
    });
  }

  // IP check
  const rioIp = eth0Bag?.properties.get(TAG_IP_ADDRESS) ?? ip;
  const expectedIpAddr = expectedIP(team);
  checks.push({
    name: 'roboRIO IP',
    status: rioIp === expectedIpAddr ? 'pass' : 'fail',
    expected: expectedIpAddr,
    actual: rioIp,
    ...(rioIp !== expectedIpAddr && {
      message: `roboRIO is at non-standard IP (found via ${ip})`,
      helpUrl: HELP_URLS.roboRIOIP,
    }),
  });

  // Image version check
  const imageVersion = systemBag?.properties.get(TAG_IMAGE_VERSION);
  if (imageVersion) {
    const hasCurrentYear = imageVersion.includes(EXPECTED_IMAGE_YEAR);
    checks.push({
      name: 'roboRIO Image',
      status: hasCurrentYear ? 'pass' : 'fail',
      expected: `${EXPECTED_IMAGE_YEAR} image`,
      actual: imageVersion,
      ...(!hasCurrentYear && {
        message: 'roboRIO image is outdated',
        helpUrl: HELP_URLS.roboRIOImage,
      }),
    });
  } else {
    checks.push({
      name: 'roboRIO Image',
      status: 'error',
      message: 'Could not read image version from roboRIO',
      helpUrl: HELP_URLS.roboRIOImage,
    });
  }

  // Extract team number from hostname for consistency display
  if (hostname) {
    const rioTeam = teamFromHostname(hostname);
    if (rioTeam !== null) {
      checks.push({
        name: 'roboRIO Team',
        status: rioTeam === team ? 'pass' : 'fail',
        actual: `${rioTeam}`,
        ...(rioTeam !== team && { expected: `${team}`, message: 'roboRIO team does not match DHCP subnet' }),
      });
    }
  }

  // roboRIO mDNS check
  const mdns = await checkMdns('roboRIO mDNS', `roboRIO-${team}-FRC.local`, expectedIP(team), sourceIp);
  checks.push(...mdns);

  return checks;
}

// ── Team number consistency ─────────────────────────────────────────

/** Extract a team number from an SSID like "1234" or "1234-Comp". */
function teamFromSsid(ssid: string): number | null {
  const match = ssid.match(/^(\d{1,5})/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return num > 0 && num <= 25599 ? num : null;
}

/** Extract a team number from a roboRIO hostname like "roboRIO-1234-FRC". */
function teamFromHostname(hostname: string): number | null {
  const match = hostname.match(/^roboRIO-(\d+)-FRC$/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return num > 0 && num <= 25599 ? num : null;
}

/**
 * Verify team number consistency across DHCP range, radio SSID, and roboRIO hostname.
 * The `dhcpTeam` is derived from the DHCP-assigned IP (10.TE.AM.x).
 */
export async function checkTeamConsistency(dhcpTeam: number): Promise<CheckResult[]> {
  const sources: { source: string; team: number }[] = [{ source: 'DHCP', team: dhcpTeam }];
  const problems: string[] = [];

  // Try to get team from radio
  const radioIp = `${teamSubnet(dhcpTeam)}.1`;
  try {
    const res = await fetchWithTimeout(`http://${radioIp}/status`);
    if (res.ok) {
      const data = (await res.json()) as Record<string, unknown>;
      // Robot radios report teamNumber directly; fall back to parsing SSID
      let radioTeam: number | null = null;
      let radioLabel = 'Radio';
      if (typeof data.teamNumber === 'number') {
        radioTeam = data.teamNumber;
        radioLabel = `Radio (team ${radioTeam})`;
      } else {
        // Try SSID from networkStatus6 (6 GHz band, uses team-only SSID) or top-level
        const ssid =
          (data.networkStatus6 as { ssid?: string } | undefined)?.ssid ??
          (typeof data.ssid === 'string' ? data.ssid : undefined);
        if (ssid) {
          radioTeam = teamFromSsid(ssid);
          radioLabel = `Radio SSID (${ssid})`;
        }
      }
      if (radioTeam) {
        sources.push({ source: radioLabel, team: radioTeam });
        if (radioTeam !== dhcpTeam) problems.push(`${radioLabel} → team ${radioTeam}`);
      }
    }
  } catch {
    // Radio unreachable — skip, other checks will report this
  }

  // Try to get team from roboRIO hostname
  const rioIp = expectedIP(dhcpTeam);
  try {
    const res = await fetchWithTimeout(
      `http://${rioIp}/nisysapi/server`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/xml' },
        body: 'Function=SearchForItemsAndProperties&Version=00010001&response_encoding=UTF-8&Plugins=nisyscfg&FilterMode=00000002',
      },
      RIO_FETCH_TIMEOUT,
    );
    if (res.ok) {
      const xml = await res.text();
      const bags = parseNISysAPIResponse(xml);
      const systemBag = bags.find(b => b.itemName.endsWith('/system'));
      const hostname = systemBag?.properties.get(TAG_HOSTNAME);
      if (hostname) {
        const rioTeam = teamFromHostname(hostname);
        if (rioTeam) {
          sources.push({ source: `roboRIO (${hostname})`, team: rioTeam });
          if (rioTeam !== dhcpTeam) problems.push(`roboRIO hostname "${hostname}" → team ${rioTeam}`);
        }
      }
    }
  } catch {
    // RIO unreachable — skip
  }

  if (problems.length > 0) {
    return [
      {
        name: 'Team Consistency',
        status: 'fail',
        expected: `All devices: team ${dhcpTeam}`,
        actual: sources.map(s => `${s.source}: ${s.team}`).join(', '),
        message: `Team number mismatch: ${problems.join('; ')}`,
      },
    ];
  }

  // All sources agree (or only DHCP was available)
  const detail = sources.length > 1 ? sources.map(s => s.source).join(', ') : 'DHCP only';
  return [
    {
      name: 'Team Consistency',
      status: 'pass',
      actual: `Team ${dhcpTeam} (${detail})`,
    },
  ];
}

// ── TeamChecker (station-based wrapper) ─────────────────────────────

type HostLookup = (station: StationName) => DiscoveredHost[];

export class TeamChecker {
  constructor(
    private readonly getAliveHosts: HostLookup,
    private readonly vlanHostOctet?: number,
  ) {}

  async runChecks(station: StationName, team: number): Promise<TeamCheckResults> {
    const hosts = this.getAliveHosts(station);
    const extraIps = hosts.filter(h => h.alive && !h.ip.endsWith('.1') && !h.ip.endsWith('.254')).map(h => h.ip);
    const sourceIp = this.vlanHostOctet ? `${teamSubnet(team)}.${this.vlanHostOctet}` : undefined;
    const [radioChecks, rioChecks, mdnsChecks] = await Promise.all([
      checkRadio(team),
      checkRoboRIO(team, extraIps),
      checkMdns('roboRIO mDNS', `roboRIO-${team}-FRC.local`, expectedIP(team), sourceIp),
    ]);
    return {
      type: 'teamCheckResults',
      station,
      team,
      timestamp: Date.now(),
      checks: [...radioChecks, ...rioChecks, ...mdnsChecks],
    };
  }
}
