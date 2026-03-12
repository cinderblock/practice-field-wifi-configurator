import { useCallback, useEffect, useState } from 'react';
import {
  AppLogMessage,
  InternetToggle,
  MatchConfig,
  MatchState,
  MdnsActivity,
  NetworkStats,
  SubnetScanResults,
  TeamCheckResults,
  TelemetryUpdate,
  isAppLogMessage,
  isMatchState,
  isMdnsActivity,
  isNetworkStats,
  isSubnetScanResults,
  isTeamCheckResults,
  isTelemetryUpdate,
  isRoutePreferenceState,
  isPendingCommitState,
  isServerInfo,
  RoutePreferenceState,
  PendingCommitState,
  ServerInfo,
  RoutePreferenceMsg,
  RunTeamChecks,
  StationName,
  StationUpdate,
  StatusEntry,
} from '../../../src/types';
import { Message as RadioMessage } from 'syslog-server';

let ws: WebSocket | null = null;
let wsConnected = false;

function connect() {
  const schema = window.location.protocol === 'https:' ? 'wss' : 'ws';

  const url = `${schema}://${window.location.host}/ws`;

  console.log(`Connecting to backend: ${url}`);

  // TODO: Reconnect
  const nws = new WebSocket(url);

  nws.onmessage = msg => {
    const parsed = JSON.parse(msg.data);
    if (Array.isArray(parsed)) {
      processHistory(parsed);
    } else {
      receiveMessage(parsed);
    }
  };

  nws.onopen = () => {
    console.log('Connected to backend');
    wsConnected = true;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: true }));
  };
  nws.onerror = error => {
    if (!wsConnected) return;

    console.error('WebSocket error:', error);
    wsConnected = false;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: false }));
  };

  nws.onclose = () => {
    console.log('Disconnected from backend');
    wsConnected = false;
    events.dispatchEvent(new CustomEvent('wsStatus', { detail: false }));
    setTimeout(connect, 1000);
  };

  ws = nws;
}

connect();
const history: StatusEntry[] = [];

const radioMessages: RadioMessage[] = [];

// Track time offset between server and client (serverTime - clientTime)
let timeOffset = 0;

function processHistory(entries: StatusEntry[]) {
  // TODO: Validate
  history.push(...entries);

  console.log(`Received ${entries.length} history entries`);

  // Delay dispatching events to allow React components to mount and register listeners
  // This ensures charts and other UI components can receive the historical data
  setTimeout(() => {
    console.log(`Dispatching ${entries.length} historical updates to UI`);

    // Dispatch entries with a small stagger so Smoothie charts can properly render
    // Smoothie is a real-time streaming library and needs time to establish viewport
    entries.forEach((entry, index) => {
      setTimeout(() => {
        events.dispatchEvent(new CustomEvent('update', { detail: entry }));
      }, index * 10); // 10ms stagger between each entry
    });
  }, 200); // 200ms initial delay to allow components to mount
}

export function sendNewConfig(
  station: StationName,
  ssid: string,
  wpaKey: string,
  stage = false,
  internetAccess?: boolean,
) {
  const update: StationUpdate = {
    type: 'station',
    station,
    ssid,
    wpaKey,
    stage,
    internetAccess,
  };
  console.log('Sending config update:', update);
  ws?.send(JSON.stringify(update));
}

export function sendInternetToggle(station: StationName, enabled: boolean) {
  const msg: InternetToggle = {
    type: 'internetToggle',
    station,
    enabled,
  };
  console.log('Sending internet toggle:', msg);
  ws?.send(JSON.stringify(msg));
}

const events = new EventTarget();

type StatusUpdateCallback = (e: StatusEntry) => void;

export function useUpdateCallback(cb: StatusUpdateCallback) {
  useEventListener('update', cb);
}

type RadioMessageCallback = (e: RadioMessage) => void;

export function useRadioMessageCallback(cb: RadioMessageCallback) {
  useEventListener('radio', cb);
}

type AppLogCallback = (e: AppLogMessage) => void;

export function useAppLogCallback(cb: AppLogCallback) {
  useEventListener('appLog', cb);
}

type TelemetryCallback = (e: TelemetryUpdate) => void;

export function useTelemetryCallback(cb: TelemetryCallback) {
  useEventListener('telemetry', cb);
}

