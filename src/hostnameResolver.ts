import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import type { HostnamesState } from './types.js';

/** How long a successful resolution stays fresh before re-querying. */
const POSITIVE_TTL_MS = 10 * 60_000;
/** How long before retrying an IP that didn't resolve to any name. */
const NEGATIVE_TTL_MS = 2 * 60_000;
/** Per-strategy query timeout. */
const QUERY_TIMEOUT_MS = 2_000;
/** Drop cache entries for IPs nobody has asked about in this long. */
const IDLE_EVICT_MS = 60 * 60_000;

interface CacheEntry {
  hostname: string | null;
  resolvedAt: number;
  lastTracked: number;
}

/**
 * Resolves display names for guest-network hosts (DS laptops, phones).
 *
 * pFMS does not run DHCP on the guest network — the site router does — so
 * there is no lease file to read. Instead each host is asked directly, with
 * three strategies in parallel (all unicast to the target, so no multicast
 * interface juggling):
 *
 *   - mDNS reverse PTR (UDP 5353): Windows 10+, macOS, iOS, Linux/Avahi all
 *     answer legacy unicast queries sent from an ephemeral port (RFC 6762 §6.7).
 *   - NetBIOS node status (UDP 137): every Windows machine answers with its
 *     machine name — DS laptops are Windows, so this is the reliable one.
 *   - DNS PTR via the system resolver: works when the site router registers
 *     DHCP client names (dnsmasq/UniFi setups).
 *
 * Preference order mDNS > NetBIOS > PTR (self-reported names over
 * router-recorded ones). Results are cached and pushed to clients as a
 * `hostnames` broadcast whenever something changes.
 */
export class HostnameResolver {
  private cache = new Map<string, CacheEntry>();
  private inFlight = new Set<string>();
  private broadcastTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onUpdate?: (state: HostnamesState) => void) {}

  getState(): HostnamesState {
    const hostnames: Record<string, string> = {};
    for (const [ip, entry] of this.cache) {
      if (entry.hostname) hostnames[ip] = entry.hostname;
    }
    return { type: 'hostnames', hostnames };
  }

  /**
   * Note interest in a guest-network IP, resolving its hostname if unknown or
   * stale. Safe to call repeatedly (every broadcast tick) — fresh entries are
   * a cheap map lookup. Non-private and loopback addresses are ignored.
   */
  track(ip: string): void {
    if (!isResolvableIp(ip)) return;

    const now = Date.now();
    const entry = this.cache.get(ip);
    if (entry) {
      entry.lastTracked = now;
      const ttl = entry.hostname ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      if (now - entry.resolvedAt < ttl) return;
    }
    if (this.inFlight.has(ip)) return;

    this.inFlight.add(ip);
    this.resolve(ip)
      .catch(() => {
        // Individual strategies already swallow their errors; nothing to log here
      })
      .finally(() => {
        this.inFlight.delete(ip);
      });

    this.evictIdle(now);
  }

  private async resolve(ip: string): Promise<void> {
    const [mdns, netbios, ptr] = await Promise.all([
      mdnsReverseLookup(ip).catch(() => null),
      netbiosNameLookup(ip).catch(() => null),
      dnsPtrLookup(ip).catch(() => null),
    ]);
    const hostname = mdns ?? netbios ?? ptr;

    const now = Date.now();
    const previous = this.cache.get(ip);
    this.cache.set(ip, {
      // A transient miss should not blank out a name we already know — the
      // host may just be asleep. The stale name ages out via IDLE_EVICT_MS.
      hostname: hostname ?? previous?.hostname ?? null,
      resolvedAt: now,
      lastTracked: previous?.lastTracked ?? now,
    });

    if (hostname && hostname !== previous?.hostname) {
      this.scheduleBroadcast();
    }
  }

  /** Coalesce broadcasts when several IPs resolve in the same scan cycle. */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer || !this.onUpdate) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.onUpdate?.(this.getState());
    }, 250);
  }

  private evictIdle(now: number): void {
    for (const [ip, entry] of this.cache) {
      if (now - entry.lastTracked > IDLE_EVICT_MS) this.cache.delete(ip);
    }
  }
}

/** Only resolve private (RFC 1918) addresses — never loopback or internet IPs. */
function isResolvableIp(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isInteger(o) || o < 0 || o > 255)) return false;
  if (octets[0] === 127) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  return false;
}

/** "DESKTOP-ABC123.local" → "DESKTOP-ABC123"; empty/garbage → null. */
function shortName(name: string | undefined): string | null {
  if (!name) return null;
  const short = name.replace(/\.$/, '').split('.')[0].trim();
  return short.length > 0 ? short : null;
}

/** Reverse DNS (PTR) through the system resolver. */
async function dnsPtrLookup(ip: string): Promise<string | null> {
  const resolver = new Resolver({ timeout: QUERY_TIMEOUT_MS, tries: 1 });
  const names = await resolver.reverse(ip);
  return shortName(names[0]);
}

// ── DNS wire format helpers ─────────────────────────────────────────

/** Encode a dotted name as DNS labels (no compression). */
function encodeDnsName(name: string): Buffer {
  const parts = name.split('.').map(label => {
    const buf = Buffer.alloc(1 + label.length);
    buf[0] = label.length;
    buf.write(label, 1, 'latin1');
    return buf;
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

/**
 * Decode a (possibly compressed) DNS name starting at `offset`.
 * Returns the dotted name and the offset just past the name in the
 * original (non-pointer) position.
 */
function parseDnsName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let jumps = 0;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      if (next < 0) next = pos + 1;
      return { name: labels.join('.'), next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) return null;
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      if (++jumps > 8) return null; // pointer loop
      continue;
    }
    if (pos + 1 + len > buf.length) return null;
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('latin1'));
    pos += 1 + len;
  }
  return null;
}

