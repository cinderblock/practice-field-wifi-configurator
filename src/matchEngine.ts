import dgram from 'dgram';
import { makeDSPacket, Control, UdpSendPort } from './fmsServer.js';
import {
  MatchPhase,
  MatchConfig,
  MatchState,
  MatchEndReason,
  StationName,
  StationNameList,
  StationControlState,
} from './types.js';
import { appWarn, appError } from './appLogger.js';

const TICK_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 200;
const MAX_PERIOD = 300;
const MAX_PAUSE = 10;
const POST_MATCH_DISPLAY_MS = 3000;

const DEFAULT_CONFIG: MatchConfig = {
  autoDuration: 15,
  teleopDuration: 135,
  endgameDuration: 30,
  pauseDuration: 3,
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
  private dsAddresses = new Map<StationName, string>();
  private udpSocket: dgram.Socket;
  private listeners: ((state: MatchState) => void)[] = [];
  private matchNumber = 0;
  private endReason: MatchEndReason | undefined;
  private teamResolver: TeamResolver;

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
      });
      this.sequenceNumbers.set(station, 0);
    }
    setInterval(() => this.sendJoinedHeartbeat(), HEARTBEAT_INTERVAL_MS);
  }

  setDSAddress(station: StationName, ip: string) {
    if (this.dsAddresses.get(station) === ip) return;
    this.dsAddresses.set(station, ip);
    this.broadcast();
  }

  // ── Station self-service ──────────────────────────────────────────

  joinStation(station: StationName) {
    if (this.isMatchActive()) {
      appWarn(`Cannot join station ${station} during an active match`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (state.joined) return;
    state.joined = true;
    state.ready = false;
    console.log(`Station ${station} joined match system`);
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
    this.phase = 'countdown';
    this.remainingTime = 3;

    for (const station of StationNameList) {
      const teamNumber = this.teamResolver(station);
      const state = this.stationStates.get(station)!;
      state.teamNumber = teamNumber;
      state.enabled = false;
      state.eStop = false;
      state.mode = joinedStations.includes(station) ? 'auto' : 'teleOp';
    }

    this.lastTickTime = Date.now();
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);

    console.log(`Match ${this.matchNumber} started with stations: ${joinedStations.join(', ')}`);
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
    for (const state of this.stationStates.values()) {
      state.ready = false;
      // joined stays as-is — teams must leave manually
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
      connectedStations: [...this.dsAddresses.keys()],
      endReason: this.phase === 'postMatch' ? this.endReason : undefined,
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
        this.phase = 'auto';
        this.remainingTime = this.config.autoDuration;
        this.enableParticipating('auto');
        console.log('Autonomous period started');
        break;

      case 'auto':
        this.phase = 'autoPause';
        this.remainingTime = this.config.pauseDuration;
        this.disableAll();
        console.log('Auto-to-teleop pause');
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

  private schedulePostMatchReset() {
    setTimeout(() => {
      if (this.phase !== 'postMatch') return;
      this.config = null;
      this.phase = 'idle';
      for (const state of this.stationStates.values()) {
        state.ready = false;
        // joined stays as-is — teams must leave manually to get free-drive back
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
    const ip = this.dsAddresses.get(station);
    if (!ip) return;

    const state = this.stationStates.get(station)!;
    const seq = (this.sequenceNumbers.get(station) ?? 0) + 1;
    this.sequenceNumbers.set(station, seq);

    const control = new Control(state.eStop, state.enabled, state.mode);

    const packet = makeDSPacket({
      sequence: seq & 0xffff,
      control,
      allianceStation: station,
      tournamentLevel: 'Practice',
      matchNumber: this.matchNumber,
      playNumber: 1,
      matchTime: new Date(),
      remainingTime: Math.max(0, Math.round(this.remainingTime)),
      tags: [],
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