function useEventListener(type: 'update', cb: StatusUpdateCallback): void;
function useEventListener(type: 'radio', cb: RadioMessageCallback): void;
function useEventListener(type: 'appLog', cb: AppLogCallback): void;
function useEventListener(type: 'telemetry', cb: TelemetryCallback): void;
function useEventListener(
  type: 'update' | 'radio' | 'appLog' | 'telemetry',
  callback: StatusUpdateCallback | RadioMessageCallback | AppLogCallback | TelemetryCallback,
) {
  const cb: EventListener = useCallback(
    event => {
      const { detail } = event as CustomEvent;
      callback(detail);
    },
    [callback],
  );

  useEffect(() => {
    events.addEventListener(type, cb);
    return () => events.removeEventListener(type, cb);
  }, [type, cb]);
}

const MaxHistoryAge = 1000 * 60 * 5; // 5 minutes

function isStatusEntry(entry: unknown): entry is StatusEntry {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;
  if (!('timestamp' in entry)) return false;
  if (!('radioUpdate' in entry)) return false;
  return true;
}

function isErrorEntry(entry: unknown): entry is { error: string; details: string } {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;
  if (!('error' in entry)) return false;
  if (!('details' in entry)) return false;
  return true;
}

let currentMatchState: MatchState | null = null;
let currentNetworkStats: NetworkStats | null = null;
let currentSubnetScan: SubnetScanResults | null = null;
let currentMdnsActivity: MdnsActivity | null = null;
let currentRoutePreferenceState: RoutePreferenceState | null = null;
let currentPendingCommit = false;
let currentServerInfo: ServerInfo | null = null;
const currentTeamCheckResults = new Map<StationName, TeamCheckResults>();

type Message =
  | StatusEntry
  | ErrorMessage
  | RadioMessage
  | MatchState
  | NetworkStats
  | AppLogMessage
  | TelemetryUpdate
  | SubnetScanResults
  | TeamCheckResults
  | ServerInfo
  | RoutePreferenceState
  | PendingCommitState;
type ErrorMessage = { error: string; details: string };

function isRadioMessage(entry: unknown): entry is RadioMessage {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;

  const { host, message, date, protocol } = entry as Omit<RadioMessage, 'date'> & { date: string };

  if (typeof host !== 'string') return false;
  if (typeof message !== 'string') return false;
  if (typeof date !== 'string') return false;
  if (typeof protocol !== 'string') return false;

  (entry as RadioMessage).date = new Date(date); // Convert date to Date object

  return true;
}

function handleErrorEntry(detail: { error: string; details: string }) {
  console.error('Error returned from radio:', detail);
}

function handleStatusEntry(detail: StatusEntry) {
  // Calculate time offset between server and client
  // Server sent detail.timestamp (its current time when the message was created)
  // We're receiving it now at Date.now() (client time)
  const newOffset = detail.timestamp - Date.now();

  const alpha = 0.1;
  // Use exponential moving average to smooth out network latency variations
  // This gives (1-alpha) weight to the old offset and alpha weight to the new measurement
  timeOffset = timeOffset * (1 - alpha) + newOffset * alpha;

  history.push(detail);

  // Remove old history
  while (history[0].timestamp < Date.now() - MaxHistoryAge) history.shift();

  events.dispatchEvent(new CustomEvent('update', { detail }));
}

function handleRadioMessage(detail: RadioMessage) {
  radioMessages.push(detail);
  events.dispatchEvent(new CustomEvent('radio', { detail }));
}

function handleMatchState(state: MatchState) {
  currentMatchState = state;
  events.dispatchEvent(new CustomEvent('matchState', { detail: state }));
}

function handleNetworkStats(stats: NetworkStats) {
  currentNetworkStats = stats;
  events.dispatchEvent(new CustomEvent('networkStats', { detail: stats }));
}

function handleAppLog(msg: AppLogMessage) {
  events.dispatchEvent(new CustomEvent('appLog', { detail: msg }));
}

function handleSubnetScan(scan: SubnetScanResults) {
  currentSubnetScan = scan;
  events.dispatchEvent(new CustomEvent('subnetScan', { detail: scan }));
}

function handleMdnsActivity(activity: MdnsActivity) {
  currentMdnsActivity = activity;
  events.dispatchEvent(new CustomEvent('mdnsActivity', { detail: activity }));
}

function handleTelemetry(update: TelemetryUpdate) {
  events.dispatchEvent(new CustomEvent('telemetry', { detail: update }));
}

function handleRoutePreferenceState(state: RoutePreferenceState) {
  currentRoutePreferenceState = state;
  events.dispatchEvent(new CustomEvent('routePreferenceState', { detail: state }));
}

function handlePendingCommitState(state: PendingCommitState) {
  currentPendingCommit = state.pending;
  events.dispatchEvent(new CustomEvent('pendingCommitState', { detail: state.pending }));
}

function handleTeamCheckResults(results: TeamCheckResults) {
  currentTeamCheckResults.set(results.station, results);
  events.dispatchEvent(new CustomEvent('teamCheckResults', { detail: results }));
}

