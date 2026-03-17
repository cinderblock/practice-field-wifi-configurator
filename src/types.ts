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

  const { type, station, ssid, wpaKey, stage } = update as StationUpdate;

  if (type !== 'station') return false;
  if (!StationNameRegex.test(station)) return false;
  if (typeof ssid !== 'string') return false;
  if (typeof wpaKey !== 'string') return false;
  if (typeof stage !== 'undefined' && typeof stage !== 'boolean') return false;

  return true;
}

export type StationUpdate = {
  type: 'station';
  station: StationName;
  ssid: string;
  wpaKey: string;
  stage?: boolean;
  internetAccess?: boolean;
};

export type InternetToggle = {
  type: 'internetToggle';
  station: StationName;
  enabled: boolean;
};

export function isInternetToggle(msg: unknown): msg is InternetToggle {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;

  const { type, station, enabled } = msg as InternetToggle;

  if (type !== 'internetToggle') return false;
  if (!StationNameRegex.test(station)) return false;
  if (typeof enabled !== 'boolean') return false;

  return true;
}

// ── Admin / Match Engine Types ──────────────────────────────────────

export type Mode = 'teleOp' | 'test' | 'auto';

export type MatchPhase = 'idle' | 'countdown' | 'auto' | 'autoPause' | 'paused' | 'teleop' | 'endgame' | 'postMatch';

export type MatchConfig = {
  autoDuration: number;
  teleopDuration: number;
  endgameDuration: number;
  pauseDuration: number;
};

export type StationControlState = {
  teamNumber: number | null;
  enabled: boolean;
  eStop: boolean;
  mode: Mode;
  joined: boolean;
  ready: boolean;
};

export type MatchEndReason = 'normal' | 'stopped' | 'estop' | 'abandoned';

export type DSConnectionInfo = {
  ip: string;
  /** Server timestamp (Date.now()) of the last packet received from this DS */
  lastSeen: number;
  /** If set, these DS IPs are trying to connect and are being blocked */
  blockedDsIps?: string[];
};

export type MatchState = {
  type: 'matchState';
  phase: MatchPhase;
  remainingTime: number;
  totalMatchTime: number;
  config: MatchConfig;
  stationStates: Partial<Record<StationName, StationControlState>>;
  /** Map of station → DS connection info for stations with a connected Driver Station */
  connectedStations: Partial<Record<StationName, DSConnectionInfo>>;
  endReason?: MatchEndReason;
};

export function isMatchState(msg: unknown): msg is MatchState {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as MatchState).type === 'matchState';
}

// ── Station-driven match messages ────────────────────────────────────

export type StationJoin = { type: 'stationJoin'; station: StationName };
export function isStationJoin(msg: unknown): msg is StationJoin {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationJoin;
  return m.type === 'stationJoin' && StationNameRegex.test(m.station);
}

export type StationLeave = { type: 'stationLeave'; station: StationName };
export function isStationLeave(msg: unknown): msg is StationLeave {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationLeave;
  return m.type === 'stationLeave' && StationNameRegex.test(m.station);
}

export type StationReady = { type: 'stationReady'; station: StationName; ready: boolean };
export function isStationReady(msg: unknown): msg is StationReady {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as StationReady;
  return m.type === 'stationReady' && StationNameRegex.test(m.station) && typeof m.ready === 'boolean';
}

export type StationStartMatch = { type: 'stationStartMatch' };
export function isStationStartMatch(msg: unknown): msg is StationStartMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationStartMatch).type === 'stationStartMatch';
}

export type StationPauseMatch = { type: 'stationPauseMatch' };
export function isStationPauseMatch(msg: unknown): msg is StationPauseMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationPauseMatch).type === 'stationPauseMatch';
}

export type StationResumeMatch = { type: 'stationResumeMatch' };
export function isStationResumeMatch(msg: unknown): msg is StationResumeMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationResumeMatch).type === 'stationResumeMatch';
}

export type StationAbandonMatch = { type: 'stationAbandonMatch' };
export function isStationAbandonMatch(msg: unknown): msg is StationAbandonMatch {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as StationAbandonMatch).type === 'stationAbandonMatch';
}

export type UpdateMatchConfig = { type: 'updateMatchConfig'; config: MatchConfig };
export function isUpdateMatchConfig(msg: unknown): msg is UpdateMatchConfig {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as UpdateMatchConfig;
  if (m.type !== 'updateMatchConfig') return false;
  if (!m.config || typeof m.config !== 'object') return false;
  if (typeof m.config.autoDuration !== 'number') return false;
  if (typeof m.config.teleopDuration !== 'number') return false;
  if (typeof m.config.endgameDuration !== 'number') return false;
  if (typeof m.config.pauseDuration !== 'number') return false;
  return true;
}

