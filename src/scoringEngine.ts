import {
  Alliance,
  MatchPhase,
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

const DEFAULT_WINDOW_SECONDS = 30;
const DEFAULT_PHASE_GRACE_SECONDS = 5;
const DEFAULT_BATCH_TIMEOUT_SECONDS = 100;

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
      deduplicated: deduplicated || phaseInactive,
    };

    this.events.push(processed);

    // Update dedup timestamp (only for counted, non-negative events)
    if (!deduplicated && count > 0) {
      this.lastDedupTimestamp.set(dedupKey, now);
    }

    // In free play mode, handle batch tracking and sliding window
    if (this.mode === 'freePlay' && !processed.deduplicated) {
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

    // Auto-switch to match mode when a match starts
    if (prevPhase === 'idle' && state.phase === 'countdown') {
      this.mode = 'match';
      this.events = [];
      this.lastDedupTimestamp.clear();
      this.resetBatches();
      this.broadcast();
      return;
    }

    // When match ends and resets to idle, switch back to free play
    if (state.phase === 'idle' && prevPhase === 'postMatch') {
      this.mode = 'freePlay';
      this.resetBatches();
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

    if (this.mode === 'freePlay') {
      // Primary display: active batch scores
      state.red = this.calculateBatchScore('red');
      state.blue = this.calculateBatchScore('blue');
      state.redBatchActive = this.activeBatches.red.active;
      state.blueBatchActive = this.activeBatches.blue.active;
      state.recentBatches = {
        red: this.recentBatches.red,
        blue: this.recentBatches.blue,
      };
      // Secondary display: sliding window
      state.slidingWindow = {
        red: this.calculateSlidingWindowScore('red'),
        blue: this.calculateSlidingWindowScore('blue'),
      };
    } else {
      // Match mode: cumulative scores
      state.red = this.calculateMatchScore('red');
      state.blue = this.calculateMatchScore('blue');
      state.matchPhase = this.currentMatchPhase;
      state.phaseBreakdown = this.calculatePhaseBreakdown();
    }

    return state;
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
      this.activeBatches[alliance].active = false;
      this.broadcast(); // Frontend will desaturate
    }, this.batchTimeoutSeconds * 1000);
  }

  /** Clear all batch state. */
  private resetBatches(): void {
    for (const alliance of ['red', 'blue'] as Alliance[]) {
      if (this.batchTimers[alliance]) {
        clearTimeout(this.batchTimers[alliance]!);
        this.batchTimers[alliance] = null;
      }
      this.activeBatches[alliance] = { events: [], startedAt: 0, active: false };
    }
    this.recentBatches = { red: [], blue: [] };
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

  /** Calculate cumulative match score for an alliance. */
  private calculateMatchScore(alliance: Alliance): AllianceScore {
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of this.events) {
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

  /** Ensure a timer fires when the next event expires from the sliding window. */
  private ensureWindowTimer(): void {
    if (this.mode !== 'freePlay') return;

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
    if (this.mode !== 'freePlay') return;
    const cutoff = Date.now() - this.windowSeconds * 1000;
    this.events = this.events.filter(e => e.timestamp > cutoff);
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
