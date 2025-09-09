import { WebSocket, WebSocketServer } from 'ws';
import RadioManager from './radioManager';
import { isStationUpdate } from './types';

const DefaultPort = Number(process.env.WEBSOCKET_PORT) || 3000;

export function setupWebSocket(radioManager: RadioManager, port = DefaultPort) {
  const wss = new WebSocketServer({ port });

  // Set up single listener for all clients
  radioManager.addStatusListener(entry => {
    const data = JSON.stringify(entry);
    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });
  });

  wss.on('connection', (ws: WebSocket) => {
    console.log('New client connected:', (ws as any)._socket?.remoteAddress);
    // Send initial history
    const history = radioManager.getStatusHistory();
    ws.send(JSON.stringify(history));

    ws.on('message', (message: string) => {
      const data = JSON.parse(message);
      console.log('Received message:', data);

      if (isStationUpdate(data)) {
        radioManager.configure(data.station, data).catch(err => {
          console.error('Error configuring station:', err);
          ws.send(JSON.stringify({ error: 'Failed to configure station', details: err.message }));
        });
        // TODO: handle multiple simultaneous configurations gracefully
      }
    });
  });

  wss.on('listening', () => {
    console.log(`[${new Date().toISOString()}] WebSocket server running on port ${port}`);
  });

  return wss;
}
