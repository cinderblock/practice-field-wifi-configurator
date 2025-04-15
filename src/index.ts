import RadioManager from './radioManager';
import { runSyslogServer } from './runSyslogServer';
import { setupWebSocket } from './websocketServer';
import { runFMS } from './fmsServer';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://10.0.100.2';

// Initialize radio manager
const radioManager = new RadioManager(API_BASE_URL);

// Initialize WebSocket server
setupWebSocket(radioManager);

runSyslogServer().then(syslogServer => {
  if (!syslogServer) return;

  syslogServer.on('message', msg => {
    console.log('Message from VH-113:');
    console.log(msg);
  });
});

runFMS().then(fms => {
  if (!fms) return;

  fms.on('message', msg => {
    console.log('Message from FMS:');
    console.log(msg);
  });
});
