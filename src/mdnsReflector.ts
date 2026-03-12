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
import { MdnsActivity, StationName, StationNameList } from './types.js';

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

/** Extract all answer record names from an mDNS packet. */
function parseAnswerNames(buf: Buffer): string[] {
  if (buf.length < 12) return [];
  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const names: string[] = [];

  // Skip past question section
  let offset = 12;
  for (let i = 0; i < qdCount && offset < buf.length; i++) {
    const { bytesRead } = readDnsName(buf, offset);
    offset += bytesRead + 4;
  }

  // Read answer record names
  for (let i = 0; i < anCount && offset < buf.length; i++) {
    const { name, bytesRead } = readDnsName(buf, offset);
    if (name) names.push(name);
    offset += bytesRead;
    if (offset + 10 > buf.length) break;
    const rdLength = buf.readUInt16BE(offset + 8);
    offset += 10 + rdLength; // TYPE(2) + CLASS(2) + TTL(4) + RDLENGTH(2) + RDATA
  }

  return names;
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
const FRC_PATTERNS: RegExp[] = [
  /^roboRIO-(\d{1,5})-FRC\b/i,
];

function extractTeamFromName(dnsName: string): number | null {
  // mDNS names end with .local (sometimes with trailing dot) — strip for matching
  const hostname = dnsName.replace(/\.local\.?$/i, '');
  for (const pattern of FRC_PATTERNS) {
    const match = hostname.match(pattern);
    if (match) return parseInt(match[1], 10);
  }
  return null;
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
  /** Per-team counters and recent names for reflected packets */
  private counters = new Map<number, { queriesForwarded: number; responsesForwarded: number; recentNames: string[] }>();

  constructor(
    private readonly getTeamForStation: (station: StationName) => number | null,
    private readonly vlanHostOctet: number = 254,
  ) {}

  /** Get the current activity state for broadcasting to clients. */
  getActivity(): MdnsActivity {
    const teams: MdnsActivity['teams'] = {};
    for (const [team, counts] of this.counters) {
      teams[team] = { ...counts, recentNames: [...counts.recentNames] };
    }
    return { type: 'mdnsActivity', teams };
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

    const activeTeams = new Set<number>();
    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team !== null) activeTeams.add(team);
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
        this.counters.delete(team);
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

      const answerNames = parseAnswerNames(msg);
      const team = answerNames.map(extractTeamFromName).find(t => t !== null);
      if (team == null) return;

      this.incrementCounter(sourceTeam, 'responsesForwarded', answerNames);
      this.forwardToMain(msg);
    } else {
      // Packet from the main network — only forward queries (laptop lookups) to VLANs
      if (isResponse) return;

      const queryNames = parseQuestionNames(msg);
      const teams = new Set<number>();
      for (const name of queryNames) {
        const team = extractTeamFromName(name);
        if (team !== null) teams.add(team);
      }

      for (const team of teams) {
        if (this.joinedTeams.has(team)) {
          const teamNames = queryNames.filter(n => extractTeamFromName(n) === team);
          this.incrementCounter(team, 'queriesForwarded', teamNames);
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

  private incrementCounter(team: number, field: 'queriesForwarded' | 'responsesForwarded', names?: string[]) {
    let entry = this.counters.get(team);
    if (!entry) {
      entry = { queriesForwarded: 0, responsesForwarded: 0, recentNames: [] };
      this.counters.set(team, entry);
    }
    entry[field]++;
    if (names) {
      for (const raw of names) {
        const name = raw.toLowerCase();
        // Move to front if already present, otherwise prepend
        const idx = entry.recentNames.indexOf(name);
        if (idx !== -1) entry.recentNames.splice(idx, 1);
        entry.recentNames.unshift(name);
      }
      // Cap the list
      if (entry.recentNames.length > MdnsReflector.MAX_RECENT_NAMES) {
        entry.recentNames.length = MdnsReflector.MAX_RECENT_NAMES;
      }
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
