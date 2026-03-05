import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import RadioManager from './radioManager.js';
import {
  isStationUpdate,
  isInternetToggle,
  isAdminStartMatch,
  isAdminStopMatch,
  isAdminGlobalEStop,
  isAdminStationEStop,
  isAdminStationDisable,
  isAdminClearEStop,
} from './types.js';
import { getRealClientIp } from './utils.js';
import CIDRMatcher from 'cidr-matcher';
import { appError, appWarn } from './appLogger.js';
import { MatchEngine } from './matchEngine.js';

export interface WebSocketContext {
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  /** Send a JSON-serializable message to all connected clients. */
  broadcast: (msg: unknown) => void;
}

export function setupWebSocket(
  radioManager: RadioManager,
  matchEngine: MatchEngine,
  port: number,
  trustedProxyMatcher?: CIDRMatcher,
): WebSocketContext {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const wss = new WebSocketServer({ server });

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });
  }

  // Broadcast radio status to all clients
  radioManager.addStatusListener(broadcast);

  // Broadcast match state to all clients
  matchEngine.addStateListener(broadcast);

  wss.on('connection', (ws: WebSocket, req) => {
    const socketRemoteAddress = (ws as any)._socket?.remoteAddress;
    const realClientIp = getRealClientIp(socketRemoteAddress, req.headers, trustedProxyMatcher);
    console.log(`New client connected: ${realClientIp}`);

    // Send initial history + match state
    ws.send(JSON.stringify(radioManager.getStatusHistory()));
    ws.send(JSON.stringify(matchEngine.getState()));

    ws.on('message', (message: string) => {
      let data: unknown;
      try {
        data = JSON.parse(message);
      } catch {
        appError('Invalid JSON from client');
        ws.send(JSON.stringify({ error: 'Invalid JSON', details: 'Could not parse message' }));
        return;
      }

      // Log the configuration to be sent for debugging (with passphrase redacted)
      const sanitizedConfig = { ...(data as Record<string, unknown>) };
      if ('wpaKey' in sanitizedConfig) sanitizedConfig.wpaKey = '***';
      console.log('Received message:', sanitizedConfig);

      if (isStationUpdate(data)) {
        if (matchEngine.isMatchActive()) {
          ws.send(JSON.stringify({ error: 'Cannot reconfigure stations during an active match' }));
        } else {
          radioManager.configure(data.station, data).catch(err => {
            appError('Error configuring station: ' + err.message);
            ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
          });
        }
        // TODO: handle multiple simultaneous configurations gracefully
      } else if (isInternetToggle(data)) {
        if (matchEngine.isMatchActive()) {
          ws.send(JSON.stringify({ error: 'Cannot toggle internet access during an active match' }));
        } else {
          radioManager.toggleInternetAccess(data.station, data.enabled).catch(err => {
            appError('Error toggling internet access: ' + err.message);
            ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
          });
        }
      } else if (isAdminStartMatch(data)) {
        matchEngine.startMatch(data.config);
      } else if (isAdminStopMatch(data)) {
        matchEngine.stopMatch();
      } else if (isAdminGlobalEStop(data)) {
        matchEngine.globalEStop();
      } else if (isAdminStationEStop(data)) {
        matchEngine.stationEStop(data.station);
      } else if (isAdminStationDisable(data)) {
        matchEngine.stationDisable(data.station);
      } else if (isAdminClearEStop(data)) {
        matchEngine.clearEStop(data.station);
      } else {
        appWarn('Unknown message type from client: ' + JSON.stringify(sanitizedConfig));
      }
    });
  });

  server.listen(port, () => {
    console.log(`HTTP + WebSocket server running on port ${port}`);
  });

  return { server, wss, broadcast };
}
