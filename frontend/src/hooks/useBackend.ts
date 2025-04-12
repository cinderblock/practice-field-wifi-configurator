import { useCallback, useEffect, useState } from 'react';
import { StationName, StatusEntry } from '../../../src/types';

let ws: WebSocket | null = null;

function connect() {
  console.log('Connecting to backend');

  const nws = new WebSocket(`ws://${window.location.host}/ws`);

  // First message is history
  nws.onmessage = history => {
    processHistory(history.data);
    // Subsequent messages are updates
    nws!.onmessage = update => {
      appendHistory(update.data);
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

function processHistory(json: string) {
  const entry = JSON.parse(json) as StatusEntry[];
  // TODO: Validate
  history.push(...entry);
}

export function sendNewConfig(station: StationName, ssid: string, wpaKey: string) {
  ws?.send(
    JSON.stringify({
      type: 'station',
      station,
      ssid,
      wpaKey,
    }),
  );
}

const events = new EventTarget();

type StatusUpdateCallback = (e: StatusEntry) => void;

export function useUpdateCallback(cb: StatusUpdateCallback) {
  const updateLatest: EventListener = useCallback(
    event => {
      const { detail } = event as CustomEvent<StatusEntry>;
      cb(detail);
    },
    [cb],
  );

  useEffect(() => {
    events.addEventListener('update', updateLatest);
    return () => events.removeEventListener('update', updateLatest);
  }, [updateLatest]);
}

const MaxHistoryAge = 1000 * 60 * 5; // 5 minutes

function appendHistory(entry: string) {
  const detail = JSON.parse(entry) as StatusEntry;
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
