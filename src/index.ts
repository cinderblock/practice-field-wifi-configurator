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
import { stopAllDHCP, resolveStationByNeighbor, vlanMap, restorePreviousStations } from './networkManager.js';
import {
  onConfigChange as onRouteConfigChange,
  cleanupAllPreferences,
  restorePreferencesFromKernel,
} from './routePreferenceManager.js';
import { buildNetworkStats } from './networkStats.js';
import { setBroadcast } from './appLogger.js';
import { TelemetryManager } from './telemetryManager.js';
import { MatchAudio } from './matchAudio.js';
import { SubnetScanner } from './subnetScanner.js';
import { MdnsReflector } from './mdnsReflector.js';
import { TeamChecker } from './teamChecker.js';
import { StationName, StationNameList, TeamCheckResults } from './types.js';
import { existsSync, rmSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

const IPTABLES_COMMENT_PREFIX = process.env.IPTABLES_COMMENT_PREFIX || 'pfms-';

// When true, skip flushing iptables/ip rules on startup and restore preferences from the kernel.
// Set automatically by a graceful reload (systemctl reload writes /run/pfms-keep-network before
// sending SIGHUP). Can also be forced via KEEP_NETWORK=true env var for manual overrides.
const KEEP_NETWORK_FLAG = '/run/pfms-keep-network';
const keepNetworkFlagExists = existsSync(KEEP_NETWORK_FLAG);
if (keepNetworkFlagExists) rmSync(KEEP_NETWORK_FLAG, { force: true });
const KeepNetwork = keepNetworkFlagExists || process.env.KEEP_NETWORK === 'true';

// Configuration
const RadioUrl = process.env.RADIO_URL || 'http://10.0.100.2'; // Probably don't need to override this
const VlanInterface = process.env.VLAN_INTERFACE; // e.g., 'eno1', 'eth2', or undefined
const StartFMS = process.env.FMS_ENDPOINT === 'true';
const StartSyslog = process.env.SYSLOG_ENDPOINT === 'true';
const StartMdnsReflector = process.env.MDNS_REFLECTOR === 'true';
const VlanHostOctet = Number(process.env.VLAN_HOST_OCTET) || 254;
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
  // Verify expected IPs on the VLAN interface
  let net: NetworkBackend | undefined;
  if (VlanInterface) {
    await checkRequiredTools(['iptables', 'arping', 'fping', 'dnsmasq', 'conntrack']);
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
      // Also flush per-station route tables — these aren't comment-tagged so
      // flushRulesByComment doesn't catch them.
      for (const vlanId of Object.values(vlanMap)) {
        try {
          await execFile('ip', ['route', 'flush', 'table', String(vlanId)]);
        } catch {
          // Table may not exist yet on first run — that's fine.
        }
      }
    }

    // Enable IP forwarding once at startup (required for inter-VLAN routing)
    await net.setSysctl({ key: 'net.ipv4.ip_forward', value: '1' });
  }

  // Initialize radio manager — firmware mode will be set when the radio connects
  const radioManager = new RadioManager(RadioUrl, VlanInterface);

  // Connect to the radio in the background — don't block startup.
  // After a full restart (iptables were flushed), re-apply the restored activeConfig
  // once firmware mode is known, so configureNetwork knows whether to start dnsmasq.
  (async () => {
    const status = await waitForRadio(RadioUrl);
    if (status) {
      radioManager.setFirmwareMode(detectFirmwareMode(status.version));
    }

    // Re-apply config after full restart to rebuild network rules.
    // Skip for graceful reload — rules are still in the kernel.
    if (!KeepNetwork && VlanInterface && Object.keys(radioManager.getTeamMappings()).length > 0) {
      await radioManager.commitConfiguration();
    }
  })().catch(err => {
    console.error('Background radio connection failed:', err);
  });

  // Initialize match engine (for admin page match simulation & e-stop)
  const matchEngine = new MatchEngine(s => radioManager.getTeamForStation(s));

  // Initialize match audio (plays FRC field sounds on phase transitions)
  const matchAudio = new MatchAudio();
  await matchAudio.init();
  matchAudio.attachToEngine(matchEngine);

  // Initialize WebSocket server (onRunTeamChecks callback is set below after teamChecker is created)
  let onRunTeamChecks: ((station: StationName) => void) | undefined;
  const { wss, broadcast, broadcastRouteState } = setupWebSocket(
    radioManager,
    matchEngine,
    WebSocketPort,
    trustedProxyMatcher,
    station => onRunTeamChecks?.(station),
  );
  setBroadcast(broadcast);

  // Subnet scanning for device discovery on team VLANs
  const subnetScanner = new SubnetScanner(
    s => radioManager.getTeamForStation(s),
    results => {
      latestSubnetScan = results;
      broadcast(results);

      // Re-trigger team checks when new devices appear on stations that had error results.
      // This handles the case where the radio is up but the RIO isn't yet — when the RIO
      // comes online, the subnet scanner will detect it and we re-run checks automatically.
      for (const station of StationNameList) {
        const team = radioManager.getTeamForStation(station);
        if (!team) continue;
        const lastResults = latestCheckResults.get(station);
        if (!lastResults) continue;
        if (!lastResults.checks.some(c => c.status === 'error')) continue;

        const currentAlive = new Set(
          results.stations[station]?.hosts.filter(h => h.alive).map(h => h.ip) ?? [],
        );
        const previousAlive = checksAliveSnapshot.get(station);
        const retries = checksRetryCount.get(station) ?? 0;
        if (previousAlive && retries < MAX_AUTO_RETRIGGERS && [...currentAlive].some(ip => !previousAlive.has(ip))) {
          checksRetryCount.set(station, retries + 1);
          triggerTeamChecks(station, team);
        }
      }
    },
  );
  let latestSubnetScan: ReturnType<SubnetScanner['getResults']> | null = null;
  subnetScanner.start(10_000);

  // Team checker — runs automated checks when a DS connects
  const teamChecker = new TeamChecker(
    s => {
      const scan = subnetScanner.getResults();
      return scan.stations[s]?.hosts.filter(h => h.alive) ?? [];
    },
  );
  const latestCheckResults = new Map<StationName, TeamCheckResults>();
  // Snapshot of alive IPs when checks last ran, so we can re-trigger when new devices appear
  const checksAliveSnapshot = new Map<StationName, Set<string>>();
  // Guard against concurrent check runs per station
  const checksInFlight = new Set<StationName>();
  // Cap automatic re-triggers to avoid infinite retries against unreachable devices
  const checksRetryCount = new Map<StationName, number>();
  const MAX_AUTO_RETRIGGERS = 5;

  /** Run team checks for a station, broadcast results, and cache them. */
  function triggerTeamChecks(station: StationName, team: number) {
    if (checksInFlight.has(station)) return;
    checksInFlight.add(station);

    teamChecker.runChecks(station, team).then(results => {
      latestCheckResults.set(station, results);
      // Snapshot AFTER checks complete so we compare against what was alive
      // when results were determined, avoiding unnecessary re-triggers
      const scan = subnetScanner.getResults();
      checksAliveSnapshot.set(station, new Set(
        scan.stations[station]?.hosts.filter(h => h.alive).map(h => h.ip) ?? [],
      ));
      broadcast(results);
    }).catch(err => {
      console.error(`Team checks failed for ${station}:`, err);
    }).finally(() => {
      checksInFlight.delete(station);
    });
  }

  // Wire up the manual re-run callback
  onRunTeamChecks = (station: StationName) => {
    const team = radioManager.getTeamForStation(station);
    if (team !== null) {
      checksRetryCount.delete(station);
      triggerTeamChecks(station, team);
    }
  };

  wss.on('connection', ws => {
    if (latestSubnetScan) ws.send(JSON.stringify(latestSubnetScan));
    for (const results of latestCheckResults.values()) {
      ws.send(JSON.stringify(results));
    }
  });

  // Clean up state and broadcast updates when station configs change
  radioManager.addConfigChangeListener(() => {
    broadcast(matchEngine.getState());
    for (const station of StationNameList) {
      if (radioManager.getTeamForStation(station) === null) {
        latestCheckResults.delete(station);
        checksAliveSnapshot.delete(station);
        checksInFlight.delete(station);
        checksRetryCount.delete(station);
        subnetScanner.clearStation(station);
      }
    }
    broadcast(subnetScanner.getResults());
    // Clear stale routing preferences then push updated state to all clients
    onRouteConfigChange(s => radioManager.getTeamForStation(s)).then(() => broadcastRouteState());
  });

  // mDNS reflector — bridges .local queries between main network and team VLANs
  let mdnsReflector: MdnsReflector | undefined;
  if (StartMdnsReflector && VlanInterface) {
    mdnsReflector = new MdnsReflector(
      s => radioManager.getTeamForStation(s),
      VlanHostOctet,
    );
    mdnsReflector.start();
    // Refresh after commit — VLAN interfaces only exist after configureNetwork completes
    radioManager.addCommitCompleteListener(() => mdnsReflector!.refreshMemberships());
  } else if (StartMdnsReflector) {
    console.log('MDNS_REFLECTOR=true but VLAN_INTERFACE is not set, skipping mDNS reflector');
  }

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
      update => {
        broadcast(update);
        // When a robot transitions to disabled, check if we can flush a deferred commit
        if (update.dsStatus && !update.dsStatus.enabled) {
          radioManager.retryDeferredCommit();
        }
      },
    );

    // Defer radio configuration while robots are enabled or a match is running
    radioManager.setShouldDefer(() => matchEngine.isMatchActive() || telemetryManager.anyRobotEnabled());

    // Also retry deferred commits when match state changes (e.g., match ends)
    matchEngine.addStateListener(() => {
      radioManager.retryDeferredCommit();
    });

    // Track active DNAT rules so we can clean them up when stations are reconfigured.
    // Map: station → { dsIp, gatewayIp, vlanInterface }
    const activeDnatRules = new Map<StationName, { dsIp: string; gatewayIp: string; vlanInterface: string }>();

    // After a graceful restart, restore DNAT rules from the kernel so we can
    // properly clean them up if a DS reconnects with a different IP.
    if (KeepNetwork) {
      try {
        const { stdout } = await execFile('iptables', ['-t', 'nat', '-S', 'PREROUTING']);
        for (const line of stdout.split('\n')) {
          if (!line.includes(`${IPTABLES_COMMENT_PREFIX}dnat-`)) continue;
          const iMatch = line.match(/-i\s+(\S+)/);
          const dMatch = line.match(/-d\s+(\S+)/);
          const commentMatch = line.match(/--comment\s+(\S+)/);
          const toMatch = line.match(/--to-destination\s+(\S+)/);
          if (!iMatch || !dMatch || !commentMatch || !toMatch) {
            console.warn(`Failed to parse DNAT rule for restoration: ${line.trim()}`);
            continue;
          }
          const station = commentMatch[1].replace(`${IPTABLES_COMMENT_PREFIX}dnat-`, '') as StationName;
          if (!StationNameList.includes(station)) continue;
          const gatewayIp = dMatch[1].replace(/\/\d+$/, '');
          activeDnatRules.set(station, { dsIp: toMatch[1], gatewayIp, vlanInterface: iMatch[1] });
          console.log(`Restored DNAT rule: ${station} UDP → ${gatewayIp} rewritten to ${toMatch[1]}`);
        }
      } catch (err) {
        console.warn('Failed to restore DNAT rules from kernel:', (err as Error).message);
      }
    }

    /**
     * Compute the gateway (MASQUERADE source) IP on a team's VLAN.
     * Robot sees this as the source of forwarded DS packets, and sends
     * return traffic here — which the DNAT rule rewrites to the real DS IP.
     */
    function teamGatewayIp(team: number): string {
      const high = Math.floor(team / 100);
      const low = team % 100;
      return `10.${high}.${low}.${VlanHostOctet}`;
    }

    /**
     * Add a PREROUTING DNAT rule so all UDP from the robot destined for
     * the gateway (MASQUERADE source) gets forwarded to the real DS laptop
     * on the guest network. Scoped to the gateway IP to avoid catching
     * multicast (mDNS) or broadcast (DHCP) traffic.
     */
    async function addDnatRule(station: StationName, dsIp: string) {
      if (!net || !VlanInterface) return;
      const team = radioManager.getTeamForStation(station);
      if (!team) return;
      const vlanInterface = `${VlanInterface}.${station}`;
      const gatewayIp = teamGatewayIp(team);
      const existing = activeDnatRules.get(station);
      if (existing?.dsIp === dsIp) return; // Already set, idempotent
      if (existing) await removeDnatRule(station); // Different DS, remove old rule first
      await net.iptables({
        action: '-A',
        table: 'nat',
        chain: 'PREROUTING',
        inInterface: vlanInterface,
        protocol: 'udp',
        destination: gatewayIp,
        jump: 'DNAT',
        toDestination: dsIp,
        comment: `${IPTABLES_COMMENT_PREFIX}dnat-${station}`,
      });
      activeDnatRules.set(station, { dsIp, gatewayIp, vlanInterface });
      console.log(`DNAT rule added: ${station} UDP → ${gatewayIp} rewritten to ${dsIp}`);
      // Flush any stale conntrack entries for UDP traffic to the gateway IP.
      // Without this, packets that arrived before the DNAT rule was inserted get
      // cached as local-delivery flows, and subsequent packets bypass the nat table entirely.
      try {
        const { stdout } = await execFile('conntrack', ['-D', '-p', 'udp', '-d', gatewayIp]);
        console.log(`conntrack flush: ${stdout.trim()}`);
      } catch (err: unknown) {
        const { code } = err as { code?: number | string };
        if (code === 1) {
          // No entries matched — the race didn't happen this time. Nothing to flush.
        } else if (code === 'ENOENT') {
          console.error('conntrack binary not found — install with: sudo apt install conntrack');
        } else {
          console.error(`conntrack flush failed (code ${code}):`, (err as Error).message);
        }
      }
    }

    async function removeDnatRule(station: StationName) {
      if (!net) return;
      const existing = activeDnatRules.get(station);
      if (!existing) return;
      await net.iptables({
        action: '-D',
        table: 'nat',
        chain: 'PREROUTING',
        inInterface: existing.vlanInterface,
        protocol: 'udp',
        destination: existing.gatewayIp,
        jump: 'DNAT',
        toDestination: existing.dsIp,
        comment: `${IPTABLES_COMMENT_PREFIX}dnat-${station}`,
      });
      activeDnatRules.delete(station);
      console.log(`DNAT rule removed: ${station}`);
    }

    // Clean up DNAT rules when stations are deconfigured or team changes
    radioManager.addConfigChangeListener(() => {
      for (const [station, existing] of [...activeDnatRules]) {
        const team = radioManager.getTeamForStation(station);
        if (team === null || teamGatewayIp(team) !== existing.gatewayIp) {
          removeDnatRule(station).catch(err => {
            console.error(`Failed to remove DNAT rule for ${station}:`, err);
          });
          matchEngine.clearDSAddress(station);
        }
      }
    });

    runFMS().then(fms => {
      if (!fms) return;

      // Track which stations have already had checks triggered this session,
      // so we don't re-run on every DS UDP heartbeat.
      const checksTriggered = new Set<StationName>();

      radioManager.addConfigChangeListener(() => {
        for (const station of StationNameList) {
          if (radioManager.getTeamForStation(station) === null) {
            checksTriggered.delete(station);
          }
        }
      });

      fms.on('message', msg => {
        // Route telemetry to stations via WebSocket
        telemetryManager.processFmsEvent(msg);

        // Auto-discover DS addresses for the match engine.
        // Match on any message carrying teamNumber — TCP 0x18 and UDP both do.
        if ('teamNumber' in msg.data) {
          const { teamNumber } = msg.data;
          // TCP remoteAddress may be IPv6-mapped (::ffff:10.x.x.x) — normalize to plain IPv4
          const address = msg.address.replace(/^::ffff:/, '');

          if (VlanInterface && radioManager.isTeamDuplicated(teamNumber)) {
            // Same team on multiple stations — use the kernel neighbor (ARP) table
            // to determine which VLAN interface (and thus station) the packet came from.
            resolveStationByNeighbor(address, VlanInterface).then(station => {
              station ??= radioManager.getStationForTeam(teamNumber);
              if (station) {
                matchEngine.setDSAddress(station, address);
                addDnatRule(station, address);
                if (!checksTriggered.has(station)) {
                  checksTriggered.add(station);
                  checksRetryCount.delete(station);
                  setTimeout(() => triggerTeamChecks(station, teamNumber), 2000);
                }
              }
            }).catch(err => {
              console.error('DS address discovery failed:', err);
            });
          } else {
            // Common case: unique team numbers — direct lookup, no subprocess needed
            const station = radioManager.getStationForTeam(teamNumber);
            if (station) {
              matchEngine.setDSAddress(station, address);
              addDnatRule(station, address);
              if (!checksTriggered.has(station)) {
                checksTriggered.add(station);
                checksRetryCount.delete(station);
                setTimeout(() => triggerTeamChecks(station, teamNumber), 2000);
              }
            }
          }
        }
      });

      // DNAT rules persist across DS TCP reconnects (the DS flaps every ~6s
      // when no match is running). Rules are cleaned up by the config change
      // listener above when a station loses its team assignment.
    });
  }

  // Broadcast iptables forwarding counters and mDNS activity to all clients every 5 seconds
  if (net) {
    let latestNetworkStats: Awaited<ReturnType<typeof buildNetworkStats>> | null = null;
    let latestMdnsActivity: ReturnType<MdnsReflector['getActivity']> | null = null;

    async function refreshNetworkStats() {
      try {
        latestNetworkStats = await buildNetworkStats(net!, IPTABLES_COMMENT_PREFIX);
        broadcast(latestNetworkStats);
      } catch (err) {
        console.error('Error polling network stats:', err);
      }
      if (mdnsReflector) {
        latestMdnsActivity = mdnsReflector.getActivity();
        broadcast(latestMdnsActivity);
      }
    }

    // Send cached stats immediately when a new client connects
    wss.on('connection', ws => {
      if (latestNetworkStats) ws.send(JSON.stringify(latestNetworkStats));
      if (latestMdnsActivity) ws.send(JSON.stringify(latestMdnsActivity));
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
      const flushRouteTables = Promise.all(
        Object.values(vlanMap).map(id =>
          execFile('ip', ['route', 'flush', 'table', String(id)]).catch(() => {}),
        ),
      );
      Promise.all([net!.flushRulesByComment(IPTABLES_COMMENT_PREFIX), cleanupAllPreferences(), flushRouteTables]).then(
        () => process.exit(0),
        err => {
          console.error('Error during cleanup:', err);
          process.exit(1);
        },
      );
    };

    // SIGHUP (systemctl reload): exit without touching network state. systemd will
    // write /run/pfms-keep-network before sending SIGHUP, so the next startup skips
    // the iptables flush and restores routing preferences from the kernel.
    const gracefulExit = () => {
      stopAllDHCP();
      console.log('Graceful exit: network rules preserved.');
      process.exit(0);
    };

    process.on('SIGTERM', fullCleanup);
    process.on('SIGINT', fullCleanup);
    process.on('SIGHUP', gracefulExit);
  }

  // After a graceful restart, restore in-memory state from the kernel so it
  // stays in sync with rules that were left in place.
  if (net && KeepNetwork) {
    // Tell networkManager which teams are already configured so future config
    // changes properly tear down old routes and iptables rules.
    restorePreviousStations(s => radioManager.getTeamForStation(s));

    const restored = await restorePreferencesFromKernel();
    if (restored > 0) {
      console.log(`Restored ${restored} route preference(s) from kernel`);
      broadcastRouteState();
    }
  }
})();
