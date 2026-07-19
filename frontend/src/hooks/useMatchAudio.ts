import { useEffect, useRef } from 'react';
import type { MatchPhase, MatchEndReason } from '../../../src/types';
import { useMatchState, onPlayGetReady } from './useBackend';

type SoundName =
  | 'start'
  | 'end'
  | 'resume'
  | 'warning'
  | 'abort'
  | 'countdown1'
  | 'countdown2'
  | 'countdown3'
  | 'countdown4'
  | 'getready';

const COUNTDOWN_NAMES = ['countdown1', 'countdown2', 'countdown3', 'countdown4'] as const;

/** Deterministic per-match countdown voice pick. Must match the server logic
 *  in src/matchAudio.ts so the field speaker and every open page play the
 *  same voice for a given match. */
function countdownVariant(matchId: string | undefined): SoundName {
  let h = 0;
  for (let i = 0; i < (matchId?.length ?? 0); i++) h = (h + matchId!.charCodeAt(i)) % COUNTDOWN_NAMES.length;
  return COUNTDOWN_NAMES[h];
}

/**
 * Preload sound files as HTMLAudioElement instances so playback is instant.
 * Returns null for sounds that fail to load (e.g. missing files).
 */
const sounds: Record<SoundName, HTMLAudioElement> = (() => {
  const names: SoundName[] = ['start', 'end', 'resume', 'warning', 'abort', 'getready', ...COUNTDOWN_NAMES];
  const map = {} as Record<SoundName, HTMLAudioElement>;
  for (const name of names) {
    const el = new Audio(`/sounds/${name}.wav`);
    el.preload = 'auto';
    map[name] = el;
  }
  return map;
})();

/** Stop any in-flight sound (used when a display is muted mid-clip). */
export function stopAllSounds(): void {
  for (const el of Object.values(sounds)) {
    el.pause();
    el.currentTime = 0;
  }
}

function play(name: SoundName): void {
  const el = sounds[name];
  if (!el) return;
  // Reset to start so rapid re-triggers work
  el.currentTime = 0;
  el.play().catch(() => {
    // Autoplay blocked — silently ignore.
    // On the match page the user will have clicked before sounds fire,
    // so this mainly guards the scoreboard on passive displays.
  });
}

/**
 * Determine which sound to play for a phase transition.
 * Mirrors the server-side logic in src/matchAudio.ts.
 */
function getSoundForTransition(
  phase: MatchPhase,
  prevPhase: MatchPhase,
  endReason?: MatchEndReason,
  matchId?: string,
): SoundName | null {
  switch (phase) {
    case 'countdown':
      // Single pre-timed "3… 2… 1… <horn>" clip: numbers at 0/1/2s, charge
      // horn baked in at the 3s mark. Voice varies per match.
      return countdownVariant(matchId);

    case 'auto':
      // countdown → auto is silent — the horn already played from countdown.wav
      if (prevPhase === 'countdown') return null;
      return prevPhase === 'paused' ? 'resume' : 'start';

    case 'autoPause':
      return 'end';

    case 'teleop':
      // countdown → teleop (skipAuto) is silent — horn baked into countdown.wav
      return prevPhase === 'countdown' ? null : 'resume';

    case 'endgame':
      return prevPhase === 'paused' ? 'resume' : 'warning';

    case 'paused':
      // Server has a 'pause' sound but no pause.wav exists — skip
      return null;

    case 'postMatch':
      if (endReason === 'stopped' || endReason === 'estop' || endReason === 'abandoned') {
        return 'abort';
      }
      return 'end';

    default:
      return null;
  }
}

/**
 * React hook that plays match phase-transition sounds in the browser.
 *
 * Call this from any page that should produce game sounds (match control,
 * scoreboard, etc.). Uses preloaded HTMLAudioElement instances for instant
 * playback.
 *
 * Note: browsers require a prior user gesture to unlock audio. On the match
 * control page the operator will have clicked before any sound fires. On
 * passive displays (scoreboard TVs) the first sound may be silently blocked.
 */
export function useMatchAudio(phase: MatchPhase | undefined, endReason?: MatchEndReason, matchId?: string): void {
  const prevPhaseRef = useRef<MatchPhase>('idle');

  // Server-broadcast "get ready" attention sound. Subscribed only while this
  // hook is mounted, so a muted display (bridge unmounted) stays silent.
  useEffect(() => onPlayGetReady(() => play('getready')), []);

  useEffect(() => {
    if (phase === undefined) return;
    if (phase === prevPhaseRef.current) return;

    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    // Countdown aborted — cut the "3… 2… 1…" announcer off
    if (prev === 'countdown' && phase !== 'auto' && phase !== 'teleop') {
      for (const name of COUNTDOWN_NAMES) {
        const el = sounds[name];
        el.pause();
        el.currentTime = 0;
      }
    }

    const sound = getSoundForTransition(phase, prev, endReason, matchId);
    if (sound) play(sound);
  }, [phase, endReason, matchId]);
}

/**
 * Renderless component that plays match audio. Drop into any React tree
 * that has access to the WebSocket event bus (useMatchState).
 */
export function MatchAudioBridge(): null {
  const matchState = useMatchState();
  useMatchAudio(matchState?.phase, matchState?.endReason, matchState?.matchId);
  return null;
}
