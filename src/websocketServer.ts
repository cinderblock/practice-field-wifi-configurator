import { WebSocket, WebSocketServer } from 'ws';
import RadioManager from './radioManager';

const DefaultPort = Number(process.env.SERVER_PORT) || 3000;

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
    // Send initial history
    const history = radioManager.getStatusHistory();
    ws.send(JSON.stringify(history));

    ws.on('message', (message: string) => {
      const data = JSON.parse(message);
      console.log('Received message:', data);
      if (data.type === 'station') {
        radioManager.configure(data.station, data);
      }
    });
  });

  wss.on('listening', () => {
    console.log(`[${new Date().toISOString()}] WebSocket server running on port ${port}`);
  });

  return wss;
}
