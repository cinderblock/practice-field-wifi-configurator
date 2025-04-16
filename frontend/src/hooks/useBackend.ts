import { useCallback, useEffect, useState } from 'react';
import { StationName, StationUpdate, StatusEntry } from '../../../src/types';
import { Message as RadioMessage } from 'syslog-server';

let ws: WebSocket | null = null;

function connect() {
  console.log('Connecting to backend');

  const schema = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const nws = new WebSocket(`${schema}://${window.location.host}/ws`);

  // First message is history
  nws.onmessage = history => {
    processHistory(history.data);
    // Subsequent messages are updates
    nws!.onmessage = update => {
      receiveMessage(update.data);
    };
  };

  let connected = false;

  nws.onopen = () => {
    console.log('Connected to backend');
    connected = true;
  };
  nws.onerror = error => {
    if (!connected) return;

    console.error('WebSocket error:', error);
    connected = false;
  };

  nws.onclose = () => {
    console.log('Disconnected from backend');
    connected = false;
    setTimeout(connect, 1000);
  };

  ws = nws;
}

connect();
const history: StatusEntry[] = [];

const radioMessages: RadioMessage[] = [];

function processHistory(json: string) {
  const entry = JSON.parse(json) as StatusEntry[];
  // TODO: Validate
  history.push(...entry);
}

export function sendNewConfig(station: StationName, ssid: string, wpaKey: string) {
  const update: StationUpdate = {
    type: 'station',
    station,
    ssid,
    wpaKey,
  };
  ws?.send(JSON.stringify(update));
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

type Message = StatusEntry | ErrorMessage | RadioMessage;
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
  history.push(detail);

  // Remove old history
  while (history[0].timestamp < Date.now() - MaxHistoryAge) history.shift();

  events.dispatchEvent(new CustomEvent('update', { detail }));
}

function handleRadioMessage(detail: RadioMessage) {
  radioMessages.push(detail);
  events.dispatchEvent(new CustomEvent('radio', { detail }));
}

function receiveMessage(entry: string) {
  const detail = JSON.parse(entry) as Message;

  if (isErrorEntry(detail)) {
    handleErrorEntry(detail);
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
