import RadioManager from './radioManager.js';
import { runSyslogServer } from './runSyslogServer.js';
import { setupWebSocket } from './websocketServer.js';
import { runFMS } from './fmsServer.js';
import { startConfigurationScheduler } from './scheduler.js';
import { waitForRadio, detectFirmwareMode, checkInterfaceIps, checkRequiredTools } from './startupChecks.js';
import { createBackend, createDryRunBackend } from './node-ip/index.js';
import type { NetworkBackend } from './node-ip/index.js';
import CIDRMatcher from 'cidr-matcher';
import { toCidr } from './utils.js';
import { MatchEngine } from './matchEngine.js';
import { stopAllDHCP } from './networkManager.js';
import { onConfigChange as onRouteConfigChange, cleanupAllPreferences, restorePreferencesFromKernel } from './routePreferenceManager.js';
import { buildNetworkStats } from './networkStats.js';
import { setBroadcast } from './appLogger.js';
import { TelemetryManager } from './telemetryManager.js';
import { MatchAudio } from './matchAudio.js';
import { SubnetScanner } from './subnetScanner.js';
import { StationNameList } from './types.js';

const IPTABLES_COMMENT_PREFIX = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';

// When true, skip flushing iptables/ip rules on startup and restore preferences from the kernel.
// Use after a graceful restart (SIGUSR1) to avoid disrupting existing network state.
const KeepNetwork = process.env.KEEP_NETWORK === 'true';

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
  let net: NetworkBackend | undefined;
  if (VlanInterface) {
    const tools = ['iptables', 'arping', 'fping'];
    if (firmwareMode !== 'PRACTICE') tools.push('dnsmasq');
    await checkRequiredTools(tools);
    net = process.env.DRY_RUN ? createDryRunBackend() : createBackend();
    // pFMS serves multiple roles on this interface:
    const expectedIps = [
      '10.0.100.5', // FMS
      // We reconfigure the radio to use our IP instead of listening on an extra interface
      // '10.0.100.40', // Syslog server
    ];
    await checkInterfaceIps(VlanInterface, expectedIps, net);

    if (KeepNetwork) {
      // Preserve existing rules — this is a graceful restart. Preferences are
      // restored from the kernel below, after the WebSocket server is up.
      console.log('KEEP_NETWORK=true: skipping iptables flush');
    } else {
      // Clean up stale iptables rules from a previous run (e.g., after a crash)
      await net.flushRulesByComment(IPTABLES_COMMENT_PREFIX);
    }

    // Enable IP forwarding once at startup (required for inter-VLAN routing)
    await net.setSysctl({ key: 'net.ipv4.ip_forward', value: '1' });
  }

  // Initialize radio manager
  const radioManager = new RadioManager(RadioUrl, VlanInterface, firmwareMode);

  // After a full restart (iptables were flushed), re-apply the restored activeConfig
  // to rebuild network rules. Skip for graceful reload — rules are still in the kernel.
  if (!KeepNetwork && VlanInterface && Object.keys(radioManager.getTeamMappings()).length > 0) {
    radioManager.commitConfiguration().catch(err => {
      console.error('Failed to re-apply station config after restart:', err);
    });
  }

  // Initialize match engine (for admin page match simulation & e-stop)
  const matchEngine = new MatchEngine(s => radioManager.getTeamForStation(s));

  // Initialize match audio (plays FRC field sounds on phase transitions)
  const matchAudio = new MatchAudio();
  await matchAudio.init();
  matchAudio.attachToEngine(matchEngine);

  // Initialize WebSocket server
  const { wss, broadcast, broadcastRouteState } = setupWebSocket(radioManager, matchEngine, WebSocketPort, trustedProxyMatcher);
  setBroadcast(broadcast);

  // Subnet scanning for device discovery on team VLANs
  const subnetScanner = new SubnetScanner(
    s => radioManager.getTeamForStation(s),
    results => {
      latestSubnetScan = results;
      broadcast(results);
    },
  );
  let latestSubnetScan: ReturnType<SubnetScanner['getResults']> | null = null;
  subnetScanner.start(10_000);

  wss.on('connection', ws => {
    if (latestSubnetScan) ws.send(JSON.stringify(latestSubnetScan));
  });

  // Push updated match state (team numbers) when station configs change
  // Also clear subnet scan data for stations that lost their team
  radioManager.addConfigChangeListener(() => {
    broadcast(matchEngine.getState());
    for (const station of StationNameList) {
      if (radioManager.getTeamForStation(station) === null) {
        subnetScanner.clearStation(station);
      }
    }
    broadcast(subnetScanner.getResults());
    // Clear stale routing preferences then push updated state to all clients
    onRouteConfigChange(s => radioManager.getTeamForStation(s)).then(() => broadcastRouteState());
  });

  // Initialize scheduled configuration clearing
  if (RadioClearSchedule) {
    startConfigurationScheduler(radioManager, RadioClearSchedule, RadioClearTimezone, matchEngine);
  } else {
    console.log('RADIO_CLEAR_SCHEDULE environment variable is not set. Skipping scheduled configuration clearing.');
  }

  if (StartSyslog) {
    runSyslogServer().then(syslogServer => {
      if (!syslogServer) return;

      syslogServer.on('message', msg => {
        broadcast(msg);
      });

      // TODO: Load system IP
      radioManager.setSyslogIP('10.0.100.5').catch(err => {
        console.error('Failed to set Syslog IP:', err);
      });
    });
  }

  if (StartFMS) {
    const telemetryManager = new TelemetryManager(
      () => radioManager.getTeamMappings(),
      update => broadcast(update),
    );

    runFMS().then(fms => {
      if (!fms) return;

      fms.on('message', msg => {
        // Route telemetry to stations via WebSocket
        telemetryManager.processFmsEvent(msg);

        // Auto-discover DS addresses for the match engine.
        // Match on any message carrying teamNumber — TCP 0x18 and UDP both do.
        if ('teamNumber' in msg.data) {
          const station = radioManager.getStationForTeam(msg.data.teamNumber);
          if (station) matchEngine.setDSAddress(station, msg.address);
        }
      });
    });
  }

  // Broadcast iptables forwarding counters to all clients every 5 seconds
  if (net) {
    let latestNetworkStats: Awaited<ReturnType<typeof buildNetworkStats>> | null = null;

    async function refreshNetworkStats() {
      try {
        latestNetworkStats = await buildNetworkStats(net!, IPTABLES_COMMENT_PREFIX);
        broadcast(latestNetworkStats);
      } catch (err) {
        console.error('Error polling network stats:', err);
      }
    }

    // Send cached stats immediately when a new client connects
    wss.on('connection', ws => {
      if (latestNetworkStats) ws.send(JSON.stringify(latestNetworkStats));
    });

    // Fetch immediately so first clients don't wait 5s
    refreshNetworkStats();
    setInterval(refreshNetworkStats, 5000);
  }

  // Shutdown signal handlers
  if (net) {
    const fullCleanup = () => {
      stopAllDHCP();
      console.log('Cleaning up network rules...');
      Promise.all([
        net!.flushRulesByComment(IPTABLES_COMMENT_PREFIX),
        cleanupAllPreferences(),
      ]).then(
        () => process.exit(0),
        err => {
          console.error('Error during cleanup:', err);
          process.exit(1);
        },
      );
    };

    // SIGUSR1: exit without touching network state so the next startup can pick up
    // where this one left off. Start the new process with KEEP_NETWORK=true.
    const gracefulExit = () => {
      stopAllDHCP();
      console.log('Graceful exit: network rules preserved.');
      process.exit(0);
    };

    process.on('SIGTERM', fullCleanup);
    process.on('SIGINT', fullCleanup);
    process.on('SIGUSR1', gracefulExit);
  }

  // After a graceful restart, restore routing preferences from the kernel so the
  // in-memory map stays in sync with existing ip rules.
  if (net && KeepNetwork) {
    const restored = await restorePreferencesFromKernel();
    if (restored > 0) {
      console.log(`Restored ${restored} route preference(s) from kernel`);
      broadcastRouteState();
    }
  }
})();
