import { useState, useEffect, useCallback } from 'react';
import { useWsConnected } from './useBackend';

export type CheckStatus = 'ok' | 'error' | 'checking';

export interface ConnectivityState {
  internet: CheckStatus;
  wsConnected: boolean;
}

const POLL_INTERVAL = 15_000;
const CHECK_TIMEOUT = 5_000;

function checkInternet(): Promise<boolean> {
  return new Promise(resolve => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve(false);
    }, CHECK_TIMEOUT);

    img.onload = () => {
      clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };

    img.src = `https://www.google.com/favicon.ico?_=${Date.now()}`;
  });
}

export function useConnectivity(): ConnectivityState {
  const wsConnected = useWsConnected();
  const [internet, setInternet] = useState<CheckStatus>('checking');

  const runCheck = useCallback(async () => {
    setInternet((await checkInternet()) ? 'ok' : 'error');
  }, []);

  useEffect(() => {
    runCheck();
    const interval = setInterval(runCheck, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [runCheck]);

  return { internet, wsConnected };
}
