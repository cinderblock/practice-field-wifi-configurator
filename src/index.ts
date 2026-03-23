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
import { RobotTestMonitor } from './robotTestMonitor.js';
import { RobotPacketCapture } from './robotPacketCapture.js';
import { FirmwareStore } from './firmwareStore.js';
import { handleFirmwareRequest } from './firmwareApi.js';
import { ScoringEngine } from './scoringEngine.js';
import { handleScoringRequest } from './scoringApi.js';
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
const TestInterface = process.env.TEST_INTERFACE;
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
    await checkRequiredTools(['iptables', 'arping', 'fping', 'dnsmasq', 'conntrack', 'tcpdump']);
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

    // Re-apply config to rebuild network rules if needed.
    const teamMappings = radioManager.getTeamMappings();
    if (VlanInterface && Object.keys(teamMappings).length > 0) {
      if (KeepNetwork) {
        // Graceful reload — verify VLANs actually exist and have IPs.
        // If a commit was staged but never applied before the restart,
        // the VLANs may be missing even though active-config.json has teams.
        let vlansOk = true;
        try {
          const interfaces = await (net ?? createBackend()).listInterfaces();
          const ifaceIps = new Set<string>();
          for (const iface of interfaces) {
            for (const addr of iface.addresses) {
              if (addr.family === 'inet') ifaceIps.add(addr.address);
            }
          }
          for (const team of Object.keys(teamMappings).map(Number)) {
            const high = Math.floor(team / 100);
            const low = team % 100;
            const expectedIp = `10.${high}.${low}.${VlanHostOctet}`;
            if (!ifaceIps.has(expectedIp)) {
              console.warn(`VLAN IP ${expectedIp} missing for team ${team} — will re-apply config`);
              vlansOk = false;
              break;
            }
          }
        } catch {
          vlansOk = false;
        }
        if (!vlansOk) {
          await radioManager.commitConfiguration();
        }
      } else {
        // Full restart — always re-apply
        await radioManager.commitConfiguration();
      }
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

  // Initialize scoring engine
  const ScoringApiKey = process.env.SCORING_API_KEY;
  const ScoringAutoRegisterLimit = Number(process.env.SCORING_AUTO_REGISTER_LIMIT) || 1;
  const scoringEngine = new ScoringEngine();
  scoringEngine.setAutoRegisterLimit(ScoringAutoRegisterLimit);

  // Auto-switch scoring mode based on match state
  matchEngine.addStateListener(state => scoringEngine.onMatchStateChange(state));

  // Initialize WebSocket server (onRunTeamChecks callback is set below after teamChecker is created)
  let onRunTeamChecks: ((station: StationName) => void) | undefined;
  const { wss, broadcast, broadcastRouteState } = setupWebSocket(
    radioManager,
    matchEngine,
    WebSocketPort,
    trustedProxyMatcher,
    station => onRunTeamChecks?.(station),
    [
      (req, res) => handleScoringRequest(req, res, scoringEngine, ScoringApiKey),
      (req, res) => handleFirmwareRequest(req, res, firmwareStore),
    ],
    (wpaKey, wpaKey24, skipReconfigure) => {
      if (!robotTestMonitor) return;
      // Auto-detect WPA key from active station config if not provided
      const team = robotTestMonitor.getState().teamNumber;
      const resolvedKey = wpaKey || (team ? (radioManager.getWpaKeyForTeam(team) ?? undefined) : undefined);
      robotTestMonitor.startFirmwareUpdate(resolvedKey, wpaKey24, skipReconfigure).catch(err => {
        console.error('Firmware update failed:', err.message);
      });
    },
    (teamNumber, wpaKey6, wpaKey24, ssidSuffix) => {
      if (!robotTestMonitor) return;
      robotTestMonitor.configureTeamRadio(teamNumber, wpaKey6, wpaKey24, ssidSuffix).catch(err => {
        console.error('Radio configuration failed:', err.message);
      });
    },
  );
  setBroadcast(broadcast);

  // Broadcast score state changes to all WebSocket clients
  scoringEngine.addStateListener(broadcast);

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

        const currentAlive = new Set(results.stations[station]?.hosts.filter(h => h.alive).map(h => h.ip) ?? []);
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
  const teamChecker = new TeamChecker(s => {
    const scan = subnetScanner.getResults();
    return scan.stations[s]?.hosts.filter(h => h.alive) ?? [];
  });
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

    teamChecker
      .runChecks(station, team)
      .then(results => {
        latestCheckResults.set(station, results);
        // Snapshot AFTER checks complete so we compare against what was alive
        // when results were determined, avoiding unnecessary re-triggers
        const scan = subnetScanner.getResults();
        checksAliveSnapshot.set(
          station,
          new Set(scan.stations[station]?.hosts.filter(h => h.alive).map(h => h.ip) ?? []),
        );
        broadcast(results);
      })
      .catch(err => {
        console.error(`Team checks failed for ${station}:`, err);
      })
      .finally(() => {
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

  // Firmware store — persistent cache for radio firmware files
  const firmwareStore = new FirmwareStore();
  // Broadcast firmware store changes (download progress, availability) to all clients
  firmwareStore.addListener(entries => broadcast({ type: 'firmwareStoreUpdate', entries }));
  // Start downloading known firmware files in the background (non-blocking, retries on failure)
  firmwareStore.startBackgroundDownloads();

  // Robot test monitor — CSA tool for diagnosing individual robots
  let robotTestMonitor: RobotTestMonitor | undefined;
  if (TestInterface) {
    const testNet = process.env.DRY_RUN ? createDryRunBackend() : (net ?? createBackend());
    robotTestMonitor = new RobotTestMonitor(
      TestInterface,
      testNet,
      state => broadcast(state),
      progress => broadcast(progress),
      firmwareStore,
      !!process.env.DRY_RUN,
      () => wss.clients.size > 0,
      progress => broadcast(progress),
    );
    await robotTestMonitor.start();
  }

  // Passive robot packet capture — sniff robot→DS UDP to extract battery voltage
  // and robot status without taking FMS control of the Driver Station.
  let robotPacketCapture: RobotPacketCapture | undefined;
  if (VlanInterface && !process.env.DRY_RUN) {
    robotPacketCapture = new RobotPacketCapture(
      VlanInterface,
      () => radioManager.getTeamMappings(),
      update => broadcast(update),
    );
    robotPacketCapture.start();
  }

  wss.on('connection', ws => {
    if (latestSubnetScan) ws.send(JSON.stringify(latestSubnetScan));
    for (const results of latestCheckResults.values()) {
      ws.send(JSON.stringify(results));
    }
    if (robotTestMonitor) ws.send(JSON.stringify(robotTestMonitor.getState()));
    ws.send(JSON.stringify(scoringEngine.getState()));
    ws.send(JSON.stringify({ type: 'firmwareStoreUpdate', entries: firmwareStore.getEntries() }));
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
      process.env.MDNS_EXCLUDE_REQUESTERS,
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
    runSyslogServer('10.0.100.5').then(syslogServer => {
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

    /** Check if an IP is on a configured team's VLAN subnet (10.TE.AM.x/24).
     *  Devices on robot networks (roboRIO, coprocessors) should not be treated
     *  as Driver Stations. Only checks against currently configured teams. */
    function isTeamSubnetAddress(ip: string): boolean {
      const parts = ip.split('.');
      if (parts.length !== 4) return false;
      const prefix = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const mappings = radioManager.getTeamMappings();
      for (const team of Object.keys(mappings).map(Number)) {
        const high = Math.floor(team / 100);
        const low = team % 100;
        if (prefix === `10.${high}.${low}`) return true;
      }
      return false;
    }

    // Track which DS IPs have active TCP connections (refcounted by fmsServer).
    // Used to prevent DNAT thrashing when two DSes compete for the same station.
    const connectedDsIps = new Set<string>();

    // Synchronous record of the accepted DS IP per station. Updated immediately
    // in trySetDSAddress (before the async addDnatRule resolves) to close the race
    // window where a second DS could sneak in during the first DS's iptables call.
    const acceptedDsForStation = new Map<StationName, string>();

    // Track blocked (duplicate) DS IPs per station. Multiple DSes can be blocked
    // simultaneously (e.g. someone opens 3 Driver Stations). Map: station → ip → vlanInterface
    const blockedDsRules = new Map<StationName, Map<string, string>>();
    let blockedDsControlTimer: NodeJS.Timeout | null = null;

    /** Send periodic disabled+game data packets to all blocked DSes so they show the warning. */
    function startBlockedDsControlLoop() {
      if (blockedDsControlTimer) return;
      blockedDsControlTimer = setInterval(() => {
        let anyBlocked = false;
        for (const [station, blocks] of blockedDsRules) {
          for (const ip of blocks.keys()) {
            anyBlocked = true;
            matchEngine.sendRawControlPacket(ip, station, [
              { type: 'gameData', data: 'Multiple DSes Detected. Close Others.' },
            ]);
          }
        }
        if (!anyBlocked) {
          clearInterval(blockedDsControlTimer!);
          blockedDsControlTimer = null;
        }
      }, 500);
    }

    /** Block a duplicate DS from forwarding packets to the robot's VLAN. */
    async function blockDuplicateDS(station: StationName, dsIp: string) {
      if (!net || !VlanInterface) return;
      let stationBlocks = blockedDsRules.get(station);
      if (stationBlocks?.has(dsIp)) return; // Already blocked
      if (!stationBlocks) {
        stationBlocks = new Map();
        blockedDsRules.set(station, stationBlocks);
      }
      const vlanInterface = `${VlanInterface}.${station}`;
      await net.iptables({
        action: '-I',
        chain: 'FORWARD',
        source: dsIp,
        outInterface: vlanInterface,
        jump: 'DROP',
        comment: `${IPTABLES_COMMENT_PREFIX}block-dup-ds-${station}`,
      });
      stationBlocks.set(dsIp, vlanInterface);
      console.warn(`Blocked duplicate DS ${dsIp} from forwarding to ${station} (${vlanInterface})`);
      matchEngine.setBlockedDS(station, [...stationBlocks!.keys()]);
      startBlockedDsControlLoop();
    }

    /** Remove the FORWARD DROP rule for one blocked DS. */
    async function unblockDS(station: StationName, dsIp: string) {
      if (!net) return;
      const stationBlocks = blockedDsRules.get(station);
      const vlanInterface = stationBlocks?.get(dsIp);
      if (!vlanInterface) return;
      await net.iptables({
        action: '-D',
        chain: 'FORWARD',
        source: dsIp,
        outInterface: vlanInterface,
        jump: 'DROP',
        comment: `${IPTABLES_COMMENT_PREFIX}block-dup-ds-${station}`,
      });
      stationBlocks!.delete(dsIp);
      if (stationBlocks!.size === 0) blockedDsRules.delete(station);
      console.log(`Unblocked duplicate DS ${dsIp} for ${station}`);
      const remaining = blockedDsRules.get(station);
      matchEngine.setBlockedDS(station, remaining ? [...remaining.keys()] : undefined);
    }

    /** Remove all FORWARD DROP rules for a station. */
    async function unblockAllDS(station: StationName) {
      const stationBlocks = blockedDsRules.get(station);
      if (!stationBlocks) return;
      for (const ip of [...stationBlocks.keys()]) {
        await unblockDS(station, ip);
      }
    }

    /**
     * Attempt to set the DS address for a station. Returns true if accepted,
     * false if this DS was blocked as a duplicate.
     */
    function trySetDSAddress(station: StationName, dsIp: string): boolean {
      // TODO: Re-enable duplicate DS blocking once we properly filter out
      // robot-network devices (roboRIO, coprocessors) that connect to the FMS
      // TCP port. Currently disabled because team subnet IPs (10.TE.AM.x)
      // trigger false-positive duplicate detection.
      acceptedDsForStation.set(station, dsIp);
      matchEngine.setDSAddress(station, dsIp);
      return true;
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
      // Don't swap DNAT to a different DS if the current one still has an active
      // TCP connection — prevents thrashing when two DSes compete for one station.
      if (existing && connectedDsIps.has(existing.dsIp)) return;
      if (existing) await removeDnatRule(station); // Current DS disconnected, swap to new one
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

    // Clean up DNAT and blocked DS rules when stations are deconfigured or team changes
    radioManager.addConfigChangeListener(() => {
      for (const [station, existing] of [...activeDnatRules]) {
        const team = radioManager.getTeamForStation(station);
        if (team === null || teamGatewayIp(team) !== existing.gatewayIp) {
          removeDnatRule(station).catch(err => {
            console.error(`Failed to remove DNAT rule for ${station}:`, err);
          });
          unblockAllDS(station).catch(err => {
            console.error(`Failed to unblock DSes for ${station}:`, err);
          });
          acceptedDsForStation.delete(station);
          matchEngine.clearDSAddress(station);
        }
      }
    });

    runFMS().then(fms => {
      if (!fms) return;

      fms.on('dsConnected', ({ address }) => connectedDsIps.add(address));
      fms.on('dsDisconnected', ({ address }) => {
        connectedDsIps.delete(address);
        // Clean up blocked/primary DS state when a DS disconnects
        for (const [station, rule] of [...activeDnatRules]) {
          if (rule.dsIp === address) {
            // Primary DS disconnected — clear accepted state and unblock all.
            // Blocked DSes will compete on their next heartbeat via trySetDSAddress.
            acceptedDsForStation.delete(station);
            unblockAllDS(station).catch(err => {
              console.error(`Failed to unblock DSes for ${station}:`, err);
            });
          }
        }
        for (const [station, stationBlocks] of [...blockedDsRules]) {
          if (stationBlocks.has(address)) {
            // Blocked DS disconnected — clean up its FORWARD DROP rule
            unblockDS(station, address).catch(err => {
              console.error(`Failed to unblock DS ${address} for ${station}:`, err);
            });
          }
        }
      });

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

        // Respect DS disable/e-stop from UDP heartbeats.
        // The team must always be able to disable their robot.
        if ('BatteryVoltage' in msg.data) {
          const udp = msg.data as import('./fmsServer.js').UdpMessage;
          const station = radioManager.getStationForTeam(udp.teamNumber);
          if (station) {
            matchEngine.dsReportedStatus(station, udp.status.enabled, udp.status.EStop);
          }
        }

        // Auto-discover DS addresses for the match engine.
        // Match on any message carrying teamNumber — TCP 0x18 and UDP both do.
        if ('teamNumber' in msg.data) {
          const { teamNumber } = msg.data;
          // TCP remoteAddress may be IPv6-mapped (::ffff:10.x.x.x) — normalize to plain IPv4
          const address = msg.address.replace(/^::ffff:/, '');

          // Ignore connections from team subnets (10.TE.AM.x) — these are devices on
          // the robot network (roboRIO, coprocessors), not Driver Stations.
          // Only guest-network IPs should be treated as DSes.
          if (isTeamSubnetAddress(address)) return;

          if (VlanInterface && radioManager.isTeamDuplicated(teamNumber)) {
            // Same team on multiple stations — use the kernel neighbor (ARP) table
            // to determine which VLAN interface (and thus station) the packet came from.
            resolveStationByNeighbor(address, VlanInterface)
              .then(station => {
                station ??= radioManager.getStationForTeam(teamNumber);
                if (station) {
                  if (!trySetDSAddress(station, address)) return; // Blocked as duplicate
                  addDnatRule(station, address);
                  if (!checksTriggered.has(station)) {
                    checksTriggered.add(station);
                    checksRetryCount.delete(station);
                    setTimeout(() => triggerTeamChecks(station, teamNumber), 2000);
                  }
                }
              })
              .catch(err => {
                console.error('DS address discovery failed:', err);
              });
          } else {
            // Common case: unique team numbers — direct lookup, no subprocess needed
            const station = radioManager.getStationForTeam(teamNumber);
            if (station) {
              if (!trySetDSAddress(station, address)) return; // Blocked as duplicate
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
      robotTestMonitor?.stop();
      robotPacketCapture?.stop();
      stopAllDHCP();
      console.log('Cleaning up network rules...');
      const flushRouteTables = Promise.all(
        Object.values(vlanMap).map(id => execFile('ip', ['route', 'flush', 'table', String(id)]).catch(() => {})),
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
      robotTestMonitor?.stop();
      robotPacketCapture?.stop();
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
