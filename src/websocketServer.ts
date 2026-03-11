import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import RadioManager from './radioManager.js';
import {
  isStationUpdate,
  isInternetToggle,
  isAdminStopMatch,
  isAdminGlobalEStop,
  isAdminStationEStop,
  isAdminStationDisable,
  isAdminClearEStop,
  isStationJoin,
  isStationLeave,
  isStationReady,
  isStationStartMatch,
  isStationPauseMatch,
  isStationResumeMatch,
  isStationAbandonMatch,
  isUpdateMatchConfig,
  isRoutePreferenceMsg,
  RoutePreferenceState,
} from './types.js';
import { getRealClientIp, normalizeIp } from './utils.js';
import CIDRMatcher from 'cidr-matcher';
import { appError, appWarn } from './appLogger.js';
import { MatchEngine } from './matchEngine.js';
import {
  setRoutePreference,
  clearRoutePreference,
  getPreference,
  getConflictingTeams,
} from './routePreferenceManager.js';

export interface WebSocketContext {
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  /** Send a JSON-serializable message to all connected clients. */
  broadcast: (msg: unknown) => void;
  /** Send updated route preference state to all connected clients (e.g., after config change). */
  broadcastRouteState: () => void;
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

  /** Track which IP each WebSocket connection belongs to */
  const wsToIp = new Map<WebSocket, string>();

  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      try {
        client.send(data);
      } catch {
        // Client socket in bad state — ignore, error handler will clean up
      }
    });
  }

  function buildRouteState(clientIp: string): RoutePreferenceState {
    return {
      type: 'routePreferenceState',
      yourIp: clientIp,
      preference: getPreference(clientIp),
      conflictingTeams: getConflictingTeams(s => radioManager.getTeamForStation(s)),
    };
  }

  function sendRouteState(ws: WebSocket, clientIp: string) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(buildRouteState(clientIp)));
    } catch {
      // Client socket in bad state — ignore
    }
  }

  function broadcastRouteState() {
    for (const [ws, ip] of wsToIp) {
      if (ws.readyState === WebSocket.OPEN) {
        sendRouteState(ws, ip);
      }
    }
  }

  // Broadcast radio status to all clients
  radioManager.addStatusListener(broadcast);

  // Broadcast match state to all clients
  matchEngine.addStateListener(broadcast);

  wss.on('connection', (ws: WebSocket, req) => {
    const socketRemoteAddress = (ws as any)._socket?.remoteAddress;
    const rawIp = getRealClientIp(socketRemoteAddress, req.headers, trustedProxyMatcher);
    const clientIp = normalizeIp(rawIp);
    console.log(`New client connected: ${clientIp}`);

    wsToIp.set(ws, clientIp);

    // Send initial history + match state
    ws.send(JSON.stringify(radioManager.getStatusHistory()));
    ws.send(JSON.stringify(matchEngine.getState()));

    // Send initial route preference state
    sendRouteState(ws, clientIp);

    ws.on('close', () => {
      wsToIp.delete(ws);
    });

    ws.on('error', err => {
      console.error(`WebSocket error from ${clientIp}:`, err.message);
      ws.terminate();
    });

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
      } else if (isRoutePreferenceMsg(data)) {
        if (clientIp === 'unknown') {
          ws.send(JSON.stringify({ error: 'Cannot set route preference: client IP could not be determined' }));
        } else if (data.station === null) {
          clearRoutePreference(clientIp)
            .then(() => sendRouteState(ws, clientIp))
            .catch(err => {
              appError('Error clearing route preference: ' + err.message);
            });
        } else {
          const team = radioManager.getTeamForStation(data.station);
          if (team === null) {
            ws.send(JSON.stringify({ error: 'Station has no team assigned' }));
          } else {
            setRoutePreference(clientIp, data.station, team)
              .then(() => sendRouteState(ws, clientIp))
              .catch(err => {
                appError('Error setting route preference: ' + err.message);
              });
          }
        }
      } else if (isStationJoin(data)) {
        matchEngine.joinStation(data.station);
      } else if (isStationLeave(data)) {
        matchEngine.leaveStation(data.station);
      } else if (isStationReady(data)) {
        matchEngine.setReady(data.station, data.ready);
      } else if (isStationStartMatch(data)) {
        matchEngine.startMatch();
      } else if (isStationPauseMatch(data)) {
        matchEngine.pauseMatch();
      } else if (isStationResumeMatch(data)) {
        matchEngine.resumeMatch();
      } else if (isStationAbandonMatch(data)) {
        matchEngine.abandonMatch();
      } else if (isUpdateMatchConfig(data)) {
        matchEngine.updateMatchConfig(data.config);
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

  return { server, wss, broadcast, broadcastRouteState };
}
