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
import { MatchEngine } from './matchEngine.js';

export function setupWebSocket(
  radioManager: RadioManager,
  matchEngine: MatchEngine,
  port: number,
  trustedProxyMatcher?: CIDRMatcher,
) {
  const wss = new WebSocketServer({ port });

  // Broadcast radio status to all clients
  radioManager.addStatusListener(entry => {
    const data = JSON.stringify(entry);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });
  });

  // Broadcast match state to all clients
  matchEngine.addStateListener(state => {
    const data = JSON.stringify(state);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    const socketRemoteAddress = (ws as any)._socket?.remoteAddress;
    const realClientIp = getRealClientIp(socketRemoteAddress, req.headers, trustedProxyMatcher);
    console.log(`New client connected: ${realClientIp}`);

    // Send initial history + match state
    const history = radioManager.getStatusHistory();
    ws.send(JSON.stringify(history));
    ws.send(JSON.stringify(matchEngine.getState()));

    ws.on('message', (message: string) => {
      let data: unknown;
      try {
        data = JSON.parse(message);
      } catch {
        console.error('Invalid JSON from client:', message);
        ws.send(JSON.stringify({ error: 'Invalid JSON', details: 'Could not parse message' }));
        return;
      }

      // Log the configuration to be sent for debugging (with passphrase redacted)
      const sanitizedConfig = { ...(data as Record<string, unknown>) };
      if ('wpaKey' in sanitizedConfig) sanitizedConfig.wpaKey = '***';
      console.log('Received message:', sanitizedConfig);

      if (isStationUpdate(data)) {
        radioManager.configure(data.station, data).catch(err => {
          console.error('Error configuring station:', err);
          ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
        });
        // TODO: handle multiple simultaneous configurations gracefully
      } else if (isInternetToggle(data)) {
        radioManager.toggleInternetAccess(data.station, data.enabled).catch(err => {
          console.error('Error toggling internet access:', err);
          ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
        });
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
        console.warn('Unknown message type from client:', sanitizedConfig);
      }
    });
  });

  wss.on('listening', () => {
    console.log(`WebSocket server running on port ${port}`);
  });

  return wss;
}
