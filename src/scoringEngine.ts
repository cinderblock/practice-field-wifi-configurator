import {
  Alliance,
  MatchPhase,
  MatchConfig,
  MatchState,
  ScoreEvent,
  ScoreState,
  ScoreBatch,
  ScoringMode,
  ScoringElementConfig,
  ScoringSourceStatus,
  ProcessedScoreEvent,
  AllianceScore,
  ElementScore,
} from './types.js';
import { getAllianceShiftState, getMatchSubPeriod } from './shiftState.js';

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_PHASE_GRACE_SECONDS = 5;
const DEFAULT_BATCH_TIMEOUT_SECONDS = 100;
/** After a goal turns off, scores still count for this many seconds */
const GOAL_GRACE_SECONDS = 3;

function oppositeAlliance(alliance: Alliance): Alliance {
  return alliance === 'red' ? 'blue' : 'red';
}

function emptyAllianceScore(): AllianceScore {
  return { total: 0, elements: {} };
}

let nextEventId = 1;

interface ActiveBatch {
  events: ProcessedScoreEvent[];
  startedAt: number;
  active: boolean; // false = timed out (desaturated on frontend)
}

export class ScoringEngine {
  private events: ProcessedScoreEvent[] = [];
  private sources = new Map<string, ScoringSourceStatus>();
  private elements = new Map<string, ScoringElementConfig>();
  private mode: ScoringMode = 'freePlay';
  private windowSeconds = DEFAULT_WINDOW_SECONDS;
  private phaseGraceSeconds = DEFAULT_PHASE_GRACE_SECONDS;
  private batchTimeoutSeconds = DEFAULT_BATCH_TIMEOUT_SECONDS;
  private currentMatchPhase: MatchPhase = 'idle';
  /** The previous match phase and when it ended — used for grace period attribution */
  private previousPhase: { phase: MatchPhase; endedAt: number } | null = null;
  /** Key: `${element}:${alliance}`, value: timestamp of last counted event */
  private lastDedupTimestamp = new Map<string, number>();
  private windowTimer: NodeJS.Timeout | null = null;
  private windowTimerTarget: number | undefined;

  // ── Batch tracking (free play) ──────────────────────────────────
  private activeBatches: Record<Alliance, ActiveBatch> = {
    red: { events: [], startedAt: 0, active: false },
    blue: { events: [], startedAt: 0, active: false },
  };
  private recentBatches: Record<Alliance, ScoreBatch[]> = { red: [], blue: [] };
  private batchTimers: Record<Alliance, NodeJS.Timeout | null> = { red: null, blue: null };

  // ── Per-alliance match mode ─────────────────────────────────────
  /** Which alliances are in match mode. Empty = all follow the top-level mode. */
  private matchAlliances = new Set<Alliance>();

  // ── Goal-active tracking (REBUILT shift scoring) ────────────────
  /** Last match state received — used to compute shift state at event time */
  private lastMatchRemainingTime = 0;
  private lastMatchStateTime = 0;
  private lastMatchConfig: MatchConfig | null = null;
  private lastAutoWinnerAlliance: Alliance | null = null;
  /** The "game-meaningful" phase for shift computation (survives pauses) */
  private effectivePhaseForShift: MatchPhase = 'idle';

  private autoRegisterLimit = 1;
  private suppressBroadcast = false;
  private listeners: ((state: ScoreState) => void)[] = [];

  /** Set the maximum number of elements that can be auto-registered from incoming events. */
  setAutoRegisterLimit(limit: number): void {
    this.autoRegisterLimit = Math.max(0, Math.round(limit));
  }

  getAutoRegisterLimit(): number {
    return this.autoRegisterLimit;
  }

