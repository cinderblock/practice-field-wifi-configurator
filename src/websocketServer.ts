import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { execFileSync } from 'node:child_process';
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
  isStationJoinAlliance,
  isStationLeave,
  isStationReady,
  isStationStartMatch,
  isStationPauseMatch,
  isStationResumeMatch,
  isStationAbandonMatch,
  isUpdateMatchConfig,
  isRoutePreferenceMsg,
  isApplyConfig,
  isRunTeamChecks,
  isFirmwareUpdateRequest,
  isStopCast,
  isCastReceiverRegister,
  isCastReceiverSwap,
  isRadioConfigureRequest,
  isRemoveSavedTeam,
  CastReceiverList,
  RoutePreferenceState,
  PendingCommitState,
  ServerInfo,
  StationName,
} from './types.js';
import { getRealClientIp, normalizeIp } from './utils.js';
import CIDRMatcher from 'cidr-matcher';
import { appError, appWarn } from './appLogger.js';
import { MatchEngine } from './matchEngine.js';
import type { SavedTeamStore } from './savedTeamStore.js';
import {
  setRoutePreference,
  clearRoutePreference,
  getPreference,
  getConflictingTeams,
} from './routePreferenceManager.js';

export type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface WebSocketContext {
  server: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  /** Send a JSON-serializable message to all connected clients. */
  broadcast: (msg: unknown) => void;
  /** Send updated route preference state to all connected clients (e.g., after config change). */
  broadcastRouteState: () => void;
}

export type RunTeamChecksCallback = (station: StationName) => void;
export type FirmwareUpdateCallback = (
  wpaKey: string | undefined,
  wpaKey24: string | undefined,
  skipReconfigure: boolean,
) => void;

export type RadioConfigureCallback = (
  teamNumber: number,
  wpaKey6: string,
  wpaKey24: string | undefined,
  ssidSuffix: string | undefined,
) => void;

export function setupWebSocket(
  radioManager: RadioManager,
  matchEngine: MatchEngine,
  port: number,
  trustedProxyMatcher?: CIDRMatcher,
  onRunTeamChecks?: RunTeamChecksCallback,
  httpHandlers?: HttpRequestHandler[],
  onFirmwareUpdate?: FirmwareUpdateCallback,
  onRadioConfigure?: RadioConfigureCallback,
  savedTeamStore?: SavedTeamStore,
): WebSocketContext {
  let serverVersion = 'unknown';
  try {
    serverVersion = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
  } catch {
    // Not a git repo or git not available — fall back to unknown
  }

  const serverStartTime = Date.now();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Try registered HTTP handlers first (e.g. scoring API)
    if (httpHandlers) {
      for (const handler of httpHandlers) {
        if (handler(req, res)) return;
      }
    }

    // CORS headers for unhandled routes
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

  /** Track registered cast receivers (TV displays) */
  let nextReceiverId = 1;
  const castReceivers = new Map<WebSocket, { id: string; name: string; swapped: boolean }>();

  function broadcastReceiverList() {
    const list: CastReceiverList = {
      type: 'castReceiverList',
      receivers: [...castReceivers.values()],
    };
    broadcast(list);
  }

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

  // Broadcast saved team config changes to all clients
  savedTeamStore?.addListener(broadcast);

  // Broadcast pending commit state changes to all clients
  radioManager.addPendingCommitListener(pending => {
    broadcast({
      type: 'pendingCommitState',
      pending,
      stagedChanges: pending ? radioManager.getStagedChanges() : undefined,
    } satisfies PendingCommitState);
  });

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

    // Send initial pending commit state
    ws.send(
      JSON.stringify({
        type: 'pendingCommitState',
        pending: radioManager.pendingCommit,
        stagedChanges: radioManager.pendingCommit ? radioManager.getStagedChanges() : undefined,
      } satisfies PendingCommitState),
    );

    // Send server info (start time for uptime display)
    ws.send(
      JSON.stringify({ type: 'serverInfo', startTime: serverStartTime, version: serverVersion } satisfies ServerInfo),
    );

    // Send saved team configs
    if (savedTeamStore) {
      ws.send(JSON.stringify(savedTeamStore.getState()));
    }

    ws.on('close', () => {
      wsToIp.delete(ws);
      if (castReceivers.delete(ws)) {
        broadcastReceiverList();
      }
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
          const current = radioManager.getStationConfig(data.station);
          const radioUnchanged = current && current.ssid === data.ssid && current.wpaKey === data.wpaKey;
          const internetChanged = current && !!current.internetAccess !== !!data.internetAccess;

          if (radioUnchanged && !internetChanged) {
            // Nothing changed at all
            ws.send(JSON.stringify({ info: 'No changes detected — configuration already active' }));
          } else if (radioUnchanged && internetChanged) {
            // Only internet access changed — toggle it without reconfiguring the radio
            radioManager.toggleInternetAccess(data.station, !!data.internetAccess).catch(err => {
              appError('Error toggling internet access: ' + err.message);
              ws.send(JSON.stringify({ error: 'Failed to toggle internet access', details: err.message }));
            });
          } else {
            // SSID or WPA changed — full radio reconfiguration
            radioManager.configure(data.station, data).catch(err => {
              appError('Error configuring station: ' + err.message);
              ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
            });
          }
        }
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
      } else if (isStationJoinAlliance(data)) {
        matchEngine.joinStationAlliance(data.station, data.alliance);
      } else if (isStationJoin(data)) {
        // Backward compat: infer alliance from station name prefix
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
      } else if (isApplyConfig(data)) {
        radioManager.commitConfiguration().catch(err => {
          appError('Error applying config: ' + err.message);
          ws.send(JSON.stringify({ error: 'Failed to apply configuration', details: err.message }));
        });
      } else if (isRunTeamChecks(data)) {
        onRunTeamChecks?.(data.station);
      } else if (isFirmwareUpdateRequest(data)) {
        onFirmwareUpdate?.(data.wpaKey, data.wpaKey24, !!data.skipReconfigure);
      } else if (isRadioConfigureRequest(data)) {
        onRadioConfigure?.(data.teamNumber, data.wpaKey6, data.wpaKey24, data.ssidSuffix);
      } else if (isStopCast(data)) {
        if (data.receiverId) {
          // Stop a specific receiver
          for (const [rws, info] of castReceivers) {
            if (info.id === data.receiverId && rws.readyState === WebSocket.OPEN) {
              rws.send(JSON.stringify(data));
            }
          }
        } else {
          broadcast(data);
        }
      } else if (isCastReceiverRegister(data)) {
        const id = `cast-${nextReceiverId++}`;
        castReceivers.set(ws, { id, name: data.name, swapped: data.swapped });
        // Send the assigned ID back to the receiver
        ws.send(JSON.stringify({ type: 'castReceiverId', id }));
        broadcastReceiverList();
      } else if (isRemoveSavedTeam(data)) {
        if (savedTeamStore) {
          savedTeamStore.removeTeam(data.ssid);
        }
      } else if (isCastReceiverSwap(data)) {
        // Find the target receiver and send it the swap command
        for (const [rws, info] of castReceivers) {
          if (info.id === data.receiverId) {
            info.swapped = data.swapped;
            if (rws.readyState === WebSocket.OPEN) {
              rws.send(JSON.stringify(data));
            }
            break;
          }
        }
        broadcastReceiverList();
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
