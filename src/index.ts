import RadioManager from './radioManager.js';
import { runSyslogServer } from './runSyslogServer.js';
import { setupWebSocket } from './websocketServer.js';
import { runFMS } from './fmsServer.js';
import { startConfigurationScheduler } from './scheduler.js';
import { waitForRadio, detectFirmwareMode, checkInterfaceIps, startRoutingCheck } from './startupChecks.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import CIDRMatcher from 'cidr-matcher';
import { toCidr } from './utils.js';

// Configuration
const RadioUrl = process.env.RADIO_URL || 'http://10.0.100.2'; // Probably don't need to override this
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

(async () => {
  // Startup checks — block until radio is reachable
  const initialStatus = await waitForRadio(RadioUrl);
  const firmwareMode = detectFirmwareMode(initialStatus.version);

  // Verify expected IPs on the VLAN interface
  if (VlanInterface) {
    const net = process.env.YOLO ? createBackend() : createDryRunBackend();
    // Steamboat serves multiple roles on this interface:
    const expectedIps = [
      '10.0.100.5', // FMS
      '10.0.100.40', // Syslog server
    ];
    await checkInterfaceIps(VlanInterface, expectedIps, net);

    // Enable IP forwarding once at startup (required for inter-VLAN routing)
    await net.setSysctl({ key: 'net.ipv4.ip_forward', value: '1' });
  }

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

      // TODO: Load system IP
      radioManager.setSyslogIP('10.0.100.5').catch(err => {
        console.error('Failed to set Syslog IP:', err);
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

  // Start routing health check (OFFSEASON only)
  // Pings the router from the trunk interface to verify the static route is configured
  if (firmwareMode === 'OFFSEASON' && VlanInterface) {
    startRoutingCheck('10.0.100.1', VlanInterface);
  }
})();
