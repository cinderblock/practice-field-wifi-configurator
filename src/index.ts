import RadioManager from './radioManager.js';
import { runSyslogServer } from './runSyslogServer.js';
import { setupWebSocket } from './websocketServer.js';
import { runFMS } from './fmsServer.js';

// Configuration
const RadioUrl = process.env.RADIO_URL || 'http://10.0.100.2';
const VlanInterface = process.env.VLAN_INTERFACE; // e.g., 'eno1', 'eth2', or undefined
const StartFMS = process.env.FMS_ENDPOINT === 'true';
const StartSyslog = process.env.SYSLOG_ENDPOINT === 'true';

// Initialize radio manager
const radioManager = new RadioManager(RadioUrl, VlanInterface);

// Initialize WebSocket server
const wss = setupWebSocket(radioManager);

if (StartSyslog) {
runSyslogServer().then(syslogServer => {
  if (!syslogServer) return;

  syslogServer.on('message', msg => {
    const data = JSON.stringify(msg);

    wss.clients.forEach(client => {
      if (client.readyState !== WebSocket.OPEN) return;
      client.send(data);
    });
  });
});
}

if (StartFMS) {
runFMS().then(fms => {
  if (!fms) return;

  fms.on('message', msg => {
    console.log('Message from DS:');
    console.log(msg);
  });
});
}