function handleServerInfo(info: ServerInfo) {
  // Auto-refresh if the backend has been updated since this frontend was built.
  // Both sides use the git short hash; 'unknown' means we can't compare (dev mode, no git).
  const buildVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'unknown';
  if (buildVersion !== 'unknown' && info.version !== 'unknown' && info.version !== buildVersion) {
    console.log(`Version mismatch: frontend=${buildVersion}, server=${info.version} — reloading`);
    window.location.reload();
    return;
  }

  currentServerInfo = info;
  events.dispatchEvent(new CustomEvent('serverInfo', { detail: info }));
}

function receiveMessage(detail: Message) {
  if (isServerInfo(detail)) {
    handleServerInfo(detail);
    return;
  }

  if (isPendingCommitState(detail)) {
    handlePendingCommitState(detail);
    return;
  }

  if (isRoutePreferenceState(detail)) {
    handleRoutePreferenceState(detail);
    return;
  }

  if (isErrorEntry(detail)) {
    handleErrorEntry(detail);
    return;
  }

  if (isTelemetryUpdate(detail)) {
    handleTelemetry(detail);
    return;
  }

  if (isMatchState(detail)) {
    handleMatchState(detail);
    return;
  }

  if (isSubnetScanResults(detail)) {
    handleSubnetScan(detail);
    return;
  }

  if (isTeamCheckResults(detail)) {
    handleTeamCheckResults(detail);
    return;
  }

  if (isMdnsActivity(detail)) {
    handleMdnsActivity(detail);
    return;
  }

  if (isNetworkStats(detail)) {
    handleNetworkStats(detail);
    return;
  }

  if (isAppLogMessage(detail)) {
    handleAppLog(detail);
    return;
  }

  if (isRadioMessage(detail)) {
    handleRadioMessage(detail);
    return;
  }

  if (isStatusEntry(detail)) {
    handleStatusEntry(detail);
    return;
  }

  console.error('Invalid status entry:', detail);
}

export function useHistory() {
  const [retHistory, setHistory] = useState<StatusEntry[]>([...history]);

  useUpdateCallback(useCallback(_ => setHistory([...history]), [setHistory]));

  return retHistory;
}

export function useLatest() {
  const [latest, setLatest] = useState<StatusEntry | undefined>(history[history.length - 1]);

  useUpdateCallback(setLatest);

  return latest;
}

export function useRadioMessages() {
  const [messages, setMessages] = useState<RadioMessage[]>([...radioMessages]);

  useRadioMessageCallback(useCallback(_ => setMessages([...radioMessages]), [setMessages]));

  return messages;
}

/**
 * Returns the current server time (adjusted for clock offset between client and server)
 */
export function getServerTime(): number {
  return Date.now() + timeOffset;
}

/**
 * Converts a server timestamp to browser/client time
 */
export function serverToBrowserTime(serverTimestamp: number): number {
  return serverTimestamp - timeOffset;
}

// ── Robot Telemetry ─────────────────────────────────────────────────

export function useLatestTelemetry(station: StationName): TelemetryUpdate | undefined {
  const [latest, setLatest] = useState<TelemetryUpdate | undefined>();

  useTelemetryCallback(
    useCallback(
      (update: TelemetryUpdate) => {
        if (update.station === station) setLatest(update);
      },
      [station],
    ),
  );

  return latest;
}

// ── WebSocket Connection State ───────────────────────────────────────

export function useWsConnected(): boolean {
  const [connected, setConnected] = useState(wsConnected);

  useEffect(() => {
    const handler = (e: Event) => setConnected((e as CustomEvent).detail);
    events.addEventListener('wsStatus', handler);
    return () => events.removeEventListener('wsStatus', handler);
  }, []);

  return connected;
}

// ── Match State ─────────────────────────────────────────────────────

export function useMatchState(): MatchState | null {
  const [state, setState] = useState<MatchState | null>(currentMatchState);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('matchState', handler);
    return () => events.removeEventListener('matchState', handler);
  }, []);

  return state;
}

// ── Network Stats ───────────────────────────────────────────────────

export function useNetworkStats(): NetworkStats | null {
  const [state, setState] = useState<NetworkStats | null>(currentNetworkStats);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('networkStats', handler);
    return () => events.removeEventListener('networkStats', handler);
  }, []);

  return state;
}

// ── Subnet Scan ─────────────────────────────────────────────────────

export function useSubnetScan(): SubnetScanResults | null {
  const [state, setState] = useState<SubnetScanResults | null>(currentSubnetScan);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('subnetScan', handler);
    return () => events.removeEventListener('subnetScan', handler);
  }, []);

  return state;
}

