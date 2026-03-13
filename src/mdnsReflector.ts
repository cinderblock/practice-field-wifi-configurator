/**
 * mDNS reflector — bridges mDNS queries/responses between the main network
 * (where team laptops live) and per-team VLAN interfaces (where robots live).
 *
 * Traffic is one-directional per type:
 *   Queries:   main network → team VLAN  (laptops looking up robots)
 *   Responses: team VLAN → main network  (robots answering)
 *
 * Only reflects packets matching FRC naming patterns (e.g. roboRIO-TEAM-FRC.local)
 * and routes them to/from the correct VLAN based on team number.
 *
 * Loop prevention relies on setMulticastLoopback(false) — the socket never
 * receives its own forwarded packets — plus the directional filter above.
 */
import dgram from 'node:dgram';
import { MdnsActivity, MdnsResolvedName, StationMdnsActivity, StationName, StationNameList } from './types.js';

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;

// ── DNS packet parsing (minimal) ────────────────────────────────────

/**
 * Read a DNS name from the packet at the given offset, handling label
 * compression pointers (RFC 1035 §4.1.4).
 */
function readDnsName(buf: Buffer, offset: number): { name: string; bytesRead: number } {
  const labels: string[] = [];
  let pos = offset;
  let bytesRead = 0;
  let jumped = false;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) bytesRead += 1;
      break;
    }

    // Compression pointer: top 2 bits set → remaining 14 bits are an offset
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) break;
      const pointer = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) bytesRead += 2;
      pos = pointer;
      jumped = true;
      continue;
    }

    // Regular label: 1-byte length prefix followed by that many ASCII bytes
    if (pos + 1 + len > buf.length) break;
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += 1 + len;
    if (!jumped) bytesRead += 1 + len;
  }

  return { name: labels.join('.'), bytesRead };
}

/** Extract all question names from an mDNS packet (header is 12 bytes). */
function parseQuestionNames(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const names: string[] = [];
  let offset = 12;

  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { name, bytesRead } = readDnsName(buf, offset);
    if (name) names.push(name);
    offset += bytesRead + 4; // skip QTYPE (2) + QCLASS (2)
  }

  return names;
}

/** Extract answer records from an mDNS packet, including A record IPs. */
function parseAnswerRecords(buf: Buffer): { name: string; resolvedIp?: string }[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const records: { name: string; resolvedIp?: string }[] = [];

  // Skip past question section
  let offset = 12;
  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { bytesRead } = readDnsName(buf, offset);
    offset += bytesRead + 4;
  }

  // Read answer records
  for (let i = 0; i < anCount && offset < buf.length; i++) {
    const { name, bytesRead } = readDnsName(buf, offset);
    offset += bytesRead;
    if (offset + 10 > buf.length) break;
    const type = buf.readUInt16BE(offset);
    const rdLength = buf.readUInt16BE(offset + 8);
    let resolvedIp: string | undefined;
    // A record: TYPE=1, RDLENGTH=4 → 4 bytes of IPv4
    if (type === 1 && rdLength === 4 && offset + 14 <= buf.length) {
      resolvedIp = `${buf[offset + 10]}.${buf[offset + 11]}.${buf[offset + 12]}.${buf[offset + 13]}`;
    }
    offset += 10 + rdLength;
    if (name) records.push({ name, resolvedIp });
  }

  return records;
}

// ── FRC name matching ───────────────────────────────────────────────

/**
 * FRC device naming patterns. The team number is captured from group 1
 * and used to route the packet to the correct VLAN.
 *
 * Matched against the hostname portion (after stripping .local):
 *   roboRIO-TEAM-FRC         — standard roboRIO
 *   roboRIO-TEAM-FRC-2       — secondary roboRIO
 */
const FRC_PATTERNS: RegExp[] = [/^roboRIO-(\d{1,5})-FRC\b/i];

