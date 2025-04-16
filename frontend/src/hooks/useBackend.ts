import { useCallback, useEffect, useState } from 'react';
import { StationName, StationUpdate, StatusEntry } from '../../../src/types';
import SyslogServer from 'syslog-server';

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
  const updateLatest: EventListener = useCallback(
    event => {
      const { detail, type } = event as CustomEvent<StatusEntry | RadioMessage>;
      if (type === 'update') {
        cb(detail as StatusEntry);
      }
    },
    [cb],
  );

  useEffect(() => {
    events.addEventListener('update', updateLatest);
    return () => events.removeEventListener('update', updateLatest);
  }, [updateLatest]);
}

type RadioMessageCallback = (e: RadioMessage) => void;

export function useRadioMessageCallback(cb: RadioMessageCallback) {
  const updateLatest: EventListener = useCallback(
    event => {
      const { detail, type } = event as CustomEvent<StatusEntry | RadioMessage>;
      if (type === 'radio') {
        cb(detail as RadioMessage);
      }
    },
    [cb],
  );

  useEffect(() => {
    events.addEventListener('update', updateLatest);
    return () => events.removeEventListener('update', updateLatest);
  }, [updateLatest]);
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
type RadioMessage = SyslogServer.SyslogMessage;

function isRadioMessage(entry: unknown): entry is RadioMessage {
  if (typeof entry !== 'object') return false;
  if (!entry) return false;

  const { host, message, date, protocol } = entry as RadioMessage;

  if (typeof host !== 'string') return false;
  if (typeof message !== 'string') return false;
  if (!(date instanceof Date)) return false;
  if (typeof protocol !== 'string') return false;

  return true;
}

function receiveMessage(entry: string) {
  const detail = JSON.parse(entry) as Message;

  if (isErrorEntry(detail)) {
    console.error('Invalid status entry:', detail);
    return;
  }

  if (isRadioMessage(detail)) {
    radioMessages.push(detail);
    events.dispatchEvent(new CustomEvent('radio', { detail }));
  }

  if (!isStatusEntry(detail)) {
    console.error('Invalid status entry:', detail);
    return;
  }

  // TODO: Validate
  history.push(detail);

  // Remove old history
  while (history[0].timestamp < Date.now() - MaxHistoryAge) history.shift();

  events.dispatchEvent(new CustomEvent('update', { detail }));
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
