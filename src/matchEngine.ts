import dgram from 'dgram';
import { makeDSPacket, Control, UdpSendPort, type OutboundTag } from './fmsServer.js';
import {
  Alliance,
  MatchPhase,
  MatchConfig,
  MatchSlot,
  MatchState,
  MatchEndReason,
  StationName,
  StationNameList,
  StationNumber,
  StationControlState,
} from './types.js';
import { appWarn, appError } from './appLogger.js';

const TICK_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 200;
const MAX_PERIOD = 300;
const MAX_PAUSE = 10;
const POST_MATCH_DISPLAY_MS = 3000;

// 2026 REBUILT match timing:
// Auto: 20s, Pause: ~3s (scoring assessment), Teleop: 110s (10s transition + 4×25s shifts), Endgame: 30s
const DEFAULT_CONFIG: MatchConfig = {
  autoDuration: 20,
  teleopDuration: 110,
  endgameDuration: 30,
  pauseDuration: 3,
  skipAuto: false,
  autoWinner: 'scores',
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export type TeamResolver = (station: StationName) => number | null;

export class MatchEngine {
  private phase: MatchPhase = 'idle';
  private config: MatchConfig | null = null;
  private pendingConfig: MatchConfig = { ...DEFAULT_CONFIG };
  private remainingTime = 0;
  private totalMatchTime = 0;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastTickTime = 0;
  private prePausePhase: MatchPhase | null = null;
  private sequenceNumbers = new Map<StationName, number>();
  private stationStates = new Map<StationName, StationControlState>();
  private dsConnections = new Map<StationName, { ip: string; lastSeen: number; blockedDsIps?: string[] }>();
  private udpSocket: dgram.Socket;
  private listeners: ((state: MatchState) => void)[] = [];
  private matchNumber = 0;
  private endReason: MatchEndReason | undefined;
  private teamResolver: TeamResolver;
  /** Maps physical station → alliance match slot during an active match */
  private portToSlot = new Map<StationName, MatchSlot>();
  /** Which alliance won auto (computed after auto ends) */
  private autoWinnerAlliance: Alliance | null = null;
  /** Optional callback to get auto-period scores for auto winner determination.
   *  Returns { red: number, blue: number } totals. */
  private autoScoreResolver?: () => { red: number; blue: number };

  constructor(teamResolver?: TeamResolver) {
    this.teamResolver = teamResolver ?? (() => null);
    this.udpSocket = dgram.createSocket('udp4');
    for (const station of StationNameList) {
      this.stationStates.set(station, {
        teamNumber: null,
        enabled: false,
        eStop: false,
        mode: 'teleOp',
        joined: false,
        ready: false,
        alliance: null,
        matchSlot: null,
      });
      this.sequenceNumbers.set(station, 0);
    }
    setInterval(() => this.sendJoinedHeartbeat(), HEARTBEAT_INTERVAL_MS);

    // Sweep stale DS connections — if no packet in 20s (~3 missed heartbeats), clear
    setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [station, conn] of this.dsConnections) {
        if (now - conn.lastSeen > 20_000) {
          this.dsConnections.delete(station);
          changed = true;
          console.log(`DS stale: ${station} (last seen ${Math.round((now - conn.lastSeen) / 1000)}s ago)`);
        }
      }
      if (changed) this.broadcast();
    }, 5_000);
  }

  setDSAddress(station: StationName, ip: string) {
    const now = Date.now();
    const existing = this.dsConnections.get(station);
    const ipChanged = !existing || existing.ip !== ip;
    // Always update lastSeen, but only broadcast when the IP changed or
    // enough time has passed to warrant a UI heartbeat update (~2s debounce).
    this.dsConnections.set(station, { ip, lastSeen: now, blockedDsIps: existing?.blockedDsIps });
    if (ipChanged || !existing || now - existing.lastSeen >= 2_000) {
      this.broadcast();
    }
  }

  setBlockedDS(station: StationName, blockedIps: string[] | undefined) {
    const existing = this.dsConnections.get(station);
    if (!existing) return;
    existing.blockedDsIps = blockedIps;
    this.broadcast();
  }

  clearDSAddress(station: StationName) {
    if (!this.dsConnections.has(station)) return;
    this.dsConnections.delete(station);
    this.broadcast();
  }

  /** Set callback used to determine auto winner from scoring data. */
  setAutoScoreResolver(resolver: () => { red: number; blue: number }) {
    this.autoScoreResolver = resolver;
  }

  // ── Station self-service ──────────────────────────────────────────

  /** @deprecated Use joinStationAlliance() instead. Kept for backward compatibility. */
  joinStation(station: StationName) {
    // Infer alliance from the station name prefix (backward compat)
    const alliance: Alliance = station.startsWith('red') ? 'red' : 'blue';
    this.joinStationAlliance(station, alliance);
  }

  /** Join a station to a specific alliance (decoupled from physical port). */
  joinStationAlliance(station: StationName, alliance: Alliance) {
    if (this.isMatchActive()) {
      appWarn(`Cannot join station ${station} during an active match`);
      return;
    }
    // Enforce max 3 per alliance
    const allianceCount = [...this.stationStates.values()].filter(s => s.joined && s.alliance === alliance).length;
    if (allianceCount >= 3) {
      appWarn(`Cannot join ${station} to ${alliance}: alliance already has 3 stations`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (state.joined) {
      // Already joined — allow changing alliance if not ready
      if (state.alliance !== alliance) {
        state.alliance = alliance;
        state.ready = false;
        state.matchSlot = null;
        console.log(`Station ${station} switched to ${alliance} alliance`);
        this.broadcast();
      }
      return;
    }
    state.joined = true;
    state.ready = false;
    state.alliance = alliance;
    state.matchSlot = null;
    console.log(`Station ${station} joined ${alliance} alliance`);
    this.broadcast();
  }

  leaveStation(station: StationName) {
    if (this.isMatchActive()) {
      appWarn(`Cannot leave station ${station} during an active match`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) return;
    state.joined = false;
    state.ready = false;
    state.alliance = null;
    state.matchSlot = null;
    console.log(`Station ${station} left match system`);
    this.broadcast();
  }

  setReady(station: StationName, ready: boolean) {
    if (this.isMatchActive()) {
      appWarn(`Cannot change ready state for ${station} during an active match`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) {
      appWarn(`Station ${station} is not joined, cannot set ready`);
      return;
    }
    state.ready = ready;
    console.log(`Station ${station} ready: ${ready}`);
    this.broadcast();
  }

  updateMatchConfig(config: MatchConfig) {
    if (this.isMatchActive()) {
      appWarn('Cannot update match config during an active match');
      return;
    }
    const teleopDuration = clamp(config.teleopDuration, 0, MAX_PERIOD);
    this.pendingConfig = {
      autoDuration: clamp(config.autoDuration, 0, MAX_PERIOD),
      teleopDuration,
      endgameDuration: clamp(config.endgameDuration, 0, teleopDuration),
      pauseDuration: clamp(config.pauseDuration, 0, MAX_PAUSE),
      skipAuto: config.skipAuto ?? false,
      autoWinner: config.autoWinner ?? 'scores',
    };
    // Changing config invalidates all ready states
    for (const state of this.stationStates.values()) {
      state.ready = false;
    }
    console.log('Match config updated:', this.pendingConfig);
    this.broadcast();
  }

  startMatch() {
    if (this.phase !== 'idle' && this.phase !== 'postMatch') {
      appWarn(`Cannot start match in phase ${this.phase}`);
      return;
    }

    const joinedStations = StationNameList.filter(s => this.stationStates.get(s)!.joined);
    if (joinedStations.length === 0) {
      appWarn('No stations have joined, cannot start match');
      return;
    }
    if (!joinedStations.every(s => this.stationStates.get(s)!.ready)) {
      appWarn('Not all joined stations are ready, cannot start match');
      return;
    }

    this.config = { ...this.pendingConfig };
    this.matchNumber++;
    this.totalMatchTime = 0;
    this.endReason = undefined;
    this.autoWinnerAlliance = null;

    // Compute portToSlot mapping: assign each joined station to an alliance slot
    this.portToSlot.clear();
    const redStations = joinedStations.filter(s => this.stationStates.get(s)!.alliance === 'red');
    const blueStations = joinedStations.filter(s => this.stationStates.get(s)!.alliance === 'blue');
    for (let i = 0; i < redStations.length; i++) {
      const slot = `red${(i + 1) as StationNumber}` as MatchSlot;
      this.portToSlot.set(redStations[i], slot);
      this.stationStates.get(redStations[i])!.matchSlot = slot;
    }
    for (let i = 0; i < blueStations.length; i++) {
      const slot = `blue${(i + 1) as StationNumber}` as MatchSlot;
      this.portToSlot.set(blueStations[i], slot);
      this.stationStates.get(blueStations[i])!.matchSlot = slot;
    }

    // Handle skipAuto: if enabled, start directly in countdown → teleop
    const effectiveAutoDuration = this.config.skipAuto ? 0 : this.config.autoDuration;
    const effectivePauseDuration = this.config.skipAuto ? 0 : this.config.pauseDuration;

    this.phase = 'countdown';
    this.remainingTime = 3;

    for (const station of StationNameList) {
      const teamNumber = this.teamResolver(station);
      const state = this.stationStates.get(station)!;
      state.teamNumber = teamNumber;
      state.enabled = false;
      state.eStop = false;
      state.mode = joinedStations.includes(station) ? (effectiveAutoDuration > 0 ? 'auto' : 'teleOp') : 'teleOp';
    }

    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);

    console.log(
      `Match ${this.matchNumber} started with stations: ${joinedStations.join(', ')} ` +
        `(red: ${redStations.join(',')}, blue: ${blueStations.join(',')})`,
    );
    this.broadcast();
  }

  stopMatch() {
    if (this.phase === 'idle' || this.phase === 'postMatch') return;
    this.disableAll();
    this.endReason = 'stopped';
    this.phase = 'postMatch';
    this.stopTick();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} stopped early`);
    this.broadcast();
    this.schedulePostMatchReset();
  }

  pauseMatch() {
    if (this.phase !== 'auto' && this.phase !== 'teleop' && this.phase !== 'endgame') {
      appWarn(`Cannot pause match in phase ${this.phase}`);
      return;
    }
    this.prePausePhase = this.phase;
    this.phase = 'paused';
    this.stopTick();
    this.disableAll();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} paused (was in ${this.prePausePhase})`);
    this.broadcast();
  }

  resumeMatch() {
    if (this.phase !== 'paused') {
      appWarn('Cannot resume: match is not paused');
      return;
    }
    this.phase = this.prePausePhase ?? 'teleop';
    this.prePausePhase = null;
    this.enableParticipating(this.phase === 'auto' ? 'auto' : 'teleOp');
    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    console.log(`Match ${this.matchNumber} resumed (phase: ${this.phase})`);
    this.broadcast();
  }

  abandonMatch() {
    if (this.phase !== 'paused') {
      appWarn('Cannot abandon: match is not paused');
      return;
    }
    this.disableAll();
    this.endReason = 'abandoned';
    this.prePausePhase = null;
    this.config = null;
    this.phase = 'idle';
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    for (const state of this.stationStates.values()) {
      state.ready = false;
      state.matchSlot = null;
      // joined + alliance stay as-is — teams must leave manually
    }
    console.log(`Match ${this.matchNumber} abandoned`);
    this.broadcast();
  }

  globalEStop() {
    for (const station of StationNameList) {
      const state = this.stationStates.get(station)!;
      state.eStop = true;
      state.enabled = false;
    }
    this.endReason = 'estop';
    this.phase = 'postMatch';
    this.stopTick();
    // Send e-stop packets to ALL stations with known DS addresses, not just joined
    for (const station of StationNameList) {
      this.sendDSPacket(station);
    }
    console.log('Global E-Stop triggered');
    this.broadcast();
    this.schedulePostMatchReset();
  }

  stationEStop(station: StationName) {
    const state = this.stationStates.get(station)!;
    state.eStop = true;
    state.enabled = false;
    console.log(`E-Stop: ${station}`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  stationDisable(station: StationName) {
    const state = this.stationStates.get(station)!;
    state.enabled = false;
    console.log(`Disabled: ${station}`);
    this.sendDSPacket(station);
    this.broadcast();
  }

  /** Called when a DS reports disable or e-stop in its UDP heartbeat.
   *  The team always has the right to disable/e-stop their robot. */
  dsReportedStatus(station: StationName, dsEnabled: boolean, dsEStop: boolean) {
    const state = this.stationStates.get(station);
    if (!state) return;
    let changed = false;
    if (dsEStop && !state.eStop) {
      state.eStop = true;
      state.enabled = false;
      console.log(`DS e-stop reported: ${station}`);
      changed = true;
    } else if (!dsEnabled && state.enabled) {
      state.enabled = false;
      console.log(`DS disable reported: ${station}`);
      changed = true;
    }
    if (changed) {
      this.sendDSPacket(station);
      this.broadcast();
    }
  }

  clearEStop(station?: StationName) {
    if (station) {
      const state = this.stationStates.get(station)!;
      state.eStop = false;
      console.log(`E-Stop cleared: ${station}`);
    } else {
      for (const s of StationNameList) {
        this.stationStates.get(s)!.eStop = false;
      }
      console.log('All E-Stops cleared');
    }
    this.broadcast();
  }

  isMatchActive(): boolean {
    return this.phase !== 'idle' && this.phase !== 'postMatch';
  }

  addStateListener(fn: (state: MatchState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  getState(): MatchState {
    const stationStates: Partial<Record<StationName, StationControlState>> = {};
    for (const station of StationNameList) {
      const state = { ...this.stationStates.get(station)! };
      // When idle, resolve live team numbers; during a match, use the snapshot
      if (!this.isMatchActive()) state.teamNumber = this.teamResolver(station);
      stationStates[station] = state;
    }

    return {
      type: 'matchState',
      phase: this.phase,
      remainingTime: Math.max(0, this.remainingTime),
      totalMatchTime: this.totalMatchTime,
      // Always expose config so clients can show/edit pending timing
      config: this.config ?? this.pendingConfig,
      stationStates,
      connectedStations: Object.fromEntries(this.dsConnections),
      endReason: this.phase === 'postMatch' ? this.endReason : undefined,
      portToSlot: this.portToSlot.size > 0 ? Object.fromEntries(this.portToSlot) : undefined,
      autoWinnerAlliance: this.autoWinnerAlliance,
    };
  }

  // ── Private ───────────────────────────────────────────────────────

  private tick() {
    const now = Date.now();
    const elapsed = (now - this.lastTickTime) / 1000;
    this.lastTickTime = now;

    this.remainingTime -= elapsed;
    this.totalMatchTime += elapsed;

    this.transition();
    this.sendPacketsToAll();
    this.broadcast();
  }

  private transition() {
    if (!this.config) return;
    if (this.remainingTime > 0) {
      // Check for endgame transition (within teleop)
      if (this.phase === 'teleop' && this.remainingTime <= this.config.endgameDuration) {
        this.phase = 'endgame';
        console.log('Endgame started');
      }
      return;
    }

    // Phase expired — move to next
    switch (this.phase) {
      case 'countdown':
        if (this.config.skipAuto || this.config.autoDuration <= 0) {
          // Skip auto — go straight to teleop
          this.phase = 'teleop';
          this.remainingTime = this.config.teleopDuration;
          this.enableParticipating('teleOp');
          console.log('Teleop period started (auto skipped)');
        } else {
          this.phase = 'auto';
          this.remainingTime = this.config.autoDuration;
          this.enableParticipating('auto');
          console.log('Autonomous period started');
        }
        break;

      case 'auto':
        // Auto just ended — compute auto winner
        this.computeAutoWinner();

        if (this.config.pauseDuration > 0) {
          this.phase = 'autoPause';
          this.remainingTime = this.config.pauseDuration;
          this.disableAll();
          console.log('Auto-to-teleop pause');
        } else {
          // Skip pause — go straight to teleop
          this.phase = 'teleop';
          this.remainingTime = this.config.teleopDuration;
          this.enableParticipating('teleOp');
          console.log('Teleop period started (pause skipped)');
        }
        break;

      case 'autoPause':
        this.phase = 'teleop';
        this.remainingTime = this.config.teleopDuration;
        this.enableParticipating('teleOp');
        console.log('Teleop period started');
        break;

      case 'teleop':
      case 'endgame':
        this.endReason = 'normal';
        this.phase = 'postMatch';
        this.remainingTime = 0;
        this.disableAll();
        this.stopTick();
        console.log('Match complete');
        this.schedulePostMatchReset();
        break;
    }
  }

  /** Determine which alliance won the autonomous period. */
  private computeAutoWinner() {
    if (!this.config) return;
    const mode = this.config.autoWinner ?? 'scores';

    if (mode === 'red') {
      this.autoWinnerAlliance = 'red';
      console.log('Auto winner: RED (manual override)');
    } else if (mode === 'blue') {
      this.autoWinnerAlliance = 'blue';
      console.log('Auto winner: BLUE (manual override)');
    } else {
      // 'scores' mode — use scoring engine
      if (this.autoScoreResolver) {
        try {
          const scores = this.autoScoreResolver();
          if (scores.red > scores.blue) {
            this.autoWinnerAlliance = 'red';
          } else if (scores.blue > scores.red) {
            this.autoWinnerAlliance = 'blue';
          } else {
            // Tie — no winner (stays null). FMS would assign randomly; we leave it undecided.
            this.autoWinnerAlliance = null;
          }
          console.log(
            `Auto winner: ${this.autoWinnerAlliance ?? 'TIE'} (scores: red=${scores.red}, blue=${scores.blue})`,
          );
        } catch (err) {
          appError(`Auto score resolver failed: ${err}`);
          this.autoWinnerAlliance = null;
        }
      } else {
        this.autoWinnerAlliance = null;
        console.log('Auto winner: undetermined (no score resolver)');
      }
    }
  }

  private schedulePostMatchReset() {
    setTimeout(() => {
      if (this.phase !== 'postMatch') return;
      this.config = null;
      this.phase = 'idle';
      this.portToSlot.clear();
      this.autoWinnerAlliance = null;
      for (const state of this.stationStates.values()) {
        state.ready = false;
        state.matchSlot = null;
        // joined + alliance stay as-is — teams must leave manually to get free-drive back
      }
      console.log('Post-match reset complete');
      this.broadcast();
    }, POST_MATCH_DISPLAY_MS);
  }

  private sendJoinedHeartbeat() {
    // Only send when no match is active; the tick handles match phases
    if (this.isMatchActive()) return;
    for (const station of StationNameList) {
      if (this.stationStates.get(station)!.joined) {
        this.sendDSPacket(station);
      }
    }
  }

  private enableParticipating(mode: 'auto' | 'teleOp') {
    for (const station of StationNameList) {
      const state = this.stationStates.get(station)!;
      if (state.joined && !state.eStop) {
        state.enabled = true;
        state.mode = mode;
      }
    }
  }

  /** Send a raw control packet to an arbitrary IP. Used for duplicate DS blocking. */
  sendRawControlPacket(ip: string, station: StationName, tags: OutboundTag[] = []) {
    const seq = (this.sequenceNumbers.get(station) ?? 0) + 1;
    this.sequenceNumbers.set(station, seq);

    const control = new Control(false, false, 'teleOp'); // disabled, not e-stopped

    const allianceStation = (this.portToSlot.get(station) ?? station) as StationName;
    const packet = makeDSPacket({
      sequence: seq & 0xffff,
      control,
      allianceStation,
      tournamentLevel: 'Practice',
      matchNumber: 0,
      playNumber: 0,
      matchTime: new Date(),
      remainingTime: 0,
      tags,
    });

    this.udpSocket.send(packet, 0, packet.length, UdpSendPort, ip, err => {
      if (err) appError(`Failed to send control packet to ${ip}: ${err.message}`);
    });
  }

  private disableAll() {
    for (const station of StationNameList) {
      this.stationStates.get(station)!.enabled = false;
    }
  }

  private stopTick() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private sendPacketsToAll() {
    for (const station of StationNameList) {
      if (this.stationStates.get(station)!.joined) {
        this.sendDSPacket(station);
      }
    }
  }

  private sendDSPacket(station: StationName) {
    const ip = this.dsConnections.get(station)?.ip;
    if (!ip) return;

    const state = this.stationStates.get(station)!;
    const seq = (this.sequenceNumbers.get(station) ?? 0) + 1;
    this.sequenceNumbers.set(station, seq);

    // Never send the e-stop bit to the DS — always use disable.
    // E-stop is a backend-only state that prevents re-enabling.
    const control = new Control(false, state.enabled && !state.eStop, state.mode);

    // Use the portToSlot mapping for the alliance station byte if available.
    // This is the critical decoupling: the DS sees the alliance position, not the physical port.
    const allianceStation = (this.portToSlot.get(station) ?? station) as StationName;

    // Build game data tags — during teleop/endgame, send the auto winner character
    // per REBUILT game rules: 'R' = red's goal inactive first, 'B' = blue's goal inactive first
    const tags: OutboundTag[] = [];
    if (
      this.autoWinnerAlliance &&
      (this.phase === 'teleop' || this.phase === 'endgame' || this.phase === 'autoPause')
    ) {
      tags.push({ type: 'gameData', data: this.autoWinnerAlliance === 'red' ? 'R' : 'B' });
    }

    const packet = makeDSPacket({
      sequence: seq & 0xffff,
      control,
      allianceStation,
      tournamentLevel: 'Practice',
      matchNumber: this.matchNumber,
      playNumber: 1,
      matchTime: new Date(),
      remainingTime: Math.max(0, Math.round(this.remainingTime)),
      tags,
    });

    this.udpSocket.send(packet, 0, packet.length, UdpSendPort, ip, err => {
      if (err) appError(`Failed to send DS packet to ${station} (${ip}): ${err.message}`);
    });
  }

  private broadcast() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in match state listener:', err);
      }
    }
  }
}
