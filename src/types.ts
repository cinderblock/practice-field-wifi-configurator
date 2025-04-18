export interface StationDetails {
  ssid: string;
  hashedWpaKey: string;
  wpaKeySalt: string;
  isLinked: boolean;
  macAddress: MacAddress | '';
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
  connectionQuality: ConnectionQuality | '';
}

export type RadioChannel =
  | 5
  | 13
  | 21
  | 29
  | 37
  | 45
  | 53
  | 61
  | 69
  | 77
  | 85
  | 93
  | 101
  | 109
  | 117
  | 125
  | 133
  | 141
  | 149
  | 157
  | 165
  | 173
  | 181
  | 189
  | 197
  | 205
  | 213
  | 221
  | 229;
export type Alliance = 'red' | 'blue';
export type StationNumber = 1 | 2 | 3;
export type StationName = `${Alliance}${StationNumber}`;
export const StationNameList = ['red1', 'red2', 'red3', 'blue1', 'blue2', 'blue3'] as const;
export const StationNameRegex = /^(red|blue)[123]$/;
export type Status = 'BOOTING' | 'CONFIGURING' | 'ACTIVE' | 'ERROR';
export type VLAN = '10_20_30' | '40_50_60' | '70_80_90';
export type ConnectionQuality = 'excellent' | 'good' | 'caution' | 'warning';

export function isConnectionQuality(quality: unknown): quality is ConnectionQuality {
  if (typeof quality !== 'string') return false;
  return ['excellent', 'good', 'caution', 'warning'].includes(quality);
}

type HexDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
type HexByte = `${HexDigit}${HexDigit}`;
export type MacAddress = string; // `${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}:${HexByte}`;
export function isMacAddress(mac: unknown): mac is MacAddress {
  if (typeof mac !== 'string') return false;
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(mac);
}

export function isVLAN(vlan: unknown): vlan is VLAN {
  if (typeof vlan !== 'string') return false;
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

  if (!ssid) return false;
  if (!hashedWpaKey) return false;
  if (!wpaKeySalt) return false;

  if (macAddress !== '' && !isMacAddress(macAddress)) return false;

  if (connectionQuality !== '' && !isConnectionQuality(connectionQuality)) return false;

  return true;
}

export function isValidRadioUpdate(update: unknown): update is RadioUpdate {
  if (typeof update !== 'object') return false;
  if (!update) return false;

  const { channel, channelBandwidth, redVlans, blueVlans, status, stationStatuses, syslogIpAddress, version } =
    update as RadioUpdate;

  if (!isStatus(status)) return false;

  if (status !== 'BOOTING') {
    if (!isRadioChannel(channel)) return false;
    if (!isChannelBandwidth(channelBandwidth)) return false;
    if (!isSyslogIpAddress(syslogIpAddress)) return false;

    // if (redVlans === blueVlans) return false;
  }

  if (!isVLAN(redVlans)) return false;
  if (!isVLAN(blueVlans)) return false;
  if (!isStationStatuses(stationStatuses)) return false;
  if (!isVersion(version)) return false;

  return true;
}

function isRadioChannel(channel: unknown): channel is RadioChannel {
  return [
    // TODO: DRY
    5, 13, 21, 29, 37, 45, 53, 61, 69, 77, 85, 93, 101, 109, 117, 125, 133, 141, 149, 157, 165, 173, 181, 189, 197, 205,
    213, 221, 229,
  ].includes(channel as number);
}

function isChannelBandwidth(bandwidth: unknown): bandwidth is `${number}MHz` {
  if (typeof bandwidth !== 'string') return false;
  return /^[1-9][0-9]*MHz$/.test(bandwidth);
}

function isStatus(status: unknown): status is Status {
  return ['BOOTING', 'CONFIGURING', 'ACTIVE', 'ERROR'].includes(status as string);
}