  /** Submit a score event. Returns the processed event, or 'unknown_element'/'deduplicated' on rejection. */
  submitEvent(event: ScoreEvent): ProcessedScoreEvent | 'unknown_element' | 'deduplicated' {
    let elementConfig = this.elements.get(event.element);
    if (!elementConfig) {
      // Auto-register if under the limit
      const autoCount = [...this.elements.values()].filter(e => e.autoRegistered).length;
      if (autoCount >= this.autoRegisterLimit) {
        return 'unknown_element';
      }
      elementConfig = {
        id: event.element,
        name: event.element,
        pointValue: 1,
        autoRegistered: true,
      };
      this.elements.set(event.element, elementConfig);
    }

    const count = event.count ?? 1;
    const now = Date.now();

    // Update source tracking
    const sourceStatus = this.sources.get(event.source) ?? {
      lastSeen: 0,
      eventCount: 0,
    };
    sourceStatus.lastSeen = now;
    sourceStatus.eventCount++;
    sourceStatus.lastElement = event.element;
    sourceStatus.lastAlliance = event.alliance;
    this.sources.set(event.source, sourceStatus);

    // Check deduplication
    const dedupKey = `${event.element}:${event.alliance}`;
    const dedupWindow = elementConfig.deduplicationWindowMs ?? 0;
    let deduplicated = false;
    if (dedupWindow > 0 && count > 0) {
      const lastTime = this.lastDedupTimestamp.get(dedupKey);
      if (lastTime !== undefined && now - lastTime < dedupWindow) {
        deduplicated = true;
      }
    }

    // Check active phases (match mode only)
    let phaseInactive = false;
    if (this.mode === 'match' && elementConfig.activePhases && elementConfig.activePhases.length > 0) {
      phaseInactive = !elementConfig.activePhases.includes(this.currentMatchPhase);
    }

    const awardedTo = elementConfig.awardToOpponent ? oppositeAlliance(event.alliance) : event.alliance;

    // During the grace period after a phase change, attribute events to the previous phase
    let effectivePhase = this.currentMatchPhase;
    if (
      this.mode === 'match' &&
      this.previousPhase &&
      now - this.previousPhase.endedAt < this.phaseGraceSeconds * 1000
    ) {
      effectivePhase = this.previousPhase.phase;
      if (elementConfig.activePhases && elementConfig.activePhases.length > 0) {
        phaseInactive = !elementConfig.activePhases.includes(effectivePhase);
      }
    }

    // Check goal-active state for match alliances (REBUILT shift scoring)
    let goalInactive = false;
    if (this.matchAlliances.has(awardedTo)) {
      goalInactive = !this.isGoalActive(awardedTo, now);
    }

    // Compute sub-period for period breakdown
    let matchSubPeriod: string | undefined;
    if (this.mode === 'match' && this.matchAlliances.has(awardedTo)) {
      const currentRemaining = this.estimateRemainingTime(now);
      matchSubPeriod =
        getMatchSubPeriod(this.effectivePhaseForShift, currentRemaining, this.lastMatchConfig?.teleopDuration ?? 0) ??
        undefined;
    }

    const processed: ProcessedScoreEvent = {
      id: `evt-${nextEventId++}`,
      source: event.source,
      alliance: event.alliance,
      element: event.element,
      count,
      pointValue: elementConfig.pointValue,
      awardedTo,
      timestamp: now,
      deviceTimestamp: event.timestamp,
      matchPhase: this.mode === 'match' ? effectivePhase : undefined,
      matchSubPeriod,
      deduplicated: deduplicated || phaseInactive,
      goalInactive,
    };

    this.events.push(processed);

    // Update dedup timestamp (only for counted, non-negative events)
    if (!deduplicated && count > 0) {
      this.lastDedupTimestamp.set(dedupKey, now);
    }

    // Handle free play tracking for non-match alliances (or when fully in freePlay)
    if (!this.matchAlliances.has(awardedTo) && !processed.deduplicated) {
      this.addToBatch(awardedTo, processed, now);
      this.ensureWindowTimer();
    }

    this.broadcast();
    return processed.deduplicated ? 'deduplicated' : processed;
  }

  /** Process multiple events with a single broadcast at the end (if any changed state). */
  batch(fn: () => void): void {
    const eventsBefore = this.events.length;
    const elementsBefore = this.elements.size;
    this.suppressBroadcast = true;
    try {
      fn();
    } finally {
      this.suppressBroadcast = false;
      if (this.events.length !== eventsBefore || this.elements.size !== elementsBefore) {
        this.broadcast();
      }
    }
  }

  /** Configure a scoring element. */
  configureElement(config: ScoringElementConfig): void {
    this.elements.set(config.id, config);
    this.broadcast();
  }

