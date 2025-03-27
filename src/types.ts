export interface StationDetails {
  ssid: string;
  hashedWpaKey: string;
  wpaKeySalt: string;
  isLinked: boolean;
  macAddress: MacAddress;
  dataAgeMs: number;
  signalDbm: number;
  noiseDbm: number;
  signalNoiseRatio: number;
  rxRateMbps: number;
  rxPackets: number;
  rxBytes: number;
  txRateMbps: number;
  txPackets: number;
  txBytes: number;
  bandwidthUsedMbps: number;
  connectionQuality: ConnectionQuality;
}

export type Side = 'red' | 'blue';
export type StationNumber = 1 | 2 | 3;
export type StationName = `${Side}${StationNumber}`;
export const StationNameRegex = /^(red|blue)[123]$/;
export type Status = string; // 'BOOTING' | 'ACTIVE' | 'CONFIGURING';
export type VLAN = '10_20_30' | '40_50_60' | '70_80_90';
export type ConnectionQuality = string; // 'warning' | ...;

type HexDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
type HexByte = `${HexDigit}${HexDigit}`;
export type MacAddress = `${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}`;
export function isMacAddress(mac: string): mac is MacAddress {
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac);
}

export function isVLAN(vlan: string): vlan is VLAN {
  return ['10_20_30', '40_50_60', '70_80_90'].includes(vlan);
}

export function isStationDetails(details: unknown): details is StationDetails {
  if (!details) return false;
  if (typeof details !== 'object') return false;

  const {
    ssid,
    hashedWpaKey,
    wpaKeySalt,
    isLinked,
    macAddress,
    dataAgeMs,
    signalDbm,
    noiseDbm,
    signalNoiseRatio,
    rxRateMbps,
    rxPackets,
    rxBytes,
    txRateMbps,
    txPackets,
    txBytes,
    bandwidthUsedMbps,
    connectionQuality,
  } = details as StationDetails;

  if (typeof ssid !== 'string') return false;
  if (typeof hashedWpaKey !== 'string') return false;
  if (typeof wpaKeySalt !== 'string') return false;
  if (typeof isLinked !== 'boolean') return false;
  if (typeof macAddress !== 'string') return false;
  if (typeof dataAgeMs !== 'number') return false;
  if (typeof signalDbm !== 'number') return false;
  if (typeof noiseDbm !== 'number') return false;
  if (typeof signalNoiseRatio !== 'number') return false;
  if (typeof rxRateMbps !== 'number') return false;
  if (typeof rxPackets !== 'number') return false;
  if (typeof rxBytes !== 'number') return false;
  if (typeof txRateMbps !== 'number') return false;
  if (typeof txPackets !== 'number') return false;
  if (typeof txBytes !== 'number') return false;
  if (typeof bandwidthUsedMbps !== 'number') return false;
  if (typeof connectionQuality !== 'string') return false;

  if (!ssid) return false;
  if (!hashedWpaKey) return false;
  if (!wpaKeySalt) return false;

  if (!isMacAddress(macAddress)) return false;

  if (!isVLAN(connectionQuality)) return false;

  return true;
}

export interface RadioStatus {
  channel: number;
  channelBandwidth: `${number}MHz`;
  redVlans: VLAN;
  blueVlans: VLAN;
  status: Status;
  stationStatuses: {
    red1: StationDetails | null;
    red2: StationDetails | null;
    red3: StationDetails | null;
    blue1: StationDetails | null;
    blue2: StationDetails | null;
    blue3: StationDetails | null;
  };
  syslogIpAddress: string;
  version: string;
}
export interface StatusEntry {
  timestamp: number;
  radioStatus: RadioStatus;
}