function arrayCompare<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isStationStatuses(stationStatuses: unknown): stationStatuses is Record<StationName, StationDetails | null> {
  if (typeof stationStatuses !== 'object') return false;
  if (!stationStatuses) return false;

  if (!arrayCompare(Object.keys(stationStatuses).sort(), [...StationNameList].sort())) return false;

  const statuses = stationStatuses as Record<string, StationDetails | null>;

  for (const stationId in statuses) {
    const station = statuses[stationId];
    if (station === null) continue;
    if (!isStationDetails(station)) {
      // console.log(`bad station ${stationId}`);
      // console.log(station);
      return false;
    }
  }

  return true;
}

function isSyslogIpAddress(syslogIpAddress: unknown): syslogIpAddress is string {
  if (typeof syslogIpAddress !== 'string') return false;
  return isIpAddress(syslogIpAddress);
}

function isIpAddress(ipAddress: string): ipAddress is string {
  if (typeof ipAddress !== 'string') return false;
  return /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$/.test(ipAddress);
}

function isVersion(version: unknown): version is string {
  if (typeof version !== 'string') return false;
  return true;
}

export interface RadioUpdate {
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
  radioUpdate?: RadioUpdate;
}

export type SmallChannels =
  | 1
  | 9
  | 17
  | 25
  | 33
  | 41
  | 49
  | 57
  | 65
  | 73
  | 81
  | 89
  | 97
  | 105
  | 113
  | 121
  | 129
  | 137
  | 145
  | 153
  | 161
  | 169
  | 177
  | 185
  | 193
  | 201
  | 209
  | 217
  | 225
  | 233;

export type AllChannels = RadioChannel | SmallChannels;

export type ScanResults = LoadingScanResults | ReadyScanResults;

export interface LoadingScanResults {
  progressDots: number; // Number of dots received so far
}

export interface ReadyScanResults {
  channels: ChannelScanDetails[];
  additionalStatistics: AdditionalChannelStatistic[];
}

export type ChannelScanDetails = {
  channel: AllChannels; // Channel number
  channelFrequency: number; // Channel frequency in MHz
  bss: number; // Number of BSS
  minRssi: number; // Minimum RSSI
  maxRssi: number; // Maximum RSSI
  nf: number; // Noise Floor. Run-time average NF_dBr
  channelLoad: number; // Channel Load
  spectralLoad: number; // Spectral Load
  secondaryChannel: number; // Secondary Channel
  spatialReuseBss: number; // Spatial Reuse BSS
  spatialReuseLoad: number; // Spatial Reuse Load
  channelAvailability: number; // Channel Availability
  channelEfficiency: number; // Channel Efficiency
  nearBss: number; // Near BSS
  mediumBss: number; // Medium BSS
  farBss: number; // Far BSS
  effectiveBss: number; // Effective BSS
  grade: number; // Grade
  rank: number; // Rank
  unused: string[]; // "Unused" field
  radar: number; // Radar detection
};

export type AdditionalChannelStatistic = {
  index: number; // Index of the statistic
  channel: AllChannels; // Channel number
  nbss: number; // Number of BSS
  ssid: string; // SSID
  bssid: string; // BSSID
  rssi: number; // RSSI
  phyMode: number; // PHY Mode
};

export function isLoadingScanResults(results: ScanResults): results is LoadingScanResults {
  return 'progressDots' in results;
}

export function isReadyScanResults(results: ScanResults): results is ReadyScanResults {
  return !('progressDots' in results);
}

export function isStationUpdate(update: unknown): update is StationUpdate {
  if (typeof update !== 'object') return false;
  if (!update) return false;

  const { type, station, ssid, wpaKey } = update as StationUpdate;

  if (type !== 'station') return false;
  if (!StationNameRegex.test(station)) return false;
  if (typeof ssid !== 'string') return false;
  if (typeof wpaKey !== 'string') return false;

  return true;
}

export type StationUpdate = {
  type: 'station';
  station: StationName;
  ssid: string;
  wpaKey: string;
};