/** Send one UDP packet and resolve with the first parseable reply (or null on timeout/error). */
function udpQuery(
  ip: string,
  port: number,
  packet: Buffer,
  parse: (msg: Buffer) => string | null,
): Promise<string | null> {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    let settled = false;
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        // Already closed
      }
      resolve(result);
    };
    const timer = setTimeout(() => done(null), QUERY_TIMEOUT_MS);
    sock.on('message', msg => {
      const name = parse(msg);
      if (name) done(name);
    });
    sock.on('error', () => done(null));
    sock.send(packet, 0, packet.length, port, ip, err => {
      if (err) done(null);
    });
  });
}

// ── mDNS reverse lookup ─────────────────────────────────────────────

const TYPE_PTR = 12;
const CLASS_IN = 1;

/**
 * Ask the host itself for its mDNS name via a reverse PTR query sent unicast
 * to port 5353. Because our source port is ephemeral (not 5353), responders
 * treat it as a legacy unicast query and reply directly to us (RFC 6762 §6.7).
 */
async function mdnsReverseLookup(ip: string): Promise<string | null> {
  const arpaName = `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.concat([encodeDnsName(arpaName), Buffer.from([0, TYPE_PTR, 0, CLASS_IN])]);
  const query = Buffer.concat([header, question]);

  return udpQuery(ip, 5353, query, msg => parsePtrResponse(msg, arpaName));
}

/** Extract the PTR target for `queryName` from a DNS response. */
function parsePtrResponse(msg: Buffer, queryName: string): string | null {
  if (msg.length < 12) return null;
  const qdCount = msg.readUInt16BE(4);
  const anCount = msg.readUInt16BE(6);
  if (anCount === 0) return null;

  let pos = 12;
  for (let i = 0; i < qdCount; i++) {
    const q = parseDnsName(msg, pos);
    if (!q) return null;
    pos = q.next + 4; // type + class
  }
  for (let i = 0; i < anCount; i++) {
    const owner = parseDnsName(msg, pos);
    if (!owner || owner.next + 10 > msg.length) return null;
    const type = msg.readUInt16BE(owner.next);
    const rdLength = msg.readUInt16BE(owner.next + 8);
    const rdataStart = owner.next + 10;
    if (rdataStart + rdLength > msg.length) return null;
    if (type === TYPE_PTR && owner.name.toLowerCase() === queryName.toLowerCase()) {
      const target = parseDnsName(msg, rdataStart);
      const name = shortName(target?.name);
      if (name) return name;
    }
    pos = rdataStart + rdLength;
  }
  return null;
}

// ── NetBIOS node status lookup ──────────────────────────────────────

/**
 * NBSTAT "node status" query — asks a Windows machine (UDP 137) for its
 * NetBIOS name table and returns the unique workstation name (suffix 0x00).
 */
async function netbiosNameLookup(ip: string): Promise<string | null> {
  // The wildcard name "*" (padded to 16 bytes with NULs), first-level encoded:
  // each nibble becomes a letter 'A'..'P', giving a fixed 32-char name.
  const raw = Buffer.alloc(16);
  raw.write('*', 0, 'latin1');
  const encoded = Buffer.alloc(34);
  encoded[0] = 32;
  for (let i = 0; i < 16; i++) {
    encoded[1 + i * 2] = 0x41 + (raw[i] >> 4);
    encoded[2 + i * 2] = 0x41 + (raw[i] & 0x0f);
  }
  encoded[33] = 0;

  const header = Buffer.from([0x13, 0x37, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.concat([encoded, Buffer.from([0, 0x21, 0, CLASS_IN])]); // NBSTAT, IN
  const query = Buffer.concat([header, question]);

  return udpQuery(ip, 137, query, parseNodeStatusResponse);
}

/** Pull the unique workstation name out of an NBSTAT response. */
function parseNodeStatusResponse(msg: Buffer): string | null {
  if (msg.length < 12) return null;
  const qdCount = msg.readUInt16BE(4);
  const anCount = msg.readUInt16BE(6);
  if (anCount === 0) return null;

  let pos = 12;
  for (let i = 0; i < qdCount; i++) {
    const q = parseDnsName(msg, pos);
    if (!q) return null;
    pos = q.next + 4;
  }
  const owner = parseDnsName(msg, pos);
  if (!owner || owner.next + 10 > msg.length) return null;
  const rdataStart = owner.next + 10; // type + class + ttl + rdlength
  if (rdataStart >= msg.length) return null;

  const numNames = msg[rdataStart];
  let entry = rdataStart + 1;
  for (let i = 0; i < numNames; i++, entry += 18) {
    if (entry + 18 > msg.length) break;
    const suffix = msg[entry + 15];
    const flags = msg.readUInt16BE(entry + 16);
    const isGroup = (flags & 0x8000) !== 0;
    if (suffix !== 0x00 || isGroup) continue; // want the unique workstation name
    const name = msg
      .subarray(entry, entry + 15)
      .toString('latin1')
      .trim();
    // Skip placeholder entries that aren't printable machine names
    if (name && name !== '*' && /^[\x20-\x7e]+$/.test(name)) return name;
  }
  return null;
}
