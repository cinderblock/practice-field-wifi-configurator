import RadioManager from './radioManager';
import { runSyslogServer } from './runSyslogServer';
import { setupWebSocket } from './websocketServer';
import { runFMS } from './fmsServer';

// Configuration
const RadioUrl = process.env.RADIO_URL || 'http://10.0.100.2';
const VlanInterface = process.env.VLAN_INTERFACE;

// Initialize radio manager
const radioManager = new RadioManager(RadioUrl, VlanInterface);

// Initialize WebSocket server
const wss = setupWebSocket(radioManager);

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

runFMS().then(fms => {
  if (!fms) return;

  fms.on('message', msg => {
    console.log('Message from DS:');
    console.log(msg);
  });
});
