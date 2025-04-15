import net from 'net';
import dgram, { Socket } from 'dgram';
import { EventEmitter } from 'events';
import { Transform, TransformCallback } from 'stream';
import { BufferOverflowError, BufferReader, BufferWriter } from './BufferWrappers';
import { StationName } from './types';

const DefaultTcpPort = 1750;
const DefaultUdpPort = 1160;
const UdpSendPort = 1121; // 1120 to assert control over DS

const DefaultAddress = '10.0.100.5';

type TeamNumberMessage = {
  type: 0x18;
  teamNumber: number;
};

type WPILibVersionMessage = {
  type: 0x00;
  version: string;
};

type RIOVersionMessage = {
  type: 0x01;
  version: string;
};

type DSVersionMessage = {
  type: 0x02;
  version: string;
};

type PDPVersionMessage = {
  type: 0x03;
  version: string;
};

type PCMVersionMessage = {
  type: 0x04;
  version: string;
};

type CANJagVersionMessage = {
  type: 0x05;
  version: string;
};

type CANTalonVersionMessage = {
  type: 0x06;
  version: string;
};

type ThirdPartyDeviceVersionMessage = {
  type: 0x07;
  version: string;
};

type UsageReportMessage = {
  type: 0x15;
  teamNumber: number;
  unknown: number;
  entries: Buffer; // TODO: Parse this into a more meaningful structure
};

type CommonFlags = {
  teleOp: boolean;
  auto: boolean;
  disable: boolean;
};

type Status = {
  brownout: boolean;
  watchdog: boolean;
  ds: CommonFlags;
  robot: CommonFlags;
};

type LogDataMessage = {
  type: 0x16;
  roundTripTime: number;
  lostPackets: number;
  voltage: number;
  status: Status;
  CAN: number;
  SignalDb: number;
  bandwidth: number;
};

type ErrorAndEventDataMessage = {
  type: 0x17;
  messageCount: number;
  timestamp: number;
  unknown: Buffer;
  message: string;
};

type ChallengeResponseMessage = {
  type: 0x1b;
  response: string;
};

type DSPingMessage = {
  type: 0x1c;
};

type DSMessage =
  | TeamNumberMessage
  | WPILibVersionMessage
  | RIOVersionMessage
  | DSVersionMessage
  | PDPVersionMessage
  | PCMVersionMessage
  | CANJagVersionMessage
  | CANTalonVersionMessage
  | ThirdPartyDeviceVersionMessage
  | UsageReportMessage
  | LogDataMessage
  | ErrorAndEventDataMessage
  | ChallengeResponseMessage
  | DSPingMessage;

function byteToStatus(byte: number): Status {
  return {
    brownout: Boolean(byte & 0x80),
    watchdog: Boolean(byte & 0x40),
    ds: {
      teleOp: Boolean(byte & 0x20),
      auto: Boolean(byte & 0x10),
      disable: Boolean(byte & 0x08),
    },
    robot: {
      teleOp: Boolean(byte & 0x04),
      auto: Boolean(byte & 0x02),
      disable: Boolean(byte & 0x01),
    },
  };
}

function parseIncomingTcpMessage(data: Buffer): DSMessage | null {
  const r = new BufferReader(data);

  const type = r.readNumber(1);

  switch (type) {
    case 0x00:
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04:
    case 0x05:
    case 0x06:
    case 0x07:
      console.log('Version:', type, data.toString('hex'));
      // TODO: implement
      return null;
    case 0x15:
      return { type, teamNumber: r.readNumber(2), unknown: r.readNumber(1), entries: r.readSlice() };
    case 0x16:
      return {
        type,
        roundTripTime: r.readNumber(1),
        lostPackets: r.readNumber(1),
        voltage: r.readNumber(2) / 256,
        status: byteToStatus(r.readNumber(1)),
        CAN: r.readNumber(1) * 2,
        SignalDb: r.readNumber(1) * 2,
        bandwidth: r.readNumber(2) / 256,
      };
    case 0x17:
      return {
        type,
        messageCount: r.readNumber(4),
        timestamp: r.readNumber(8),
        unknown: r.readSlice(8),
        message: r.readString(),
      };
    case 0x18:
      return { type, teamNumber: r.readNumber(2) };
    case 0x1b:
      return { type, response: r.readString() };
    case 0x1c:
      return { type };
    default:
      throw new Error(`Unknown message type ${type}`);
  }
}

