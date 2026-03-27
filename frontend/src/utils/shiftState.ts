import type { Alliance } from '../../../src/types';

/**
 * REBUILT alliance shift timing.
 * After auto period ends, teleop begins with a 10-second Transition where both
 * hubs are active. Then the auto winner's goal goes inactive in Shifts 1 & 3,
 * and active in Shifts 2 & 4. Each shift is 25 seconds.
 *
 * Teleop timeline (from teleop start, total 110s teleop + 30s endgame):
 * - Transition: 0-10s     (both active)
 * - Shift 1:    10-35s    (auto winner's goal INACTIVE)
 * - Shift 2:    35-60s    (auto winner's goal ACTIVE, loser INACTIVE)
 * - Shift 3:    60-85s    (auto winner's goal INACTIVE)
 * - Shift 4:    85-110s   (auto winner's goal ACTIVE, loser INACTIVE)
 * - Endgame:    110s+     (both active)
 *
 * Returns which alliance's goal is currently inactive, or null if both are active.
 */
export function getAllianceShiftState(
  phase: string | undefined,
  remainingTime: number,
  totalTeleopDuration: number,
  _endgameDuration: number,
  autoWinnerAlliance: Alliance | null | undefined,
): Alliance | null {
  if (!autoWinnerAlliance) return null;

  // Only apply shift logic during teleop
  if (phase !== 'teleop') return null;

  // Calculate elapsed time in teleop
  const teleopElapsed = totalTeleopDuration - remainingTime;

  const TRANSITION_DURATION = 10; // Both hubs active during transition
  const SHIFT_DURATION = 25;

  // Transition period: both hubs active
  if (teleopElapsed < TRANSITION_DURATION) {
    return null;
  }

  const shiftElapsed = teleopElapsed - TRANSITION_DURATION;

  if (shiftElapsed < SHIFT_DURATION) {
    // Shift 1: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 2) {
    // Shift 2: auto winner's goal active → loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  } else if (shiftElapsed < SHIFT_DURATION * 3) {
    // Shift 3: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 4) {
    // Shift 4: auto winner's goal active → loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  }

  // After shift 4 (endgame territory): both active
  return null;
}
