import { useEffect, useRef } from 'react';
import type { MatchPhase, MatchEndReason } from '../../../src/types';
import { useMatchState } from './useBackend';

type SoundName = 'start' | 'end' | 'resume' | 'warning' | 'abort' | 'count3' | 'count2' | 'count1';

/**
 * Preload sound files as HTMLAudioElement instances so playback is instant.
 * Returns null for sounds that fail to load (e.g. missing files).
 */
const sounds: Record<SoundName, HTMLAudioElement> = (() => {
  const names: SoundName[] = ['start', 'end', 'resume', 'warning', 'abort', 'count3', 'count2', 'count1'];
  const map = {} as Record<SoundName, HTMLAudioElement>;
  for (const name of names) {
    const el = new Audio(`/sounds/${name}.wav`);
    el.preload = 'auto';
    map[name] = el;
  }
  return map;
})();

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
function getSoundForTransition(phase: MatchPhase, prevPhase: MatchPhase, endReason?: MatchEndReason): SoundName | null {
  switch (phase) {
    case 'auto':
      return prevPhase === 'paused' ? 'resume' : 'start';

    case 'autoPause':
      return 'end';

    case 'teleop':
      return 'resume';

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
export function useMatchAudio(phase: MatchPhase | undefined, endReason?: MatchEndReason, remainingTime?: number): void {
  const prevPhaseRef = useRef<MatchPhase>('idle');
  const lastCountRef = useRef(0);

  // Announce "3… 2… 1…" as the pre-start countdown ticks. The countdown
  // enters at exactly 3s and matchState broadcasts every tick, so each whole
  // second fires once; an aborted countdown resets for the next start.
  useEffect(() => {
    if (phase !== 'countdown') {
      lastCountRef.current = 0;
      return;
    }
    if (remainingTime === undefined) return;
    const second = Math.ceil(remainingTime);
    if (second !== lastCountRef.current && second >= 1 && second <= 3) {
      lastCountRef.current = second;
      play(`count${second}` as SoundName);
    }
  }, [phase, remainingTime]);

  useEffect(() => {
    if (phase === undefined) return;
    if (phase === prevPhaseRef.current) return;

    const prev = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    const sound = getSoundForTransition(phase, prev, endReason);
    if (sound) play(sound);
  }, [phase, endReason]);
}

/**
 * Renderless component that plays match audio. Drop into any React tree
 * that has access to the WebSocket event bus (useMatchState).
 */
export function MatchAudioBridge(): null {
  const matchState = useMatchState();
  useMatchAudio(matchState?.phase, matchState?.endReason, matchState?.remainingTime);
  return null;
}