  /** Remove a scoring element. */
  removeElement(id: string): void {
    this.elements.delete(id);
    this.broadcast();
  }

  /** Replace all element configurations at once. */
  setElements(configs: ScoringElementConfig[]): void {
    this.elements.clear();
    for (const config of configs) {
      this.elements.set(config.id, config);
    }
    this.broadcast();
  }

  /** Get all configured elements. */
  getElements(): ScoringElementConfig[] {
    return [...this.elements.values()];
  }

  /** Switch scoring mode. */
  setMode(mode: ScoringMode): void {
    this.mode = mode;
    if (mode === 'freePlay') {
      this.lastDedupTimestamp.clear();
      this.matchAlliances.clear();
      this.resetBatches();
    }
    this.broadcast();
  }

  /** Set the sliding window size for free play mode. */
  setWindowSeconds(seconds: number): void {
    this.windowSeconds = Math.max(1, Math.min(300, seconds));
    this.broadcast();
  }

  /** Set the grace period (seconds) for attributing events to the previous match phase. */
  setPhaseGraceSeconds(seconds: number): void {
    this.phaseGraceSeconds = Math.max(0, Math.min(30, seconds));
    this.broadcast();
  }

  /** Set the batch inactivity timeout for free play mode. */
  setBatchTimeoutSeconds(seconds: number): void {
    this.batchTimeoutSeconds = Math.max(1, Math.min(600, seconds));
    this.broadcast();
  }

