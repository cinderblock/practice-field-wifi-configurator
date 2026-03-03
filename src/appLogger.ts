import type { AppLogMessage, LogLevel } from './types.js';

type BroadcastFn = (msg: unknown) => void;

let broadcastFn: BroadcastFn | null = null;

/** Called once from index.ts after setupWebSocket returns. */
export function setBroadcast(fn: BroadcastFn): void {
  broadcastFn = fn;
}

/**
 * Log a message to the console AND broadcast it to all connected WebSocket clients.
 * Before setBroadcast() is called, messages only go to console.
 */
export function appLog(level: LogLevel, message: string): void {
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);

  if (!broadcastFn) return;

  const msg: AppLogMessage = {
    type: 'appLog',
    timestamp: Date.now(),
    level,
    message,
  };

  broadcastFn(msg);
}

export const appInfo = (message: string) => appLog('info', message);
export const appWarn = (message: string) => appLog('warn', message);
export const appError = (message: string) => appLog('error', message);
