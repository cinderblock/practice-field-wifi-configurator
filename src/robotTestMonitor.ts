import { spawn, execFile as execFileCb, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { RobotTestState, RobotTestPhase, CheckResult, FirmwareUpdateProgress } from './types.js';
import { checkRadio, checkRoboRIO, checkTeamConsistency, checkFactoryDefault } from './teamChecker.js';
import { updateRadioFirmware } from './firmwareUpdater.js';
import type { FirmwareStore } from './firmwareStore.js';
import type { NetworkBackend } from './node-ip/index.js';

const execFile = promisify(execFileCb);

const LINK_POLL_MS = 200;
const CHECK_INTERVAL_MS = 5_000;
/** Secondary IP added to the test interface so we can reach factory-default radios at 192.168.69.1. */
const FACTORY_PROBE_IP = '192.168.69.8';
const FACTORY_PROBE_PREFIX = 24;

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

/** Read the DHCP-assigned IPv4 address on an interface, skipping any static addresses we added. */
async function getInterfaceIp(iface: string, excludeIps: string[] = []): Promise<{ ip: string } | null> {
  try {
    const { stdout } = await execFile('ip', ['-j', 'addr', 'show', 'dev', iface]);
    const data = JSON.parse(stdout);
    if (!data[0]?.addr_info) return null;
    const v4 = data[0].addr_info.find(
      (a: { family: string; local: string }) => a.family === 'inet' && !excludeIps.includes(a.local),
    );
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
  private firmwareUpdating = false;
  /** True if the interface is a VLAN sub-interface (link state mirrors parent, not meaningful). */
  private skipLinkDetection = false;

  constructor(
    private readonly interfaceName: string,
    private readonly net: NetworkBackend,
    private readonly onStateChange: (state: RobotTestState) => void,
    private readonly onFirmwareProgress?: (progress: FirmwareUpdateProgress) => void,
    private readonly firmwareStore?: FirmwareStore,
    private readonly dryRun = false,
  ) {}

  async start(): Promise<void> {
    console.log(`RobotTestMonitor: starting on ${this.interfaceName}`);
    if (!this.dryRun) {
      await this.net.setInterfaceUp(this.interfaceName);
      // Detect if this is a VLAN sub-interface — link state mirrors the parent
      // and is meaningless for detecting whether a robot is plugged in.
      try {
        const interfaces = await this.net.listInterfaces(this.interfaceName);
        const iface = interfaces[0];
        if (iface?.link?.kind === 'vlan' || this.interfaceName.includes('.')) {
          this.skipLinkDetection = true;
          console.log(`RobotTestMonitor: ${this.interfaceName} is a VLAN — skipping link detection`);
        }
      } catch {
        // Fall back to link detection
      }
    }
    if (this.skipLinkDetection) {
      // VLAN interface: treat as always linked, go straight to DHCP
      this.handleLinkUp();
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
    if (this.skipLinkDetection) return; // VLAN: link state is meaningless
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
    // Add secondary IP for factory-default radio detection (192.168.69.1)
    if (!this.dryRun) {
      this.net
        .addAddress({
          interfaceName: this.interfaceName,
          address: FACTORY_PROBE_IP,
          prefixLength: FACTORY_PROBE_PREFIX,
        })
        .catch(() => {}); // May already exist from a previous link cycle
    }
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
    const proc = spawn(
      'dhcpcd',
      ['--oneshot', '--nobackground', '--waitip', '4', '--timeout', '1', this.interfaceName],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.dhcpProc = proc;

    proc.on('error', err => {
      this.dhcpProc = null;
      console.error(`RobotTestMonitor: failed to start dhcpcd: ${err.message}`);
      // Retry after a delay if link is still up
      if (this.linkUp) {
        setTimeout(() => {
          if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
        }, 1000);
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
        // Retry after a short delay if link is still up
        if (this.linkUp) {
          setTimeout(() => {
            if (this.linkUp && this.phase === 'dhcp_requesting') this.startDhcp();
          }, 500);
        }
      }
    });
  }

  private async handleDhcpSuccess(): Promise<void> {
    try {
      // Read the assigned IP directly from the interface
      const addr = await getInterfaceIp(this.interfaceName, [FACTORY_PROBE_IP]);
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
      const [radioResults, rioResults, consistencyResults, factoryResult] = await Promise.all([
        checkRadio(this.teamNumber),
        checkRoboRIO(this.teamNumber),
        checkTeamConsistency(this.teamNumber),
        checkFactoryDefault(),
      ]);
      this.checks = [...consistencyResults, ...factoryResult, ...radioResults, ...rioResults];
      this.phase = 'complete';

      // Trigger background firmware download if the radio needs an update
      if (this.firmwareStore) {
        const fwCheck = radioResults.find(c => c.name === 'Radio Firmware');
        if (fwCheck?.status === 'fail') {
          this.firmwareStore.startBackgroundDownloads();
        }
      }
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

  // ── Firmware update ──────────────────────────────────────────────

  /** Check if the radio's current firmware needs an update. */
  radioNeedsFirmwareUpdate(): boolean {
    const fwCheck = this.checks.find(c => c.name === 'Radio Firmware');
    return fwCheck?.status === 'fail';
  }

  /** Run the full firmware update flow. Throws on failure. */
  async startFirmwareUpdate(
    wpaKey: string | undefined,
    wpaKey24: string | undefined,
    skipReconfigure = false,
  ): Promise<void> {
    if (this.firmwareUpdating) throw new Error('Firmware update already in progress');
    if (!this.teamNumber) throw new Error('No team number detected — plug in a robot first');
    if (!this.linkUp) throw new Error('Link is down — plug in a cable first');
    if (!skipReconfigure && !wpaKey)
      throw new Error('WPA passphrase required for reconfiguration (or check "Skip reconfiguration")');
    if (!this.firmwareStore) throw new Error('Firmware store not configured');

    this.firmwareUpdating = true;
    this.stopChecking();

    const startTime = Date.now();
    const sendProgress = (p: Omit<FirmwareUpdateProgress, 'type' | 'elapsedMs'>) => {
      this.onFirmwareProgress?.({ type: 'firmwareUpdateProgress', elapsedMs: Date.now() - startTime, ...p });
    };

    try {
      await updateRadioFirmware(this.teamNumber, wpaKey, wpaKey24, skipReconfigure, this.firmwareStore, sendProgress);
      // Re-run checks after successful update
      this.runChecks();
    } catch (err) {
      sendProgress({
        step: 'error',
        message: err instanceof Error ? err.message : String(err),
        progress: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.firmwareUpdating = false;
    }
  }

  // ── Broadcast ─────────────────────────────────────────────────────

  private broadcast(): void {
    this.onStateChange(this.getState());
  }
}