  /** Reset all scores and events. Sources and element config are preserved. */
  reset(): void {
    this.events = [];
    this.lastDedupTimestamp.clear();
    this.matchAlliances.clear();
    this.resetBatches();
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
      this.windowTimerTarget = undefined;
    }
    this.broadcast();
  }

  /** Full reset: scores, sources, and element config. */
  fullReset(): void {
    this.events = [];
    this.sources.clear();
    this.elements.clear();
    this.lastDedupTimestamp.clear();
    this.matchAlliances.clear();
    this.resetBatches();
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
      this.windowTimerTarget = undefined;
    }
    this.broadcast();
  }

  /** Called by the match engine listener when match state changes. */
  onMatchStateChange(state: MatchState): void {
    const prevPhase = this.currentMatchPhase;
    this.currentMatchPhase = state.phase;

    // Record when the previous phase ended for grace period attribution
    if (prevPhase !== state.phase && prevPhase !== 'idle' && prevPhase !== 'countdown') {
      this.previousPhase = { phase: prevPhase, endedAt: Date.now() };
    }

    // Track match state for shift/goal-active computation
    this.lastMatchRemainingTime = state.remainingTime;
    this.lastMatchStateTime = Date.now();
    this.lastMatchConfig = state.config;
    this.lastAutoWinnerAlliance = state.autoWinnerAlliance ?? null;

    // Track the effective phase for shift computation (survives pauses)
    if (state.phase !== 'paused') {
      this.effectivePhaseForShift = state.phase;
    }

    // Auto-switch to match mode when a match starts
    if ((prevPhase === 'idle' || prevPhase === 'created') && state.phase === 'countdown') {
      this.mode = 'match';

      // Determine which alliances have joined robots
      this.matchAlliances.clear();
      if (state.stationStates) {
        for (const s of Object.values(state.stationStates)) {
          if (s?.joined && s.alliance) this.matchAlliances.add(s.alliance);
        }
      }

      // Clear events and batches only for match alliances
      this.events = this.events.filter(e => !this.matchAlliances.has(e.awardedTo));
      this.lastDedupTimestamp.clear();
      for (const alliance of this.matchAlliances) {
        this.resetBatchForAlliance(alliance);
      }

      this.broadcast();
      return;
    }

    // When match ends and resets to idle, switch back to free play
    if (state.phase === 'idle' && prevPhase === 'postMatch') {
      // Clear events for match alliances
      this.events = this.events.filter(e => !this.matchAlliances.has(e.awardedTo));
      for (const alliance of this.matchAlliances) {
        this.resetBatchForAlliance(alliance);
      }
      this.matchAlliances.clear();
      this.mode = 'freePlay';
      this.broadcast();
      return;
    }

    // Broadcast on any phase change so clients see updated phase info
    if (prevPhase !== state.phase) {
      this.broadcast();
    }
  }

  /** Register a listener for state changes. Returns an unsubscribe function. */
  addStateListener(fn: (state: ScoreState) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const idx = this.listeners.indexOf(fn);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Get the current score state. */
  getState(): ScoreState {
    const state: ScoreState = {
      type: 'scoreState',
      mode: this.mode,
      windowSeconds: this.windowSeconds,
      autoRegisterLimit: this.autoRegisterLimit,
      phaseGraceSeconds: this.phaseGraceSeconds,
      batchTimeoutSeconds: this.batchTimeoutSeconds,
      red: emptyAllianceScore(),
      blue: emptyAllianceScore(),
      sources: Object.fromEntries(this.sources),
      elements: Object.fromEntries(this.elements),
    };

    // Compute scores per alliance based on their individual mode
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      if (this.matchAlliances.has(alliance)) {
        // Match mode: cumulative scores (excluding goalInactive)
        state[alliance] = this.calculateMatchScore(alliance);
      } else {
        // Free play mode: active batch scores
        state[alliance] = this.calculateBatchScore(alliance);
      }
    }

    // Batch activity for freeplay alliances
    if (!this.matchAlliances.has('red')) {
      state.redBatchActive = this.activeBatches.red.active;
    }
    if (!this.matchAlliances.has('blue')) {
      state.blueBatchActive = this.activeBatches.blue.active;
    }

    // Recent batches for freeplay alliances
    state.recentBatches = {
      red: this.matchAlliances.has('red') ? [] : this.recentBatches.red,
      blue: this.matchAlliances.has('blue') ? [] : this.recentBatches.blue,
    };

    // Sliding window for freeplay alliances
    if (!this.matchAlliances.has('red') || !this.matchAlliances.has('blue')) {
      state.slidingWindow = {
        red: this.matchAlliances.has('red') ? emptyAllianceScore() : this.calculateSlidingWindowScore('red'),
        blue: this.matchAlliances.has('blue') ? emptyAllianceScore() : this.calculateSlidingWindowScore('blue'),
      };
    }

    // Match-specific data when any alliance is in match mode
    if (this.matchAlliances.size > 0) {
      state.matchPhase = this.currentMatchPhase;
      state.matchAlliances = [...this.matchAlliances];
      state.phaseBreakdown = this.calculatePhaseBreakdown();
      state.periodBreakdown = this.calculatePeriodBreakdown();
      state.inactiveScores = {
        red: this.matchAlliances.has('red') ? this.calculateInactiveScore('red') : emptyAllianceScore(),
        blue: this.matchAlliances.has('blue') ? this.calculateInactiveScore('blue') : emptyAllianceScore(),
      };
    }

    return state;
  }

  // ── Goal-active computation (REBUILT shift scoring) ─────────────

  /** Estimate the current remaining time by interpolating from the last server update. */
  private estimateRemainingTime(now: number): number {
    const elapsed = (now - this.lastMatchStateTime) / 1000;
    return this.currentMatchPhase === 'paused'
      ? this.lastMatchRemainingTime
      : Math.max(0, this.lastMatchRemainingTime - elapsed);
  }

  /**
   * Determine if an alliance's goal is currently active (scores should count).
   * Returns true if:
   * - Not in teleop shift territory, OR
   * - This alliance's goal is the active one, OR
   * - The goal turned off within the last GOAL_GRACE_SECONDS
   */
  private isGoalActive(alliance: Alliance, now: number): boolean {
    const phase = this.effectivePhaseForShift;
    const config = this.lastMatchConfig;
    if (!config) return true;

    // During non-teleop phases, both goals are active
    if (phase !== 'teleop') return true;

    const currentRemaining = this.estimateRemainingTime(now);

    // Check if this alliance's goal is currently inactive
    const inactiveNow = getAllianceShiftState(
      'teleop',
      currentRemaining,
      config.teleopDuration,
      config.endgameDuration,
      this.lastAutoWinnerAlliance,
    );

    // If both active or this alliance is not the inactive one, goal is active
    if (inactiveNow !== alliance) return true;

    // This alliance's goal is currently inactive — check 3-second grace period.
    // Look at what the shift state was GOAL_GRACE_SECONDS ago:
    // if this alliance wasn't inactive then, we're within the grace window.
    const graceRemaining = currentRemaining + GOAL_GRACE_SECONDS;
    const inactiveAtGrace = getAllianceShiftState(
      'teleop',
      graceRemaining,
      config.teleopDuration,
      config.endgameDuration,
      this.lastAutoWinnerAlliance,
    );

    // If this alliance wasn't inactive at the grace point, the deactivation
    // happened less than GOAL_GRACE_SECONDS ago — scores still count.
    return inactiveAtGrace !== alliance;
  }

  // ── Batch management (free play) ────────────────────────────────

  /** Add an event to the active batch for the given alliance, starting a new batch if needed. */
  private addToBatch(alliance: Alliance, event: ProcessedScoreEvent, now: number): void {
    const batch = this.activeBatches[alliance];

    // If the batch is inactive (timed out), archive it and start fresh
    if (!batch.active && batch.events.length > 0) {
      this.archiveBatch(alliance, now);
    }

    // Start a new batch if empty
    if (batch.events.length === 0) {
      batch.startedAt = now;
    }

    batch.events.push(event);
    batch.active = true;

    // Reset the inactivity timer for this alliance
    this.resetBatchTimer(alliance);
  }

  /** Move the active batch to recentBatches. */
  private archiveBatch(alliance: Alliance, now: number): void {
    const batch = this.activeBatches[alliance];
    if (batch.events.length === 0) return;

    const score = this.calculateBatchScore(alliance);
    if (score.total > 0) {
      this.recentBatches[alliance].unshift({
        total: score.total,
        elements: score.elements,
        startedAt: batch.startedAt,
        endedAt: now,
      });
      // Keep only last 5
      if (this.recentBatches[alliance].length > 5) {
        this.recentBatches[alliance].pop();
      }
    }

    // Clear the active batch
    batch.events = [];
    batch.startedAt = 0;
    batch.active = false;
  }

  /** Reset/start the inactivity timer for an alliance's batch. */
  private resetBatchTimer(alliance: Alliance): void {
    if (this.batchTimers[alliance]) {
      clearTimeout(this.batchTimers[alliance]!);
    }
    this.batchTimers[alliance] = setTimeout(() => {
      this.batchTimers[alliance] = null;
      this.archiveBatch(alliance, Date.now());
      this.broadcast();
    }, this.batchTimeoutSeconds * 1000);
  }

  /** Clear all batch state. */
  private resetBatches(): void {
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      this.resetBatchForAlliance(alliance);
    }
    this.recentBatches = { red: [], blue: [] };
  }

  /** Clear batch state for a single alliance. */
  private resetBatchForAlliance(alliance: Alliance): void {
    if (this.batchTimers[alliance]) {
      clearTimeout(this.batchTimers[alliance]!);
      this.batchTimers[alliance] = null;
    }
    this.activeBatches[alliance] = { events: [], startedAt: 0, active: false };
    this.recentBatches[alliance] = [];
  }

  /** Calculate score for the active batch of an alliance. */
  private calculateBatchScore(alliance: Alliance): AllianceScore {
    const batch = this.activeBatches[alliance];
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of batch.events) {
      if (event.deduplicated) continue;
      if (event.awardedTo !== alliance) continue;

      const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
      el.count += event.count;
      el.points += event.count * event.pointValue;
      el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
      elements[event.element] = el;
      total += event.count * event.pointValue;
    }

    return { total, elements };
  }

  /** Calculate sliding window score for secondary display. */
  private calculateSlidingWindowScore(alliance: Alliance): AllianceScore {
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of this.events) {
      if (event.deduplicated) continue;
      if (event.awardedTo !== alliance) continue;
      if (now - event.timestamp > windowMs) continue;

      const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
      el.count += event.count;
      el.points += event.count * event.pointValue;
      el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
      elements[event.element] = el;
      total += event.count * event.pointValue;
    }

    return { total, elements };
  }

  /** Calculate cumulative match score for an alliance (excluding goalInactive events). */
  private calculateMatchScore(alliance: Alliance): AllianceScore {
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of this.events) {
      if (event.deduplicated) continue;
      if (event.goalInactive) continue;
      if (event.awardedTo !== alliance) continue;

      const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
      el.count += event.count;
      el.points += event.count * event.pointValue;
      el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
      elements[event.element] = el;
      total += event.count * event.pointValue;
    }

    return { total, elements };
  }

  /** Calculate scores from events where the alliance's goal was inactive (for display). */
  private calculateInactiveScore(alliance: Alliance): AllianceScore {
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of this.events) {
      if (event.deduplicated) continue;
      if (!event.goalInactive) continue;
      if (event.awardedTo !== alliance) continue;

      const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
      el.count += event.count;
      el.points += event.count * event.pointValue;
      el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
      elements[event.element] = el;
      total += event.count * event.pointValue;
    }

    return { total, elements };
  }

  private calculatePhaseBreakdown(): Record<string, { red: AllianceScore; blue: AllianceScore }> {
    const phases = new Set<string>();
    for (const event of this.events) {
      if (event.matchPhase) phases.add(event.matchPhase);
    }

    const breakdown: Record<string, { red: AllianceScore; blue: AllianceScore }> = {};
    for (const phase of phases) {
      const redElements: Record<string, ElementScore> = {};
      const blueElements: Record<string, ElementScore> = {};
      let redTotal = 0;
      let blueTotal = 0;

      for (const event of this.events) {
        if (event.deduplicated) continue;
        if (event.goalInactive) continue;
        if (event.matchPhase !== phase) continue;

        const elems = event.awardedTo === 'red' ? redElements : blueElements;
        const el = elems[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
        el.count += event.count;
        el.points += event.count * event.pointValue;
        el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
        elems[event.element] = el;

        if (event.awardedTo === 'red') redTotal += event.count * event.pointValue;
        else blueTotal += event.count * event.pointValue;
      }

      breakdown[phase] = {
        red: { total: redTotal, elements: redElements },
        blue: { total: blueTotal, elements: blueElements },
      };
    }

    return breakdown;
  }

  /** Calculate per-sub-period point totals for each alliance (counted scores only). */
  private calculatePeriodBreakdown(): Record<string, { red: number; blue: number }> {
    const periods = ['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'];
    const breakdown: Record<string, { red: number; blue: number }> = {};
    for (const p of periods) {
      breakdown[p] = { red: 0, blue: 0 };
    }

    for (const event of this.events) {
      if (event.deduplicated) continue;
      if (event.goalInactive) continue;
      if (!event.matchSubPeriod) continue;

      const period = breakdown[event.matchSubPeriod];
      if (!period) continue;
      period[event.awardedTo] += event.count * event.pointValue;
    }

    return breakdown;
  }

  /** Ensure a timer fires when the next event expires from the sliding window. */
  private ensureWindowTimer(): void {
    if (this.mode !== 'freePlay' && this.matchAlliances.size === 0) return;

    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;

    const oldest = this.events.find(e => !e.deduplicated && now - e.timestamp < windowMs);
    if (!oldest) {
      this.pruneExpiredEvents();
      if (this.windowTimer) {
        clearTimeout(this.windowTimer);
        this.windowTimer = null;
      }
      return;
    }

    const expiresAt = oldest.timestamp + windowMs;
    const delay = expiresAt - now + 50;

    if (this.windowTimer && this.windowTimerTarget !== undefined && this.windowTimerTarget <= expiresAt) {
      return;
    }

    if (this.windowTimer) clearTimeout(this.windowTimer);
    this.windowTimerTarget = expiresAt;
    this.windowTimer = setTimeout(
      () => {
        this.windowTimer = null;
        this.windowTimerTarget = undefined;
        this.pruneExpiredEvents();
        this.broadcast();
        this.ensureWindowTimer();
      },
      Math.max(0, delay),
    );
  }

  /** Remove events that have fallen outside the sliding window. */
  private pruneExpiredEvents(): void {
    if (this.mode !== 'freePlay' && this.matchAlliances.size === 0) return;
    const cutoff = Date.now() - this.windowSeconds * 1000;
    // Only prune freeplay alliance events — match events are kept for the match duration
    this.events = this.events.filter(e => this.matchAlliances.has(e.awardedTo) || e.timestamp > cutoff);
  }

  private broadcast(): void {
    if (this.suppressBroadcast) return;
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('Error in scoring state listener:', err);
      }
    }
  }
}
