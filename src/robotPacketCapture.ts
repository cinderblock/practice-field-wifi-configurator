import { spawn, type ChildProcess } from 'node:child_process';
import type { StationName, TelemetryUpdate } from './types.js';

/**
 * Passively capture robot→DS UDP packets via tcpdump to extract battery
 * voltage and robot status without taking FMS control of the Driver Station.
 *
 * The robot sends UDP with sport 1150 to the gateway IP on each team's VLAN.
 * We capture these packets, parse the pcap stream, and feed telemetry into
 * the existing broadcast pipeline.
 */
export class RobotPacketCapture {
  private proc: ChildProcess | null = null;
  private buf = Buffer.alloc(0);
  private headerParsed = false;

  constructor(
    private readonly interfaceName: string,
    private readonly getTeamMappings: () => Record<number, StationName>,
    private readonly onTelemetry: (update: TelemetryUpdate) => void,
    private readonly dryRun = false,
  ) {}

  start(): void {
    if (this.dryRun || this.proc) return;

    // Capture on all VLAN sub-interfaces by listening on the parent
    const proc = spawn(
      'tcpdump',
      ['-i', this.interfaceName, '-U', '-w', '-', '--immediate-mode', '-p', 'udp', 'src', 'port', '1150'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    this.proc = proc;
    this.buf = Buffer.alloc(0);
    this.headerParsed = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      // tcpdump prints stats to stderr — ignore those
      if (line && !line.includes('packets captured') && !line.includes('packets received')) {
        console.warn(`RobotPacketCapture: ${line}`);
      }
    });

    proc.on('error', err => {
      console.error(`RobotPacketCapture: failed to start tcpdump: ${err.message}`);
      this.proc = null;
    });

    proc.on('exit', (code, signal) => {
      this.proc = null;
      if (signal !== 'SIGTERM' && signal !== 'SIGKILL') {
        console.warn(`RobotPacketCapture: tcpdump exited (code=${code}, signal=${signal})`);
        // Restart after a delay
        setTimeout(() => this.start(), 5000);
      }
    });

    console.log(`RobotPacketCapture: listening on ${this.interfaceName}`);
  }

  stop(): void {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }

  /** Process buffered pcap data. */
  private drain(): void {
    // Parse global header (24 bytes) once
    if (!this.headerParsed) {
      if (this.buf.length < 24) return;
      const magic = this.buf.readUInt32LE(0);
      if (magic !== 0xa1b2c3d4 && magic !== 0xa1b2cd34) {
        console.error('RobotPacketCapture: invalid pcap magic:', magic.toString(16));
        this.stop();
        return;
      }
      this.buf = this.buf.subarray(24);
      this.headerParsed = true;
    }

    // Read packet records
    while (this.buf.length >= 16) {
      // Pcap record header: ts_sec(4) ts_usec(4) incl_len(4) orig_len(4)
      const inclLen = this.buf.readUInt32LE(8);
      const totalLen = 16 + inclLen;
      if (this.buf.length < totalLen) break;

      const packetData = this.buf.subarray(16, totalLen);
      this.buf = this.buf.subarray(totalLen);

      this.parsePacket(packetData);
    }
  }

  /** Parse a single captured packet (Ethernet + IP + UDP + payload). */
  private parsePacket(data: Buffer): void {
    // Ethernet header: 14 bytes (dst[6] + src[6] + etherType[2])
    if (data.length < 14) return;
    const etherType = data.readUInt16BE(12);
    if (etherType !== 0x0800) return; // Not IPv4

    // IP header starts at offset 14
    const ipOffset = 14;
    if (data.length < ipOffset + 20) return;
    const ipHeaderLen = (data[ipOffset] & 0x0f) * 4;
    if (data.length < ipOffset + ipHeaderLen + 8) return; // Need at least UDP header

    // Extract source IP (bytes 12-15 of IP header)
    const srcIp = `${data[ipOffset + 12]}.${data[ipOffset + 13]}.${data[ipOffset + 14]}.${data[ipOffset + 15]}`;

    // UDP payload starts after IP header + 8 bytes UDP header
    const payloadOffset = ipOffset + ipHeaderLen + 8;
    if (data.length < payloadOffset + 6) return; // Need at least 6 bytes of robot payload

    // Robot→DS payload format:
    // Bytes 0-1: Sequence number
    // Byte 2: Comm version
    // Byte 3: Status (brownout:7, watchdog:6, ds.teleOp:5, ds.auto:4, ds.disable:3, robot.teleOp:2, robot.auto:1, robot.disable:0)
    // Byte 4: Battery voltage integer part
    // Byte 5: Battery voltage fractional part (÷256)
    const statusByte = data[payloadOffset + 3];
    const batteryVoltage = data[payloadOffset + 4] + data[payloadOffset + 5] / 256;

    // Extract team number from source IP (10.TE.AM.x)
    const team = teamFromIp(srcIp);
    if (!team) return;

    const now = Date.now();

    // Resolve team to station
    const mappings = this.getTeamMappings();
    const station = mappings[team];
    if (!station) return;

    // Status byte bits (robot→DS):
    //   7: brownout, 6: watchdog
    //   5: ds.teleOp, 4: ds.auto, 3: ds.disable
    //   2: robot.teleOp, 1: robot.auto, 0: robot.disable
    const brownout = Boolean(statusByte & 0x80);
    const robotDisable = Boolean(statusByte & 0x01);
    const robotAuto = Boolean(statusByte & 0x02);

    const update: TelemetryUpdate = {
      type: 'telemetry',
      station,
      timestamp: now,
      batteryVoltage,
      brownout,
      dsStatus: {
        eStop: false, // Not available in robot→DS packet
        robotComms: true, // If we're seeing packets, robot comms are up
        radioPing: true,
        rioPing: true,
        enabled: !robotDisable,
        mode: robotAuto ? 'auto' : 'teleOp',
      },
    };

    this.onTelemetry(update);
  }
}

/** Parse team number from 10.TE.AM.x IP. */
function teamFromIp(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts[0] !== '10') return null;
  const high = parseInt(parts[1], 10);
  const low = parseInt(parts[2], 10);
  if (isNaN(high) || isNaN(low)) return null;
  const team = high * 100 + low;
  return team > 0 && team <= 25599 ? team : null;
}