// ── Admin match messages ─────────────────────────────────────────────

export type AdminStopMatch = { type: 'adminStopMatch' };

export function isAdminStopMatch(msg: unknown): msg is AdminStopMatch {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AdminStopMatch).type === 'adminStopMatch';
}

export type AdminGlobalEStop = { type: 'adminGlobalEStop' };

export function isAdminGlobalEStop(msg: unknown): msg is AdminGlobalEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AdminGlobalEStop).type === 'adminGlobalEStop';
}

export type AdminStationEStop = { type: 'adminStationEStop'; station: StationName };

export function isAdminStationEStop(msg: unknown): msg is AdminStationEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminStationEStop;
  if (m.type !== 'adminStationEStop') return false;
  if (!StationNameRegex.test(m.station)) return false;
  return true;
}

export type AdminStationDisable = { type: 'adminStationDisable'; station: StationName };

export function isAdminStationDisable(msg: unknown): msg is AdminStationDisable {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminStationDisable;
  if (m.type !== 'adminStationDisable') return false;
  if (!StationNameRegex.test(m.station)) return false;
  return true;
}

export type AdminClearEStop = { type: 'adminClearEStop'; station?: StationName };

export function isAdminClearEStop(msg: unknown): msg is AdminClearEStop {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  const m = msg as AdminClearEStop;
  if (m.type !== 'adminClearEStop') return false;
  if (m.station !== undefined && !StationNameRegex.test(m.station)) return false;
  return true;
}

// ── Robot Telemetry ─────────────────────────────────────────────────

export interface TelemetryUpdate {
  type: 'telemetry';
  station: StationName;
  timestamp: number;
  batteryVoltage: number;
  rttMs?: number;
  lostPackets?: number;
  canUtil?: number;
  dsCpuPercent?: number;
  brownout?: boolean;
  dsStatus?: {
    eStop: boolean;
    robotComms: boolean;
    radioPing: boolean;
    rioPing: boolean;
    enabled: boolean;
    mode: 'teleOp' | 'test' | 'auto';
  };
}

export function isTelemetryUpdate(msg: unknown): msg is TelemetryUpdate {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as TelemetryUpdate).type === 'telemetry';
}

// ── Network Stats ───────────────────────────────────────────────────

export interface StationNetworkStats {
  rxPackets: number; // packets from robot VLAN (FORWARD in)
  rxBytes: number;
  txPackets: number; // packets to robot VLAN (FORWARD out)
  txBytes: number;
}

export interface NetworkStats {
  type: 'networkStats';
  stations: Partial<Record<StationName, StationNetworkStats>>;
}

export function isNetworkStats(msg: unknown): msg is NetworkStats {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as NetworkStats).type === 'networkStats';
}

// ── Subnet Scan ─────────────────────────────────────────────────────

export interface DiscoveredHost {
  ip: string;
  alive: boolean;
  firstSeen: number;
  lastSeen: number;
  /** Start of the current consecutive-alive streak (reset when host goes down) */
  onlineSince: number;
}

export interface StationSubnetScan {
  team: number;
  subnet: string;
  hosts: DiscoveredHost[];
  lastScanTime: number;
}

export interface SubnetScanResults {
  type: 'subnetScan';
  stations: Partial<Record<StationName, StationSubnetScan>>;
}

export function isSubnetScanResults(msg: unknown): msg is SubnetScanResults {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as SubnetScanResults).type === 'subnetScan';
}

// ── App Log Messages ────────────────────────────────────────────────

export type LogLevel = 'info' | 'warn' | 'error';

export interface AppLogMessage {
  type: 'appLog';
  timestamp: number;
  level: LogLevel;
  message: string;
}

export function isAppLogMessage(msg: unknown): msg is AppLogMessage {
  if (typeof msg !== 'object') return false;
  if (!msg) return false;
  return (msg as AppLogMessage).type === 'appLog';
}

// ── Route Preferences ───────────────────────────────────────────────

/** Sent from client to server to set or clear a routing preference */
export type RoutePreferenceMsg = {
  type: 'routePreference';
  /** Which station to route to, or null to clear the preference */
  station: StationName | null;
};

export function isRoutePreferenceMsg(msg: unknown): msg is RoutePreferenceMsg {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RoutePreferenceMsg;
  if (m.type !== 'routePreference') return false;
  if (m.station !== null && !StationNameRegex.test(m.station)) return false;
  return true;
}

