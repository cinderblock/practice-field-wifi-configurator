import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { StationName, SubnetScanResults, StationSubnetScan, DiscoveredHost } from './types.js';
import { StationNameList } from './types.js';

const execFile = promisify(execFileCb);

type TeamLookup = (station: StationName) => number | null;

interface HostState {
  firstSeen: number;
  lastSeen: number;
  alive: boolean;
}

export class SubnetScanner {
  private state = new Map<StationName, Map<string, HostState>>();
  private lastScanTime = new Map<StationName, number>();
  private interval: NodeJS.Timeout | null = null;
  private scanning = false;

  constructor(
    private readonly getTeamForStation: TeamLookup,
    private readonly onScanComplete?: (results: SubnetScanResults) => void,
    private readonly dryRun = false,
  ) {}

  start(intervalMs = 10_000): void {
    this.stop();
    this.runScan();
    this.interval = setInterval(() => this.runScan(), intervalMs);
    console.log(`SubnetScanner started (interval: ${intervalMs}ms, dry-run: ${this.dryRun})`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  clearStation(station: StationName): void {
    this.state.delete(station);
    this.lastScanTime.delete(station);
  }

  clearAll(): void {
    this.state.clear();
    this.lastScanTime.clear();
  }

  getResults(): SubnetScanResults {
    const stations: Partial<Record<StationName, StationSubnetScan>> = {};

    for (const station of StationNameList) {
      const team = this.getTeamForStation(station);
      if (team === null) continue;

      const hostMap = this.state.get(station);
      if (!hostMap || hostMap.size === 0) continue;

      const subnet = SubnetScanner.teamSubnet(team);
      const hosts: DiscoveredHost[] = [];

      for (const [ip, state] of hostMap) {
        hosts.push({
          ip,
          alive: state.alive,
          firstSeen: state.firstSeen,
          lastSeen: state.lastSeen,
        });
      }

      // Sort by last octet numerically
      hosts.sort((a, b) => {
        const aOctet = parseInt(a.ip.split('.')[3]);
        const bOctet = parseInt(b.ip.split('.')[3]);
        return aOctet - bOctet;
      });

      stations[station] = {
        team,
        subnet,
        hosts,
        lastScanTime: this.lastScanTime.get(station) ?? 0,
      };
    }

    return { type: 'subnetScan', stations };
  }

  private async runScan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;

    try {
      const promises: Promise<void>[] = [];
      for (const station of StationNameList) {
        const team = this.getTeamForStation(station);
        if (team === null) continue;
        promises.push(this.scanStation(station, team));
      }
      await Promise.all(promises);
      this.onScanComplete?.(this.getResults());
    } catch (err) {
      console.error('SubnetScanner error:', err);
    } finally {
      this.scanning = false;
    }
  }

  private async scanStation(station: StationName, team: number): Promise<void> {
    const subnet = SubnetScanner.teamSubnet(team);
    const rangeStart = `${subnet}.1`;
    const rangeEnd = `${subnet}.253`;
    const now = Date.now();

    if (this.dryRun) {
      console.log(`[dry-run] Would fping ${rangeStart} - ${rangeEnd} for ${station}`);
      this.lastScanTime.set(station, now);
      return;
    }

    const aliveIps = await this.runFping(station, rangeStart, rangeEnd);
    if (aliveIps === null) return; // fping failed entirely

    if (!this.state.has(station)) {
      this.state.set(station, new Map());
    }
    const hostMap = this.state.get(station)!;

    // Mark all previously-seen hosts as down
    for (const host of hostMap.values()) {
      host.alive = false;
    }

    // Update alive hosts
    for (const ip of aliveIps) {
      const existing = hostMap.get(ip);
      if (existing) {
        existing.alive = true;
        existing.lastSeen = now;
      } else {
        hostMap.set(ip, { firstSeen: now, lastSeen: now, alive: true });
      }
    }

    this.lastScanTime.set(station, now);
  }

  private async runFping(station: StationName, rangeStart: string, rangeEnd: string): Promise<Set<string> | null> {
    try {
      const { stdout } = await execFile('fping', ['-a', '-r', '0', '-t', '200', '-q', '-g', rangeStart, rangeEnd], {
        timeout: 15_000,
      });
      return SubnetScanner.parseAliveIps(stdout);
    } catch (err: unknown) {
      // fping exits 1 when some hosts are unreachable (the common case).
      // Node's execFile rejects on non-zero exit, but stdout still has alive hosts.
      if (err && typeof err === 'object' && 'code' in err) {
        const e = err as { code: number | string; stdout?: string };
        if (e.code === 1 && typeof e.stdout === 'string') {
          return SubnetScanner.parseAliveIps(e.stdout);
        }
        if (e.code === 'ENOENT') {
          console.error('fping not found. Install with: sudo apt install fping');
          this.stop();
          return null;
        }
      }
      console.error(`SubnetScanner: fping failed for ${station}:`, err);
      return null;
    }
  }

  private static parseAliveIps(stdout: string): Set<string> {
    return new Set(
      stdout
        .trim()
        .split('\n')
        .filter(line => line.trim()),
    );
  }

  static teamSubnet(team: number): string {
    const high = Math.floor(team / 100);
    const low = team % 100;
    return `10.${high}.${low}`;
  }
}
