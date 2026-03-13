import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { RobotTestState, RobotTestPhase, CheckResult } from './types.js';
import { checkRadio, checkRoboRIO, teamSubnet } from './teamChecker.js';
import type { NetworkBackend } from './node-ip/index.js';

const execFile = promisify(execFileCb);

const LINK_POLL_MS = 200;
const CHECK_INTERVAL_MS = 10_000;

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

/** Read the first IPv4 address assigned to an interface via `ip`. */
async function getInterfaceIp(iface: string): Promise<{ ip: string; router?: string } | null> {
  try {
    const { stdout } = await execFile('ip', ['-j', 'addr', 'show', 'dev', iface]);
    const data = JSON.parse(stdout);
    if (!data[0]?.addr_info) return null;
    const v4 = data[0].addr_info.find((a: { family: string }) => a.family === 'inet');
    if (!v4) return null;
    return { ip: v4.local };
  } catch {
    return null;
  }
}

/** Read the default gateway for an interface from the routing table. */
async function getInterfaceGateway(iface: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('ip', ['-j', 'route', 'show', 'dev', iface, 'default']);
    const routes = JSON.parse(stdout);
    return routes[0]?.gateway;
  } catch {
    return undefined;
  }
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
  private dhcpProc: ChildProcess | null = null;
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
    this.killDhcp();
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
    this.killDhcp();
    if (!this.dryRun) {
      this.net.flushAddresses(this.interfaceName).catch(() => {});
    }
    console.log(`RobotTestMonitor: link DOWN on ${this.interfaceName}`);
    this.broadcast();
  }

  // ── DHCP ──────────────────────────────────────────────────────────

  private startDhcp(): void {
    if (this.dryRun) {
      console.log(`[dry-run] Would run dhcpcd on ${this.interfaceName}`);
      this.phase = 'dhcp_requesting';
      this.broadcast();
      return;
    }

    this.phase = 'dhcp_requesting';
    this.broadcast();

    // Kill any stale dhcpcd for this interface
    this.killDhcp();

    // dhcpcd --oneshot: obtain a lease and exit
    // --nobackground: stay in foreground (we manage the process)
    // --waitip 4: wait until an IPv4 address is assigned
    const proc = spawn('dhcpcd', ['--oneshot', '--nobackground', '--waitip', '4', this.interfaceName], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.dhcpProc = proc;

    proc.on('error', err => {
      this.dhcpProc = null;
      console.error(`RobotTestMonitor: failed to start dhcpcd: ${err.message}`);
      // Retry after a delay if link is still up
      if (this.linkUp) {
        setTimeout(() => {
          if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
        }, 5000);
      }
    });

    let output = '';
    proc.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    proc.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    proc.on('exit', async code => {
      this.dhcpProc = null;
      if (!this.linkUp) return; // Link dropped during DHCP

      if (code === 0) {
        await this.handleDhcpSuccess();
      } else {
        console.log(`RobotTestMonitor: dhcpcd exited with code ${code}`);
        for (const line of output.trim().split('\n')) {
          console.log(`  dhcpcd: ${line}`);
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
      // Read the assigned IP directly from the interface
      const addr = await getInterfaceIp(this.interfaceName);
      if (!addr) {
        console.log('RobotTestMonitor: dhcpcd succeeded but no IP on interface');
        return;
      }

      this.leasedIp = addr.ip;
      this.routerIp = await getInterfaceGateway(this.interfaceName);
      this.teamNumber = teamFromIp(addr.ip) ?? undefined;

      if (this.teamNumber) {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — team ${this.teamNumber}, IP ${addr.ip}`);
      } else {
        this.phase = 'ready';
        console.log(`RobotTestMonitor: DHCP lease obtained — IP ${addr.ip} (not a team subnet)`);
      }

      this.broadcast();
      this.runChecks();
    } catch (err) {
      console.error('RobotTestMonitor: error reading interface address:', err);
    }
  }

  private killDhcp(): void {
    if (this.dhcpProc) {
      this.dhcpProc.kill();
      this.dhcpProc = null;
    }
    // Also release the lease and kill any orphaned dhcpcd for this interface
    execFile('dhcpcd', ['--release', this.interfaceName]).catch(() => {});
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