// ── mDNS Activity ───────────────────────────────────────────────────

export function useMdnsActivity(): MdnsActivity | null {
  const [state, setState] = useState<MdnsActivity | null>(currentMdnsActivity);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('mdnsActivity', handler);
    return () => events.removeEventListener('mdnsActivity', handler);
  }, []);

  return state;
}

// ── Station match commands ───────────────────────────────────────────

export function sendStationJoin(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationJoin', station }));
}

export function sendStationLeave(station: StationName) {
  ws?.send(JSON.stringify({ type: 'stationLeave', station }));
}

export function sendStationReady(station: StationName, ready: boolean) {
  ws?.send(JSON.stringify({ type: 'stationReady', station, ready }));
}

export function sendStationStartMatch() {
  ws?.send(JSON.stringify({ type: 'stationStartMatch' }));
}

export function sendStationPauseMatch() {
  ws?.send(JSON.stringify({ type: 'stationPauseMatch' }));
}

export function sendStationResumeMatch() {
  ws?.send(JSON.stringify({ type: 'stationResumeMatch' }));
}

export function sendStationAbandonMatch() {
  ws?.send(JSON.stringify({ type: 'stationAbandonMatch' }));
}

export function sendUpdateMatchConfig(config: MatchConfig) {
  ws?.send(JSON.stringify({ type: 'updateMatchConfig', config }));
}

// ── Admin Commands ──────────────────────────────────────────────────

export function sendAdminStopMatch() {
  ws?.send(JSON.stringify({ type: 'adminStopMatch' }));
}

export function sendAdminGlobalEStop() {
  ws?.send(JSON.stringify({ type: 'adminGlobalEStop' }));
}

export function sendAdminStationEStop(station: StationName) {
  ws?.send(JSON.stringify({ type: 'adminStationEStop', station }));
}

export function sendAdminStationDisable(station: StationName) {
  ws?.send(JSON.stringify({ type: 'adminStationDisable', station }));
}

export function sendAdminClearEStop(station?: StationName) {
  ws?.send(JSON.stringify({ type: 'adminClearEStop', station }));
}

// ── Route Preferences ───────────────────────────────────────────────

export function useRoutePreferenceState(): RoutePreferenceState | null {
  const [state, setState] = useState<RoutePreferenceState | null>(currentRoutePreferenceState);

  useEffect(() => {
    const handler = (e: Event) => setState((e as CustomEvent).detail);
    events.addEventListener('routePreferenceState', handler);
    return () => events.removeEventListener('routePreferenceState', handler);
  }, []);

  return state;
}

export function sendRoutePreference(station: RoutePreferenceMsg['station']) {
  ws?.send(JSON.stringify({ type: 'routePreference', station } satisfies RoutePreferenceMsg));
}

// ── Pending Commit ──────────────────────────────────────────────────

export function usePendingCommit(): boolean {
  const [pending, setPending] = useState(currentPendingCommit);

  useEffect(() => {
    const handler = (e: Event) => setPending((e as CustomEvent).detail);
    events.addEventListener('pendingCommitState', handler);
    return () => events.removeEventListener('pendingCommitState', handler);
  }, []);

  return pending;
}

export function sendApplyConfig() {
  ws?.send(JSON.stringify({ type: 'applyConfig' }));
}

// ── Team Checks ─────────────────────────────────────────────────────

export function useTeamCheckResults(station: StationName): TeamCheckResults | null {
  const [results, setResults] = useState<TeamCheckResults | null>(
    currentTeamCheckResults.get(station) ?? null,
  );

  useEffect(() => {
    setResults(currentTeamCheckResults.get(station) ?? null);
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<TeamCheckResults>).detail;
      if (detail.station === station) setResults(detail);
    };
    events.addEventListener('teamCheckResults', handler);
    return () => events.removeEventListener('teamCheckResults', handler);
  }, [station]);

  return results;
}

export function sendRunTeamChecks(station: StationName) {
  ws?.send(JSON.stringify({ type: 'runTeamChecks', station } satisfies RunTeamChecks));
}

// ── Server Info ─────────────────────────────────────────────────────

export function useServerStartTime(): number | null {
  const [startTime, setStartTime] = useState<number | null>(currentServerInfo?.startTime ?? null);

  useEffect(() => {
    setStartTime(currentServerInfo?.startTime ?? null);
    const handler = (e: Event) => {
      setStartTime((e as CustomEvent<ServerInfo>).detail.startTime);
    };
    events.addEventListener('serverInfo', handler);
    return () => events.removeEventListener('serverInfo', handler);
  }, []);

  return startTime;
}
