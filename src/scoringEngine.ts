import {
  Alliance,
  MatchPhase,
  MatchState,
  ScoreEvent,
  ScoreState,
  ScoringMode,
  ScoringElementConfig,
  ScoringSourceStatus,
  ProcessedScoreEvent,
  AllianceScore,
  ElementScore,
} from './types.js';

const DEFAULT_WINDOW_SECONDS = 30;

function oppositeAlliance(alliance: Alliance): Alliance {
  return alliance === 'red' ? 'blue' : 'red';
}

let nextEventId = 1;

export class ScoringEngine {
  private events: ProcessedScoreEvent[] = [];
  private sources = new Map<string, ScoringSourceStatus>();
  private elements = new Map<string, ScoringElementConfig>();
  private mode: ScoringMode = 'freePlay';
  private windowSeconds = DEFAULT_WINDOW_SECONDS;
  private currentMatchPhase: MatchPhase = 'idle';
  /** Key: `${element}:${alliance}`, value: timestamp of last counted event */
  private lastDedupTimestamp = new Map<string, number>();
  private windowTimer: NodeJS.Timeout | null = null;
  private windowTimerTarget: number | undefined;
  private autoRegisterLimit = 1;
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
      matchPhase: this.mode === 'match' ? this.currentMatchPhase : undefined,
      // Mark as deduplicated if within dedup window OR if phase is inactive
      deduplicated: deduplicated || phaseInactive,
    };

    this.events.push(processed);

    // Update dedup timestamp (only for counted, non-negative events)
    if (!deduplicated && count > 0) {
      this.lastDedupTimestamp.set(dedupKey, now);
    }

    // In free play mode, ensure a timer fires when the oldest event expires
    if (this.mode === 'freePlay' && !processed.deduplicated) {
      this.ensureWindowTimer();
    }

    this.broadcast();
    return processed.deduplicated ? 'deduplicated' : processed;
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
    }
    this.broadcast();
  }

  /** Set the sliding window size for free play mode. */
  setWindowSeconds(seconds: number): void {
    this.windowSeconds = Math.max(1, Math.min(300, seconds));
    this.broadcast();
  }

  /** Reset all scores and events. Sources and element config are preserved. */
  reset(): void {
    this.events = [];
    this.lastDedupTimestamp.clear();
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

    // Auto-switch to match mode when a match starts
    if (prevPhase === 'idle' && state.phase === 'countdown') {
      this.mode = 'match';
      this.events = [];
      this.lastDedupTimestamp.clear();
      this.broadcast();
      return;
    }

    // When match ends and resets to idle, switch back to free play
    if (state.phase === 'idle' && prevPhase === 'postMatch') {
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
    const red = this.calculateAllianceScore('red');
    const blue = this.calculateAllianceScore('blue');

    const state: ScoreState = {
      type: 'scoreState',
      mode: this.mode,
      windowSeconds: this.windowSeconds,
      autoRegisterLimit: this.autoRegisterLimit,
      red,
      blue,
      sources: Object.fromEntries(this.sources),
      elements: Object.fromEntries(this.elements),
    };

    if (this.mode === 'match') {
      state.matchPhase = this.currentMatchPhase;
      state.phaseBreakdown = this.calculatePhaseBreakdown();
    }

    return state;
  }

  // ── Private ───────────────────────────────────────────────────────

  private calculateAllianceScore(alliance: Alliance): AllianceScore {
    const now = Date.now();
    const windowMs = this.windowSeconds * 1000;
    const elements: Record<string, ElementScore> = {};
    let total = 0;

    for (const event of this.events) {
      if (event.deduplicated) continue;
      if (event.awardedTo !== alliance) continue;

      // In free play, only count events within the sliding window
      if (this.mode === 'freePlay' && now - event.timestamp > windowMs) continue;

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

        const elements = event.awardedTo === 'red' ? redElements : blueElements;
        const el = elements[event.element] ?? { count: 0, points: 0, lastEventTime: 0 };
        el.count += event.count;
        el.points += event.count * event.pointValue;
        el.lastEventTime = Math.max(el.lastEventTime, event.timestamp);
        elements[event.element] = el;

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

    // Find the oldest non-deduplicated event still within the window
    const oldest = this.events.find(e => !e.deduplicated && now - e.timestamp < windowMs);
    if (!oldest) {
      // No active events — prune everything and cancel timer
      this.pruneExpiredEvents();
      if (this.windowTimer) {
        clearTimeout(this.windowTimer);
        this.windowTimer = null;
      }
      return;
    }

    const expiresAt = oldest.timestamp + windowMs;
    const delay = expiresAt - now + 50; // +50ms buffer

    // Don't reschedule if existing timer will fire sooner
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
        // Reschedule for the next expiry
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
