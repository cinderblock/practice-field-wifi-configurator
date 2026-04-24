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
/** Post-match scoring delay for balls in flight (up to 3s per rules) */
const POST_MATCH_COUNT_SECONDS = 3;

// Official 2026 REBUILT match timing (fixed — not user-adjustable)
// Teleop = transition (10s) + 4 shifts (25s each) + endgame (30s) = 140s
const OFFICIAL_CONFIG: MatchConfig = {
  autoDuration: 20,
  teleopDuration: 140,
  endgameDuration: 30,
  pauseDuration: 3,
  skipAuto: false,
  autoWinner: 'scores',
};

export type TeamResolver = (station: StationName) => number | null;

export class MatchEngine {
  private phase: MatchPhase = 'idle';
  private config: MatchConfig | null = null;
  private pendingConfig: MatchConfig = { ...OFFICIAL_CONFIG };
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

  // ── Match lifecycle (controller actions) ────────────────────────────

  /** Create a new match — transitions to 'created' phase where stations can join. */
  createMatch() {
    if (this.phase !== 'idle' && this.phase !== 'postMatch') {
      appWarn(`Cannot create match in phase ${this.phase}`);
      return;
    }
    // Reset all station states
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
      state.enabled = false;
      state.eStop = false;
    }
    this.pendingConfig = { ...OFFICIAL_CONFIG };
    this.config = null;
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    this.endReason = undefined;
    this.phase = 'created';
    console.log('Match created — waiting for stations to join');
    this.broadcast();
  }

  /** Cancel a created match — back to idle. */
  cancelMatch() {
    if (this.phase !== 'created') {
      appWarn(`Cannot cancel match in phase ${this.phase}`);
      return;
    }
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
    }
    this.phase = 'idle';
    console.log('Match cancelled');
    this.broadcast();
  }

  /** Swap a station to the opposite alliance (controller only, pre-match). */
  swapStationAlliance(station: StationName) {
    if (this.phase !== 'created') {
      appWarn(`Cannot swap station alliance in phase ${this.phase}`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined || !state.alliance) {
      appWarn(`Station ${station} is not joined to an alliance`);
      return;
    }
    const newAlliance: Alliance = state.alliance === 'red' ? 'blue' : 'red';
    // Enforce max 3 per alliance
    const allianceCount = [...this.stationStates.values()].filter(s => s.joined && s.alliance === newAlliance).length;
    if (allianceCount >= 3) {
      appWarn(`Cannot swap ${station} to ${newAlliance}: alliance already has 3 stations`);
      return;
    }
    state.alliance = newAlliance;
    state.ready = false;
    console.log(`Station ${station} swapped to ${newAlliance} alliance`);
    this.broadcast();
  }

  /** Kick a station from the match (controller only, pre-match). */
  kickStation(station: StationName) {
    if (this.phase !== 'created') {
      appWarn(`Cannot kick station in phase ${this.phase}`);
      return;
    }
    const state = this.stationStates.get(station)!;
    if (!state.joined) {
      appWarn(`Station ${station} is not joined`);
      return;
    }
    state.joined = false;
    state.ready = false;
    state.alliance = null;
    state.matchSlot = null;
    console.log(`Station ${station} kicked from match`);
    this.broadcast();
  }

  /** Set the auto winner manually — used for 'pause' mode during autoPause or skip-auto pre-set. */
  setAutoWinner(winner: Alliance) {
    this.autoWinnerAlliance = winner;
    console.log(`Auto winner set: ${winner}`);

    // If we're in autoPause awaiting a winner, resume the pause countdown
    if (this.phase === 'autoPause' && this.config?.autoWinner === 'pause') {
      // The tick was frozen while waiting — restart it so the pause countdown runs
      this.lastTickTime = Date.now();
      this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
      console.log(`Auto pause countdown resumed (${this.remainingTime.toFixed(1)}s remaining)`);
    }
    this.broadcast();
  }

  // ── Station self-service ──────────────────────────────────────────

  /** @deprecated Use joinStationAlliance() instead. Kept for backward compatibility.
   *  With slot-based naming, defaults to 'red' since alliance can't be inferred from slot name. */
  joinStation(station: StationName) {
    appWarn(`joinStation() is deprecated — use joinStationAlliance() with an explicit alliance`);
    this.joinStationAlliance(station, 'red');
  }

  /** Join a station to a specific alliance (decoupled from physical port). */
  joinStationAlliance(station: StationName, alliance: Alliance) {
    // Only allow joining during 'created' phase
    if (this.phase !== 'created') {
      appWarn(`Cannot join station ${station}: no match created (phase=${this.phase})`);
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

  /** Leave the match. Allowed at any time — during active match, disables robot and returns to free-drive. */
  leaveStation(station: StationName) {
    const state = this.stationStates.get(station)!;
    if (!state.joined) return;

    const wasMatchActive = this.isMatchActive();

    // If match is active, disable the robot immediately
    if (wasMatchActive) {
      state.enabled = false;
      this.sendDSPacket(station);
    }

    state.joined = false;
    state.ready = false;
    state.alliance = null;
    state.matchSlot = null;
    this.portToSlot.delete(station);
    console.log(`Station ${station} left match${wasMatchActive ? ' (mid-match)' : ''}`);

    // If all stations have left during an active match, end it automatically
    if (wasMatchActive && this.getJoinedCount() === 0) {
      this.endMatchEmpty();
      return; // endMatchEmpty broadcasts
    }

    this.broadcast();
  }

  setReady(station: StationName, ready: boolean) {
    if (this.phase !== 'created') {
      appWarn(`Cannot change ready state for ${station} in phase ${this.phase}`);
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

  /** Update match config — only skipAuto and autoWinner are user-settable. Durations are fixed. */
  updateMatchConfig(config: MatchConfig) {
    if (this.phase !== 'created') {
      appWarn(`Cannot update match config in phase ${this.phase}`);
      return;
    }
    // Only accept skipAuto and autoWinner — durations are official
    this.pendingConfig = {
      ...OFFICIAL_CONFIG,
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
    if (this.phase !== 'created') {
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

    // If skipAuto, auto winner must be pre-set
    if (this.pendingConfig.skipAuto) {
      if (
        this.pendingConfig.autoWinner !== 'red' &&
        this.pendingConfig.autoWinner !== 'blue' &&
        !this.autoWinnerAlliance
      ) {
        appWarn('Cannot start match with skipAuto unless auto winner is set to red or blue');
        return;
      }
      // Pre-set the auto winner for skip-auto
      if (this.pendingConfig.autoWinner === 'red' || this.pendingConfig.autoWinner === 'blue') {
        this.autoWinnerAlliance = this.pendingConfig.autoWinner;
      }
    }

    this.config = { ...this.pendingConfig };
    this.matchNumber++;
    this.totalMatchTime = 0;
    this.endReason = undefined;

    // If auto winner was pre-set by 'red'/'blue' mode AND not skipping, clear it (will be computed after auto)
    if (!this.config.skipAuto && (this.config.autoWinner === 'red' || this.config.autoWinner === 'blue')) {
      // Pre-set auto winner is known at start — it'll be applied in computeAutoWinner()
      this.autoWinnerAlliance = null;
    }

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
    if (!this.isMatchActive()) return;
    this.disableAll();
    this.endReason = 'stopped';
    this.phase = 'postMatch';
    this.remainingTime = 0;
    this.stopTick();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} stopped early`);
    this.broadcast();
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
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
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
    this.remainingTime = 0;
    this.stopTick();
    // Send e-stop packets to ALL stations with known DS addresses, not just joined
    for (const station of StationNameList) {
      this.sendDSPacket(station);
    }
    console.log('Global E-Stop triggered');
    this.broadcast();
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
    return this.phase !== 'idle' && this.phase !== 'created' && this.phase !== 'postMatch';
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
      // When not in active match or postMatch, resolve live team numbers; during a match, use the snapshot
      if (!this.isMatchActive() && this.phase !== 'postMatch') state.teamNumber = this.teamResolver(station);
      stationStates[station] = state;
    }

    const awaitingAutoWinner =
      this.phase === 'autoPause' && this.config?.autoWinner === 'pause' && !this.autoWinnerAlliance;

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
      awaitingAutoWinner: awaitingAutoWinner || undefined,
    };
  }

  // ── Private ───────────────────────────────────────────────────────

  private getJoinedCount(): number {
    let count = 0;
    for (const state of this.stationStates.values()) {
      if (state.joined) count++;
    }
    return count;
  }

  /** End match because all stations left. */
  private endMatchEmpty() {
    this.disableAll();
    this.endReason = 'abandoned';
    this.phase = 'postMatch';
    this.remainingTime = 0;
    this.stopTick();
    this.sendPacketsToAll();
    console.log(`Match ${this.matchNumber} ended — all stations left`);
    this.broadcast();
  }

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

    // Handle postMatch counting period (balls in flight)
    if (this.phase === 'postMatch') {
      if (this.remainingTime <= 0) {
        this.remainingTime = 0;
        this.stopTick();
        console.log('Post-match counting period complete');
      }
      return;
    }

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

        if (this.config.pauseDuration > 0 || this.config.autoWinner === 'pause') {
          this.phase = 'autoPause';
          this.remainingTime = this.config.pauseDuration;
          this.disableAll();

          // If awaiting manual winner selection, freeze the countdown
          if (this.config.autoWinner === 'pause' && !this.autoWinnerAlliance) {
            this.stopTick();
            console.log('Auto pause — awaiting manual winner selection (countdown frozen)');
          } else {
            console.log('Auto-to-teleop pause');
          }
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
        this.remainingTime = POST_MATCH_COUNT_SECONDS;
        this.disableAll();
        // Keep tick running for the counting period
        console.log(`Match complete — ${POST_MATCH_COUNT_SECONDS}s counting period`);
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
    } else if (mode === 'pause') {
      // Don't compute — will be set manually by the match controller
      console.log('Auto winner: awaiting manual selection');
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
            // Tie — REBUILT picks randomly
            this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
          }
          const tieNote = scores.red === scores.blue ? ', random tiebreak' : '';
          console.log(
            `Auto winner: ${this.autoWinnerAlliance} (scores: red=${scores.red}, blue=${scores.blue}${tieNote})`,
          );
        } catch (err) {
          appError(`Auto score resolver failed: ${err}`);
          this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
        }
      } else {
        this.autoWinnerAlliance = Math.random() < 0.5 ? 'red' : 'blue';
        console.log(`Auto winner: ${this.autoWinnerAlliance} (random — no score resolver)`);
      }
    }
  }

  /** Manually clear the match — transitions from postMatch → idle. */
  clearMatch() {
    if (this.phase !== 'postMatch') {
      appWarn(`Cannot clear match in phase ${this.phase}`);
      return;
    }
    this.stopTick(); // In case counting period is still running
    this.config = null;
    this.phase = 'idle';
    this.remainingTime = 0;
    this.portToSlot.clear();
    this.autoWinnerAlliance = null;
    this.endReason = undefined;
    for (const state of this.stationStates.values()) {
      state.joined = false;
      state.ready = false;
      state.alliance = null;
      state.matchSlot = null;
    }
    console.log('Match cleared');
    this.broadcast();
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

    // Use portToSlot mapping for the match position byte, falling back to 'red1'
    // for stations not in a match (e.g. duplicate DS blocking outside of match context)
    const allianceStation = this.portToSlot.get(station) ?? ('red1' as MatchSlot);
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
    // Falls back to 'red1' for out-of-match heartbeats — the position byte doesn't matter
    // when disabled, but the protocol requires a valid value.
    const allianceStation = this.portToSlot.get(station) ?? ('red1' as MatchSlot);

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