function extractTeamFromName(dnsName: string): number | null {
  // mDNS names end with .local (sometimes with trailing dot) — strip for matching
  const hostname = dnsName.replace(/\.local\.?$/i, '');
  for (const pattern of FRC_PATTERNS) {
    const match = hostname.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

// ── mDNS name condensing ────────────────────────────────────────────

/**
 * Split an mDNS name into hostname + optional service type.
 *
 * Examples:
 *   "roborio-846-frc._ni-rt._tcp.local" → { hostname: "roborio-846-frc.local", service: "_ni-rt._tcp" }
 *   "_services._dns-sd._udp.local"      → { hostname: "_services._dns-sd._udp.local" }  (no host prefix)
 *   "roborio-846-frc.local"             → { hostname: "roborio-846-frc.local" }
 *
 * A service suffix is detected when a label starting with '_' appears
 * after at least one non-underscore label.
 */
function splitMdnsName(name: string): { hostname: string; service?: string } {
  // Strip .local suffix for processing, re-add at end
  const stripped = name.replace(/\.local\.?$/i, '');
  const labels = stripped.split('.');

  // Find the first label starting with '_' — everything from there is the service
  const serviceIdx = labels.findIndex(l => l.startsWith('_'));
  if (serviceIdx <= 0) {
    // No service suffix, or the name starts with _ (pure service query)
    return { hostname: name.toLowerCase() };
  }

  const host = labels.slice(0, serviceIdx).join('.') + '.local';
  const service = labels.slice(serviceIdx).join('.');
  return { hostname: host.toLowerCase(), service };
}

// ── IP exclusion list ───────────────────────────────────────────────

type IpMatcher = (ip: number) => boolean;

/**
 * Parse a comma-separated list of IP exclusions into matchers.
 * Supported formats:
 *   "10.255.0.1"        — single IP
 *   "10.255.0.0/24"     — CIDR range
 *   "10.255.0.1-50"     — last-octet range (10.255.0.1 through 10.255.0.50)
 */
function parseExcludeList(raw: string): IpMatcher[] {
  const matchers: IpMatcher[] = [];
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    // CIDR: "10.255.0.0/24"
    const cidrMatch = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
    if (cidrMatch) {
      const prefix = parseInt(cidrMatch[2], 10);
      if (prefix < 0 || prefix > 32) {
        throw new Error(`mDNS: invalid CIDR prefix in "${entry}"`);
      }
      const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
      const network = (ipToNumber(cidrMatch[1]) & mask) >>> 0;
      matchers.push((ip: number) => (ip & mask) >>> 0 === network);
      continue;
    }

    // Last-octet range: "10.255.0.1-50"
    const rangeMatch = entry.match(/^(\d+\.\d+\.\d+)\.(\d+)-(\d+)$/);
    if (rangeMatch) {
      const base = ipToNumber(rangeMatch[1] + '.0') >>> 0;
      const lo = parseInt(rangeMatch[2], 10);
      const hi = parseInt(rangeMatch[3], 10);
      if (lo > hi || lo > 255 || hi > 255) {
        throw new Error(`mDNS: invalid range in "${entry}"`);
      }
      const start = (base | lo) >>> 0;
      const end = (base | hi) >>> 0;
      matchers.push((ip: number) => ip >= start && ip <= end);
      continue;
    }

    // Single IP: "10.255.0.1"
    if (/^\d+\.\d+\.\d+\.\d+$/.test(entry)) {
      const exact = ipToNumber(entry);
      matchers.push((ip: number) => ip === exact);
      continue;
    }

    throw new Error(`mDNS: unrecognized exclude entry "${entry}"`);
  }
  return matchers;
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  return (
    ((parseInt(parts[0]) << 24) | (parseInt(parts[1]) << 16) | (parseInt(parts[2]) << 8) | parseInt(parts[3])) >>> 0
  );
}

function isExcluded(ip: string, matchers: IpMatcher[]): boolean {
  if (matchers.length === 0) return false;
  const num = ipToNumber(ip);
  return matchers.some(m => m(num));
}

// ── Team IP helpers ─────────────────────────────────────────────────

function teamToVlanIp(team: number, hostOctet: number): string {
  const high = Math.floor(team / 100);
  const low = team % 100;
  return `10.${high}.${low}.${hostOctet}`;
}

/** Derive a team number from a 10.te.am.x source IP, or null if not a valid team VLAN IP. */
function ipToTeam(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const te = parseInt(parts[1], 10);
  const am = parseInt(parts[2], 10);
  if (isNaN(te) || isNaN(am) || am > 99) return null;
  const team = te * 100 + am;
  return team > 0 ? team : null;
}

// ── MdnsReflector ───────────────────────────────────────────────────

export class MdnsReflector {
  private socket: dgram.Socket | null = null;
  /** Teams whose VLAN we've joined multicast on → their VLAN IP */
  private joinedTeams = new Map<number, string>();
  /** Reverse lookup: team number → station name (rebuilt in refreshMemberships) */
  private teamToStation = new Map<number, StationName>();
  /** Per-station counters and recent names for reflected packets */
  private counters = new Map<StationName, StationMdnsActivity>();
  /** IPs/ranges to exclude from requester tracking */
  private readonly excludedRequesters: IpMatcher[];

  constructor(
    private readonly getTeamForStation: (station: StationName) => number | null,
    private readonly vlanHostOctet: number = 254,
    excludeRequesters?: string,
  ) {
    this.excludedRequesters = excludeRequesters ? parseExcludeList(excludeRequesters) : [];
    if (this.excludedRequesters.length > 0) {
      console.log(`mDNS: excluding requesters matching ${excludeRequesters}`);
    }
  }

  /** Get the current activity state for broadcasting to clients. */
  getActivity(): MdnsActivity {
    const stations: MdnsActivity['stations'] = {};
    for (const [station, activity] of this.counters) {
      stations[station] = { ...activity, recentNames: [...activity.recentNames] };
    }
    return { type: 'mdnsActivity', stations };
  }

  start(): void {
    if (this.socket) return;

    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('error', err => {
      console.error('mDNS reflector error:', err);
    });

    socket.on('message', (msg, rinfo) => {
      this.handlePacket(msg, rinfo);
    });

    socket.bind(MDNS_PORT, () => {
      // Join mDNS multicast on the default interface (main network).
      // 0.0.0.0 = OS picks the interface with the default route, which in
      // the expected deployment is the physical NIC (e.g. eno1) where
      // laptops live. If the default route ever points elsewhere, this
      // would need to be an explicit interface IP instead.
      socket.addMembership(MDNS_ADDR);
      socket.setMulticastLoopback(false);
      socket.setMulticastTTL(255); // mDNS spec requires TTL=255
      console.log('mDNS reflector started on port', MDNS_PORT);

      // Join multicast on active VLAN interfaces
      this.refreshMemberships();
    });

    this.socket = socket;
  }

  stop(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.joinedTeams.clear();
    console.log('mDNS reflector stopped');
  }

  /** Call when station config changes to update multicast memberships. */
  refreshMemberships(): void {
    if (!this.socket) return;

    // Rebuild team → station reverse map
    this.teamToStation.clear();
    const activeTeams = new Set<number>();
    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team !== null) {
        activeTeams.add(team);
        this.teamToStation.set(team, station);
      }
    }

    // Leave multicast on VLANs that are no longer active
    for (const [team, ip] of this.joinedTeams) {
      if (!activeTeams.has(team)) {
        try {
          this.socket.dropMembership(MDNS_ADDR, ip);
          console.log(`mDNS: left multicast on VLAN for team ${team} (${ip})`);
        } catch {
          // Interface may already be gone
        }
        this.joinedTeams.delete(team);
      }
    }

    // Clean up counters for stations that no longer have a team
    for (const station of this.counters.keys()) {
      const team = this.getTeamForStation(station);
      if (team === null || !activeTeams.has(team)) {
        this.counters.delete(station);
      }
    }

    // Join multicast on newly active VLANs
    for (const team of activeTeams) {
      if (this.joinedTeams.has(team)) continue;
      const ip = teamToVlanIp(team, this.vlanHostOctet);
      try {
        this.socket.addMembership(MDNS_ADDR, ip);
        this.joinedTeams.set(team, ip);
        console.log(`mDNS: joined multicast on VLAN for team ${team} (${ip})`);
      } catch (err) {
        console.error(`mDNS: failed to join multicast for team ${team} (${ip}):`, err);
      }
    }
  }

  private handlePacket(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < 12) return;

    const isResponse = (msg[2] & 0x80) !== 0; // QR bit in DNS header flags
    const sourceTeam = ipToTeam(rinfo.address);

    if (sourceTeam && this.joinedTeams.has(sourceTeam)) {
      // Packet from a team VLAN — only forward responses (robot answers) to main
      if (!isResponse) return;

      const records = parseAnswerRecords(msg);
      const team = records.map(r => extractTeamFromName(r.name)).find(t => t !== null);
      if (team == null) return;

      const station = this.teamToStation.get(sourceTeam);
      if (!station) return;

      const names: MdnsResolvedName[] = records.map(r => ({ name: r.name.toLowerCase(), resolvedIp: r.resolvedIp }));
      this.incrementCounter(station, sourceTeam, 'responsesForwarded', names);
      this.forwardToMain(msg);
    } else {
      // Packet from the main network — only forward queries (laptop lookups) to VLANs
      if (isResponse) return;

      const excluded = isExcluded(rinfo.address, this.excludedRequesters);

      const queryNames = parseQuestionNames(msg);
      const teams = new Set<number>();
      for (const name of queryNames) {
        const team = extractTeamFromName(name);
        if (team !== null) teams.add(team);
      }

      for (const team of teams) {
        if (this.joinedTeams.has(team)) {
          const station = this.teamToStation.get(team);
          if (!station) continue;
          if (!excluded) {
            const teamNames = queryNames.filter(n => extractTeamFromName(n) === team);
            const names: MdnsResolvedName[] = teamNames.map(n => ({ name: n.toLowerCase(), requester: rinfo.address }));
            this.incrementCounter(station, team, 'queriesForwarded', names);
          }
          this.forwardToVlan(msg, team);
        }
      }
    }
  }

  /**
   * Forward a query packet to a team's VLAN by switching the socket's
   * outgoing multicast interface. Safe to call in sequence because Node.js
   * is single-threaded — setMulticastInterface + send execute atomically
   * within the same event loop tick.
   */
  private forwardToVlan(packet: Buffer, team: number): void {
    const vlanIp = this.joinedTeams.get(team);
    if (!vlanIp || !this.socket) return;

    this.socket.setMulticastInterface(vlanIp);
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, err => {
      if (err) console.error(`mDNS: failed to forward query to team ${team}:`, err);
    });
  }

  private static readonly MAX_RECENT_NAMES = 10;

  private incrementCounter(
    station: StationName,
    team: number,
    field: 'queriesForwarded' | 'responsesForwarded',
    names: MdnsResolvedName[],
  ) {
    let entry = this.counters.get(station);
    if (!entry) {
      entry = { team, queriesForwarded: 0, responsesForwarded: 0, recentNames: [] };
      this.counters.set(station, entry);
    }
    entry[field]++;
    for (const incoming of names) {
      // Condense service discovery names: group by hostname, collect services
      const { hostname, service } = splitMdnsName(incoming.name);

      // Move to front if already present (merge fields), otherwise prepend
      const idx = entry.recentNames.findIndex(r => r.name === hostname);
      if (idx !== -1) {
        const existing = entry.recentNames.splice(idx, 1)[0];
        // Merge services list
        const services = existing.services ? [...existing.services] : [];
        if (service && !services.includes(service)) services.push(service);
        entry.recentNames.unshift({
          name: hostname,
          resolvedIp: incoming.resolvedIp ?? existing.resolvedIp,
          requester: incoming.requester ?? existing.requester,
          services: services.length > 0 ? services : undefined,
        });
      } else {
        entry.recentNames.unshift({
          name: hostname,
          resolvedIp: incoming.resolvedIp,
          requester: incoming.requester,
          services: service ? [service] : undefined,
        });
      }
    }
    if (entry.recentNames.length > MdnsReflector.MAX_RECENT_NAMES) {
      entry.recentNames.length = MdnsReflector.MAX_RECENT_NAMES;
    }
  }

  /** Forward a response packet to the main network (default route interface). */
  private forwardToMain(packet: Buffer): void {
    if (!this.socket) return;

    // 0.0.0.0 = default multicast interface (see comment in start())
    this.socket.setMulticastInterface('0.0.0.0');
    this.socket.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDR, err => {
      if (err) console.error('mDNS: failed to forward response to main network:', err);
    });
  }
}
