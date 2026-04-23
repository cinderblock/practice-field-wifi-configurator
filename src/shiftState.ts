import type { Alliance } from './types.js';

/**
 * REBUILT alliance shift timing.
 * After auto period ends, teleop begins with a 10-second Transition where both
 * hubs are active. The auto loser scores first: their hub is active (winner's
 * hub INACTIVE) in Shifts 1 & 3. The winner scores in Shifts 2 & 4.
 *
 * Teleop timeline (from teleop start, total 140s including endgame):
 * - Transition: 0-10s     (both active)
 * - Shift 1:    10-35s    (auto winner's hub INACTIVE -> loser scores)
 * - Shift 2:    35-60s    (auto loser's hub INACTIVE -> winner scores)
 * - Shift 3:    60-85s    (auto winner's hub INACTIVE -> loser scores)
 * - Shift 4:    85-110s   (auto loser's hub INACTIVE -> winner scores)
 * - Endgame:    110-140s  (both active, climbing emphasis)
 *
 * Returns which alliance's goal is currently inactive, or null if both are active.
 */

export const TRANSITION_DURATION = 10;
export const SHIFT_DURATION = 25;

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

  // Transition period: both hubs active
  if (teleopElapsed < TRANSITION_DURATION) {
    return null;
  }

  const shiftElapsed = teleopElapsed - TRANSITION_DURATION;

  if (shiftElapsed < SHIFT_DURATION) {
    // Shift 1: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 2) {
    // Shift 2: auto winner's goal active -> loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  } else if (shiftElapsed < SHIFT_DURATION * 3) {
    // Shift 3: auto winner's goal inactive
    return autoWinnerAlliance;
  } else if (shiftElapsed < SHIFT_DURATION * 4) {
    // Shift 4: auto winner's goal active -> loser's goal inactive
    return autoWinnerAlliance === 'red' ? 'blue' : 'red';
  }

  // After shift 4 (endgame territory): both active
  return null;
}
