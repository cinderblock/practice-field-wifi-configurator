import RadioManager from './radioManager.js';
import { runSyslogServer } from './runSyslogServer.js';
import { setupWebSocket } from './websocketServer.js';
import { runFMS } from './fmsServer.js';
import { startConfigurationScheduler } from './scheduler.js';
import CIDRMatcher from 'cidr-matcher';
import { toCidr } from './utils.js';

// Configuration
const RadioUrl = process.env.RADIO_URL || 'http://10.0.100.2';
const VlanInterface = process.env.VLAN_INTERFACE; // e.g., 'eno1', 'eth2', or undefined
const StartFMS = process.env.FMS_ENDPOINT === 'true';
const StartSyslog = process.env.SYSLOG_ENDPOINT === 'true';
const WebSocketPort = Number(process.env.WEBSOCKET_PORT) || 3000;

// Trusted proxy configuration
const trustedProxyMatcher = process.env.TRUSTED_PROXIES
  ? new CIDRMatcher(
      process.env.TRUSTED_PROXIES.split(/[,\s]+/g)
        .filter(s => s)
        .map(toCidr),
    )
  : undefined;

// Scheduled configuration clearing
const RadioClearSchedule = process.env.RADIO_CLEAR_SCHEDULE;
const RadioClearTimezone = process.env.RADIO_CLEAR_TIMEZONE;

// Initialize radio manager
const radioManager = new RadioManager(RadioUrl, VlanInterface);

// Initialize WebSocket server
const wss = setupWebSocket(radioManager, WebSocketPort, trustedProxyMatcher);

// Initialize scheduled configuration clearing
if (RadioClearSchedule) {
  startConfigurationScheduler(radioManager, RadioClearSchedule, RadioClearTimezone);
} else {
  console.log('RADIO_CLEAR_SCHEDULE environment variable is not set. Skipping scheduled configuration clearing.');
}

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