/** Sent from server to client with their routing preference state */
export type RoutePreferenceState = {
  type: 'routePreferenceState';
  /** The IP address of the connected client */
  yourIp: string;
  /** The currently active routing preference, or null if none */
  preference: StationName | null;
  /**
   * Teams that are assigned to more than one station simultaneously.
   * Keys are team numbers (as strings), values are the stations they appear on.
   * Only teams with 2+ stations are included.
   */
  conflictingTeams: Record<string, StationName[]>;
};

export function isRoutePreferenceState(msg: unknown): msg is RoutePreferenceState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RoutePreferenceState).type === 'routePreferenceState';
}

// ── Pending Commit Types ────────────────────────────────────────────

/** Sent from server to client when pending commit state changes */
export type PendingCommitState = {
  type: 'pendingCommitState';
  pending: boolean;
};

export function isPendingCommitState(msg: unknown): msg is PendingCommitState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as PendingCommitState).type === 'pendingCommitState';
}

/** Sent from client to server to trigger a commit of pending changes */
export type ApplyConfigMsg = {
  type: 'applyConfig';
};

export function isApplyConfig(msg: unknown): msg is ApplyConfigMsg {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ApplyConfigMsg).type === 'applyConfig';
}

// ── Saved WiFi Types ────────────────────────────────────────────────

export interface SavedWiFiSetting {
  ssid: string;
  wpaKey: string;
  internetAccess?: boolean;
  createdAt: number; // timestamp when first created
  lastUsedAt: number; // timestamp when last used
}

export function isSavedWiFiSetting(setting: unknown): setting is SavedWiFiSetting {
  if (typeof setting !== 'object') return false;
  if (!setting) return false;

  const { ssid, wpaKey, createdAt, lastUsedAt } = setting as SavedWiFiSetting;

  if (typeof ssid !== 'string') return false;
  if (typeof wpaKey !== 'string') return false;
  if (typeof createdAt !== 'number') return false;
  if (typeof lastUsedAt !== 'number') return false;

  return true;
}

// ── mDNS Reflector Activity ─────────────────────────────────────────

export interface MdnsResolvedName {
  name: string;
  /** Resolved IPv4 address from A record, if seen */
  resolvedIp?: string;
  /** Source IP of the query that triggered this lookup */
  requester?: string;
  /** Service types discovered for this hostname (e.g. ['_ni-rt._tcp', '_ni._tcp']) */
  services?: string[];
}

export interface StationMdnsActivity {
  team: number;
  queriesForwarded: number;
  responsesForwarded: number;
  recentNames: MdnsResolvedName[];
}

export interface MdnsActivity {
  type: 'mdnsActivity';
  stations: Partial<Record<StationName, StationMdnsActivity>>;
}

export function isMdnsActivity(msg: unknown): msg is MdnsActivity {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as MdnsActivity).type === 'mdnsActivity';
}

// ── Team Checks ─────────────────────────────────────────────────────

export type CheckStatus = 'pending' | 'pass' | 'fail' | 'warn' | 'error';

export type CheckResult = {
  name: string;
  status: CheckStatus;
  expected?: string;
  actual?: string;
  message?: string;
  /** URL to documentation for fixing the issue when the check fails */
  helpUrl?: string;
};

export interface TeamCheckResults {
  type: 'teamCheckResults';
  station: StationName;
  team: number;
  timestamp: number;
  checks: CheckResult[];
}

export function isTeamCheckResults(msg: unknown): msg is TeamCheckResults {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as TeamCheckResults).type === 'teamCheckResults';
}

// ── Server Info ─────────────────────────────────────────────────────

export interface ServerInfo {
  type: 'serverInfo';
  startTime: number;
  version: string;
}

export function isServerInfo(msg: unknown): msg is ServerInfo {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as ServerInfo).type === 'serverInfo';
}

export type RunTeamChecks = { type: 'runTeamChecks'; station: StationName };

export function isRunTeamChecks(msg: unknown): msg is RunTeamChecks {
  if (typeof msg !== 'object' || !msg) return false;
  const m = msg as RunTeamChecks;
  return m.type === 'runTeamChecks' && StationNameRegex.test(m.station);
}

// ── Robot Test (CSA Tool) ───────────────────────────────────────────

export type RobotTestPhase =
  | 'disabled'
  | 'link_down'
  | 'link_up'
  | 'dhcp_requesting'
  | 'ready'
  | 'checking'
  | 'complete';

export interface RobotTestState {
  type: 'robotTestState';
  phase: RobotTestPhase;
  interfaceName: string;
  linkUp: boolean;
  macAddress?: string;
  teamNumber?: number;
  leasedIp?: string;
  routerIp?: string;
  checks: CheckResult[];
  lastUpdate: number;
}

export function isRobotTestState(msg: unknown): msg is RobotTestState {
  if (typeof msg !== 'object' || !msg) return false;
  return (msg as RobotTestState).type === 'robotTestState';
}