class ByteToObjectTransform extends Transform {
  constructor() {
    super({ readableObjectMode: true });
  }

  private unprocessed: Buffer[] = [];

  _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback) {
    this.unprocessed.push(chunk);

    // Combine all chunks into a single buffer
    let buff = new BufferReader(Buffer.concat(this.unprocessed));

    try {
      while (buff.remaining >= 2) {
        const data = buff.readSizedBuffer(2);

        this.push(parseIncomingTcpMessage(data));
      }
    } catch (err) {
      if (err instanceof BufferOverflowError) return;
      console.error('Error parsing TCP message:', err);
    } finally {
      this.unprocessed = [buff.readSlice()];
      callback();
    }
  }
}

type FieldRadioMetrics = {
  type: 'field';
  signalStrength: number;
  bandwidthUtilization: number;
};
type CommsMetrics = {
  lostPackets: number;
  sentPackets: number;
  averageRoundTripTime: number;
};
type LaptopMetrics = {
  batteryPercent: number;
  cpuPercent: number;
};
type RobotRadioMetrics = {
  type: 'robot';
  signalStrength: number;
  bandwidthUtilization: number;
};
type PDInfo = {
  type: 'pd';
};

type Metrics = FieldRadioMetrics | CommsMetrics | LaptopMetrics | RobotRadioMetrics | PDInfo;

type Tags = Metrics[];

type Mode = 'teleOp' | 'test' | 'auto';

type DsStatus = {
  EStop: boolean;
  robotComms: boolean;
  radioPing: boolean;
  rioPing: boolean;
  enabled: boolean;
  mode: Mode;
};

function byteToDsStatus(byte: number): DsStatus {
  const modeN = byte & 0x03;

  return {
    EStop: Boolean(byte & 0x80),
    robotComms: Boolean(byte & 0x20),
    radioPing: Boolean(byte & 0x10),
    rioPing: Boolean(byte & 0x08),
    enabled: Boolean(byte & 0x04),
    mode: ['teleOp', 'test', 'auto'][modeN] as Mode,
  };
}

type UdpMessage = {
  sequence: number;
  commVersion: number;
  status: DsStatus;
  teamNumber: number;
  BatteryVoltage: number;
  tags: Tags;
};

function parseIncomingUdpMessage(buff: Buffer): UdpMessage {
  const r = new BufferReader(buff);
  const sequence = r.readNumber(2);
  const commVersion = r.readNumber(1);
  const status = byteToDsStatus(r.readNumber(1));
  const teamNumber = r.readNumber(2);
  const BatteryVoltage = r.readNumber(2) / 256;
  const tags: Tags = [];

  while (r.remaining > 0) {
    const size = r.readNumber(1);
    if (size === 0) throw new Error('Size is 0');

    const tagBuff = r.readSlice(size);

    const t = new BufferReader(tagBuff);

    const tagType = t.readNumber(1);

    switch (tagType) {
      case 0x00:
        tags.push({ type: 'field', signalStrength: t.readNumber(1), bandwidthUtilization: t.readNumber(2) });
        break;
      case 0x01:
        tags.push({
          lostPackets: t.readNumber(2),
          sentPackets: t.readNumber(2),
          averageRoundTripTime: t.readNumber(1),
        });
        break;
      case 0x02:
        tags.push({ batteryPercent: t.readNumber(1), cpuPercent: t.readNumber(1) });
        break;
      case 0x03:
        tags.push({ type: 'robot', signalStrength: t.readNumber(1), bandwidthUtilization: t.readNumber(2) });
        break;
      case 0x04:
        tags.push({ type: 'pd' });
        break;
      default:
        console.log('Unknown tag type:', tagType, buff.toString('hex'));
    }

    if (t.remaining) console.log('Remaining bytes in tag:', t.remaining, buff.toString('hex'));
  }

  return {
    sequence,
    commVersion,
    status,
    teamNumber,
    BatteryVoltage,
    tags,
  };
}

type Events = {
  message: [{ address: string; port: number; data: DSMessage | UdpMessage }];
};

