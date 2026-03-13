import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { RobotTestState, RobotTestPhase, CheckResult } from './types.js';
import { checkRadio, checkRoboRIO, teamSubnet } from './teamChecker.js';
import type { NetworkBackend } from './node-ip/index.js';

const execFile = promisify(execFileCb);

const LINK_POLL_MS = 200;
const CHECK_INTERVAL_MS = 10_000;
const LEASE_FILE = '/tmp/pfms-test.lease';

/** Parse a team number from an IP in the 10.TE.AM.x range. */
function teamFromIp(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const high = parseInt(parts[1], 10);
  const low = parseInt(parts[2], 10);
  if (isNaN(high) || isNaN(low)) return null;
  const team = high * 100 + low;
  return team > 0 && team <= 25599 ? team : null;
}

/** Parse a dhclient lease file for the most recent lease. */
function parseDhclientLease(content: string): { ip: string; router?: string } | null {
  // Find the last lease block
  const leases = content.split(/^lease\s*\{/m);
  if (leases.length < 2) return null;
  const lastLease = leases[leases.length - 1];

  const ipMatch = lastLease.match(/fixed-address\s+([\d.]+)/);
  if (!ipMatch) return null;

  const routerMatch = lastLease.match(/option routers\s+([\d.]+)/);
  return { ip: ipMatch[1], router: routerMatch?.[1] };
}

export class RobotTestMonitor {
  private phase: RobotTestPhase = 'link_down';
  private linkUp = false;
  private macAddress?: string;
  private teamNumber?: number;
  private leasedIp?: string;
  private routerIp?: string;
  private checks: CheckResult[] = [];
  private linkPollTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private dhclientProc: ChildProcess | null = null;
  private checking = false;

  constructor(
    private readonly interfaceName: string,
    private readonly net: NetworkBackend,
    private readonly onStateChange: (state: RobotTestState) => void,
    private readonly dryRun = false,
  ) {}

  async start(): Promise<void> {
    console.log(`RobotTestMonitor: starting on ${this.interfaceName}`);
    if (!this.dryRun) {
      await this.net.setInterfaceUp(this.interfaceName);
    }
    this.linkPollTimer = setInterval(() => this.pollLink(), LINK_POLL_MS);
    this.broadcast();
  }

  stop(): void {
    if (this.linkPollTimer) {
      clearInterval(this.linkPollTimer);
      this.linkPollTimer = null;
    }
    this.stopChecking();
    this.killDhclient();
    console.log('RobotTestMonitor: stopped');
  }

  getState(): RobotTestState {
    return {
      type: 'robotTestState',
      phase: this.phase,
      interfaceName: this.interfaceName,
      linkUp: this.linkUp,
      macAddress: this.macAddress,
      teamNumber: this.teamNumber,
      leasedIp: this.leasedIp,
      routerIp: this.routerIp,
      checks: this.checks,
      lastUpdate: Date.now(),
    };
  }

  // ── Link detection ────────────────────────────────────────────────

  private async pollLink(): Promise<void> {
    try {
      const interfaces = await this.net.listInterfaces(this.interfaceName);
      const iface = interfaces[0];
      if (!iface) {
        if (this.linkUp) this.handleLinkDown();
        return;
      }

      this.macAddress = iface.mac;
      const up = iface.state === 'UP';

      if (up && !this.linkUp) {
        this.handleLinkUp();
      } else if (!up && this.linkUp) {
        this.handleLinkDown();
      }
    } catch {
      // Interface might not exist yet
      if (this.linkUp) this.handleLinkDown();
    }
  }

  private handleLinkUp(): void {
    this.linkUp = true;
    this.phase = 'link_up';
    console.log(`RobotTestMonitor: link UP on ${this.interfaceName}`);
    this.broadcast();
    this.startDhcp();
  }

  private handleLinkDown(): void {
    this.linkUp = false;
    this.phase = 'link_down';
    this.teamNumber = undefined;
    this.leasedIp = undefined;
    this.routerIp = undefined;
    this.checks = [];
    this.stopChecking();
    this.killDhclient();
    if (!this.dryRun) {
      this.net.flushAddresses(this.interfaceName).catch(() => {});
    }
    console.log(`RobotTestMonitor: link DOWN on ${this.interfaceName}`);
    this.broadcast();
  }

  // ── DHCP ──────────────────────────────────────────────────────────

  private startDhcp(): void {
    if (this.dryRun) {
      console.log(`[dry-run] Would run dhclient on ${this.interfaceName}`);
      this.phase = 'dhcp_requesting';
      this.broadcast();
      return;
    }

    this.phase = 'dhcp_requesting';
    this.broadcast();

    // Kill any stale dhclient for this interface
    this.killDhclient();

    const proc = spawn(
      'dhclient',
      ['-1', '-v', '-lf', LEASE_FILE, '-pf', `/tmp/pfms-dhclient-${this.interfaceName}.pid`, this.interfaceName],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.dhclientProc = proc;

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('exit', async code => {
      this.dhclientProc = null;
      if (!this.linkUp) return; // Link dropped during DHCP

      if (code === 0) {
        await this.handleDhcpSuccess();
      } else {
        console.log(`RobotTestMonitor: dhclient exited with code ${code}`);
        for (const line of output.trim().split('\n')) {
          console.log(`  dhclient: ${line}`);
        }
        // Retry after a delay if link is still up
        if (this.linkUp) {
          setTimeout(() => {
            if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
          }, 2000);
        }
      }
    });
  }

  private async handleDhcpSuccess(): Promise<void> {
    try {
      const leaseContent = await readFile(LEASE_FILE, 'utf-8');
      const lease = parseDhclientLease(leaseContent);
      if (!lease) {
        console.log('RobotTestMonitor: could not parse lease file');
        return;
      }

      this.leasedIp = lease.ip;
      this.routerIp = lease.router;
      this.teamNumber = teamFromIp(lease.ip) ?? undefined;

      if (this.teamNumber) {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — team ${this.teamNumber}, IP ${lease.ip}`);
      } else {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — IP ${lease.ip} (not a team subnet)`);
      }

      this.broadcast();
      this.runChecks();
    } catch (err) {
      console.error('RobotTestMonitor: error reading lease file:', err);
    }
  }

  private killDhclient(): void {
    if (this.dhclientProc) {
      this.dhclientProc.kill();
      this.dhclientProc = null;
    }
    // Also kill any orphaned dhclient for this interface
    execFile('pkill', ['-f', `dhclient.*${this.interfaceName}`]).catch(() => {});
  }

  // ── Robot checks ──────────────────────────────────────────────────

  private async runChecks(): Promise<void> {
    if (!this.teamNumber || this.checking) return;

    this.checking = true;
    this.phase = 'checking';
    this.broadcast();

    try {
      const [radioResults, rioResults] = await Promise.all([
        checkRadio(this.teamNumber),
        checkRoboRIO(this.teamNumber),
      ]);
      this.checks = [...radioResults, ...rioResults];
      this.phase = 'complete';
    } catch (err) {
      console.error('RobotTestMonitor: check error:', err);
    } finally {
      this.checking = false;
      this.broadcast();

      // Schedule re-check
      this.stopChecking();
      this.checkTimer = setTimeout(() => {
        if (this.linkUp && this.teamNumber) this.runChecks();
      }, CHECK_INTERVAL_MS);
    }
  }

  private stopChecking(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  // ── Broadcast ─────────────────────────────────────────────────────

  private broadcast(): void {
    this.onStateChange(this.getState());
  }
}
