import { useCallback, useEffect, useState } from 'react';
import {
  InternetToggle,
  MatchConfig,
  MatchState,
  isMatchState,
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

  // First message is history
  nws.onmessage = history => {
    processHistory(history.data);
    // Subsequent messages are updates
    nws!.onmessage = update => {
      receiveMessage(update.data);
    };
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

function processHistory(json: string) {
  const entries = JSON.parse(json) as StatusEntry[];
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

function useEventListener(type: 'update', cb: StatusUpdateCallback): void;
function useEventListener(type: 'radio', cb: RadioMessageCallback): void;
function useEventListener(type: 'update' | 'radio', callback: StatusUpdateCallback | RadioMessageCallback) {
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

type Message = StatusEntry | ErrorMessage | RadioMessage | MatchState;
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
  // This gives alpha% weight to the OLD offset and (1-alpha)% to the new offset for stability
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

function receiveMessage(entry: string) {
  const detail = JSON.parse(entry) as Message;

  if (isErrorEntry(detail)) {
    handleErrorEntry(detail);
    return;
  }

  if (isMatchState(detail)) {
    handleMatchState(detail);
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

// ── Admin Commands ──────────────────────────────────────────────────

export function sendAdminStartMatch(config: MatchConfig) {
  ws?.send(JSON.stringify({ type: 'adminStartMatch', config }));
}

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
