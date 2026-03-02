import { useState, useEffect, useCallback } from 'react';
import { useWsConnected } from './useBackend';

export type CheckStatus = 'ok' | 'error' | 'checking';
export type FailReason = 'rejected' | 'timeout' | undefined;

export interface ConnectivityState {
  internet: CheckStatus;
  pfmsHttp: CheckStatus;
  pfmsHttpFailReason: FailReason;
  wsConnected: boolean;
}

const POLL_INTERVAL = 15_000;
const CHECK_TIMEOUT = 5_000;
// If a fetch fails faster than this, it's likely a TLS/cert rejection rather than a timeout
const FAST_FAIL_THRESHOLD = 1_000;

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

async function checkPfmsHealth(): Promise<{ ok: boolean; failReason: FailReason }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT);
    const res = await fetch('/health', { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, failReason: 'rejected' };
    const body = await res.json();
    return { ok: body.ok === true, failReason: body.ok ? undefined : 'rejected' };
  } catch {
    const elapsed = Date.now() - start;
    return { ok: false, failReason: elapsed < FAST_FAIL_THRESHOLD ? 'rejected' : 'timeout' };
  }
}

export function useConnectivity(): ConnectivityState {
  const wsConnected = useWsConnected();
  const [internet, setInternet] = useState<CheckStatus>('checking');
  const [pfmsHttp, setPfmsHttp] = useState<CheckStatus>('checking');
  const [pfmsHttpFailReason, setPfmsHttpFailReason] = useState<FailReason>(undefined);

  const runChecks = useCallback(async () => {
    const [internetOk, pfmsResult] = await Promise.all([checkInternet(), checkPfmsHealth()]);
    setInternet(internetOk ? 'ok' : 'error');
    setPfmsHttp(pfmsResult.ok ? 'ok' : 'error');
    setPfmsHttpFailReason(pfmsResult.ok ? undefined : pfmsResult.failReason);
  }, []);

  useEffect(() => {
    runChecks();
    const interval = setInterval(runChecks, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [runChecks]);

  return { internet, pfmsHttp, pfmsHttpFailReason, wsConnected };
}