export async function startFMSServer({
  address = DefaultAddress,
  tcp = DefaultTcpPort,
  udp = DefaultUdpPort,
}: { address?: string; tcp?: number; udp?: number } = {}) {
  return new Promise<EventEmitter<Events>>((resolve, reject) => {
    let udpServer: Socket;

    const tcpServer = net.createServer(socket => {
      console.log(`DS connected: ${socket.remoteAddress}`);

      const transformer = new ByteToObjectTransform();
      socket.pipe(transformer).on('data', obj => {
        console.log('Received object from TCP stream:', obj);
        emitter.emit('message', { address: socket.remoteAddress || '', port: tcp, data: obj });
      });

      socket.on('close', () => {
        console.log(`DS disconnected: ${socket.remoteAddress}`);
      });

      socket.on('error', err => {
        console.error(`Error with ${socket.remoteAddress}:`, err);
      });
    });

    function error(err: any) {
      tcpServer.close();
      udpServer?.close();
      reject(err);
    }

    const emitter = new EventEmitter<Events>();

    tcpServer.on('error', error);

    tcpServer.listen(tcp, address, () => {
      console.log(`FMS server listening on TCP ${address}:${tcp}`);
      udpServer = dgram.createSocket('udp4');

      udpServer.on('message', (msg, rinfo) => {
        console.log(`UDP message from ${rinfo.address}:${rinfo.port}:`, msg.toString());

        const message = parseIncomingUdpMessage(msg);

        emitter.emit('message', { address: rinfo.address, port: udp, data: message });
      });

      udpServer.on('error', error);

      udpServer.bind(DefaultUdpPort, DefaultAddress, () => {
        console.log(`UDP server listening on port ${DefaultUdpPort}`);

        tcpServer.removeListener('error', error);
        tcpServer.on('error', err => {
          console.error('TCP server error:', err);
          error(err);
        });
        resolve(emitter);
      });
    });
  });
}

export async function runFMS() {
  return startFMSServer().catch(err => {
    if ('code' in err && 'address' in err && err.code === 'EADDRNOTAVAIL') {
      console.log(`Bind to ${err.address} to enable FMS server`);
      return;
    }
    console.log('Failed to start FMS server:');
    console.log(err);
  });
}

class Control {
  constructor(public eStop: boolean, public enabled: boolean, public mode: Mode) {}
  get bits() {
    return (this.eStop ? 0x80 : 0) | (this.enabled ? 0x04 : 0) | ['teleOp', 'test', 'auto'].indexOf(this.mode);
  }
}

type TournamentLevel = 'Match Test' | 'Practice' | 'Qualification' | 'Playoff';

type DsPacket = {
  sequence: number;
  control: Control;
  allianceStation: StationName;
  tournamentLevel: TournamentLevel;
  matchNumber: number;
  playNumber: number;
  matchTime: Date;
  remainingTime: number;
  tags: Tags;
};

function allianceStationFromName(station: StationName): number {
  return ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'].indexOf(station);
}

function tournamentLevelToByte(level: TournamentLevel): number {
  return ['Match Test', 'Practice', 'Qualification', 'Playoff'].indexOf(level);
}

function dateToBuffer(date: Date): Buffer {
  const buff = new BufferWriter(Buffer.allocUnsafe(10));
  buff.writeNumber(4, date.getMilliseconds() * 1000);
  buff.writeNumber(1, date.getSeconds());
  buff.writeNumber(1, date.getMinutes());
  buff.writeNumber(1, date.getHours());
  buff.writeNumber(1, date.getDate());
  buff.writeNumber(1, date.getMonth());
  buff.writeNumber(1, date.getFullYear() - 1900);
  return buff.buffer;
}

function makeTagsBuffers(tags: Tags): Buffer[] {
  // TODO: implement
  return [];
}

export function makeDSPacket(data: DsPacket): Buffer {
  const main = new BufferWriter(Buffer.allocUnsafe(22));

  const CommVersion = 0x00;
  const Request = 0x00;

  main.writeNumber(2, data.sequence);
  main.writeNumber(1, CommVersion);
  main.writeNumber(1, data.control.bits);
  main.writeNumber(1, Request);
  main.writeNumber(1, allianceStationFromName(data.allianceStation));
  main.writeNumber(1, tournamentLevelToByte(data.tournamentLevel));
  main.writeNumber(2, data.matchNumber);
  main.writeNumber(1, data.playNumber);
  main.writeBuffer(dateToBuffer(data.matchTime));
  main.writeNumber(2, data.remainingTime);

  if (main.remaining) throw new Error(`Main buffer has ${main.remaining} bytes remaining`);

  return Buffer.concat([main.buffer, ...makeTagsBuffers(data.tags)]);
}
