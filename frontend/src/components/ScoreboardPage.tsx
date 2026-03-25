import { useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

import { useScoreState, useMatchState, sendCastReceiverRegister } from '../hooks/useBackend';
import type { Alliance, ScoreBatch, StationControlState, StationName } from '../../../src/types';

// Cast initialization happens in scores.html before this module loads.
declare global {
  interface Window {
    __castReady?: boolean;
    __castSendSwap?: (swap: boolean) => void;
    __isCastReceiver?: boolean;
  }
}

function getInitialSwap(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('swap');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-swap') === '1';
}

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
function getAllianceShiftState(
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

export function ScoreboardPage() {
  const score = useScoreState();
  const matchState = useMatchState();
  const [, setTick] = useState(0);
  const [swapped, setSwapped] = useState(getInitialSwap);

  const toggleSwap = () => {
    setSwapped(s => {
      const next = !s;
      localStorage.setItem('scoreboard-swap', next ? '1' : '0');
      window.__castSendSwap?.(next);
      return next;
    });
  };

  const left: Alliance = swapped ? 'blue' : 'red';
  const right: Alliance = swapped ? 'red' : 'blue';

  // Register as a cast receiver if running on Chromecast
  useEffect(() => {
    if (window.__isCastReceiver) {
      // Small delay to ensure WebSocket is connected
      const timer = setTimeout(() => {
        const name = localStorage.getItem('scoreboard-device-name') || document.title || 'Cast Display';
        sendCastReceiverRegister(name, swapped);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render every second for time-ago displays and alliance shift timing
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  // Prevent screen from sleeping (TV screensaver)
  useEffect(() => {
    let wakeLock: WakeLockSentinel | null = null;
    const acquire = () =>
      navigator.wakeLock
        ?.request('screen')
        .then(wl => {
          wakeLock = wl;
        })
        .catch(() => {});
    acquire();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      wakeLock?.release();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  // Extract team numbers per alliance from match state
  const teamsByAlliance = useMemo(() => {
    const result: Record<Alliance, number[]> = { red: [], blue: [] };
    if (!matchState?.stationStates) return result;

    for (const [, state] of Object.entries(matchState.stationStates) as [
      StationName,
      StationControlState | undefined,
    ][]) {
      if (state?.joined && state.alliance && state.teamNumber) {
        result[state.alliance].push(state.teamNumber);
      }
    }
    // Sort for stable display
    result.red.sort((a, b) => a - b);
    result.blue.sort((a, b) => a - b);
    return result;
  }, [matchState]);

  // Compute alliance shift state for REBUILT
  const inactiveAlliance = useMemo(() => {
    if (!matchState) return null;
    return getAllianceShiftState(
      matchState.phase,
      matchState.remainingTime,
      matchState.config.teleopDuration,
      matchState.config.endgameDuration,
      matchState.autoWinnerAlliance,
    );
  }, [matchState]);

  const autoWinner = matchState?.autoWinnerAlliance ?? null;
  const isMatchMode = score?.mode === 'match';
  const hasTeams = teamsByAlliance.red.length > 0 || teamsByAlliance.blue.length > 0;

  if (!score) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: window.__isCastReceiver ? '100vh' : '100dvh',
          bgcolor: '#000',
        }}
      >
        <Typography variant="h4" color="text.secondary">
          Connecting...
        </Typography>
      </Box>
    );
  }

  const elements = Object.values(score.elements);
  const hasBreakdown = elements.length > 1;
  const isFreePlay = score.mode === 'freePlay';

  // Alliance shift desaturation: during match mode teleop, desaturate the inactive side
  const leftShiftActive = isMatchMode ? inactiveAlliance !== left : true;
  const rightShiftActive = isMatchMode ? inactiveAlliance !== right : true;

  // Free play batch activity
  const leftBatchActive = left === 'red' ? score.redBatchActive : score.blueBatchActive;
  const rightBatchActive = right === 'red' ? score.redBatchActive : score.blueBatchActive;

  // Combine: in match mode, use shift logic; in free play, use batch activity
  const leftActive = isFreePlay ? leftBatchActive : leftShiftActive;
  const rightActive = isFreePlay ? rightBatchActive : rightShiftActive;

  const leftBatches = score.recentBatches?.[left] ?? [];
  const rightBatches = score.recentBatches?.[right] ?? [];
  const hasRecentBatches = leftBatches.length > 0 || rightBatches.length > 0;

  const leftWindow = score.slidingWindow?.[left];
  const rightWindow = score.slidingWindow?.[right];
  const hasWindow = isFreePlay && ((leftWindow?.total ?? 0) > 0 || (rightWindow?.total ?? 0) > 0);

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: window.__isCastReceiver ? '100vh' : '100dvh',
        bgcolor: '#000',
        color: '#fff',
        userSelect: 'none',
      }}
    >
      {/* Controls — top right (hidden on Chromecast receiver) */}
      {!window.__isCastReceiver && (
        <Box sx={{ position: 'absolute', top: 12, right: 16, display: 'flex', gap: 1, alignItems: 'center' }}>
          <Typography
            onClick={toggleSwap}
            sx={{ cursor: 'pointer', opacity: 0.3, fontSize: '0.7rem', '&:hover': { opacity: 0.7 } }}
          >
            ⇄
          </Typography>
          {window.__castReady && (
            <google-cast-launcher style={{ width: 24, height: 24, cursor: 'pointer', opacity: 0.5 }} />
          )}
        </Box>
      )}

      {/* Main score display */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <AllianceScoreBox
          alliance={left}
          total={score[left].total}
          active={leftActive}
          teams={isMatchMode && hasTeams ? teamsByAlliance[left] : undefined}
        />
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <Typography
            variant="h6"
            sx={{ color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase', letterSpacing: 4, textAlign: 'center' }}
          >
            {score.mode === 'match' ? (score.matchPhase ?? 'Match') : 'Free Play'}
          </Typography>

          {/* Auto winner badge */}
          {isMatchMode && autoWinner && (
            <Typography
              sx={{
                color: autoWinner === 'red' ? '#ef5350' : '#42a5f5',
                fontSize: '0.8rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 2,
              }}
            >
              Auto: {autoWinner === 'red' ? 'RED' : 'BLUE'}
            </Typography>
          )}

          {isFreePlay && hasWindow && (
            <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '0.85rem', fontFamily: 'monospace' }}>
              {leftWindow?.total ?? 0} / {rightWindow?.total ?? 0} in last {score.windowSeconds}s
            </Typography>
          )}
          {!hasWindow && !autoWinner && (
            <Typography sx={{ color: 'rgba(255,255,255,0.15)', fontSize: '1.5rem', fontFamily: 'monospace' }}>
              —
            </Typography>
          )}
        </Box>
        <AllianceScoreBox
          alliance={right}
          total={score[right].total}
          active={rightActive}
          teams={isMatchMode && hasTeams ? teamsByAlliance[right] : undefined}
        />
      </Box>

      {/* Element breakdown bar */}
      {hasBreakdown && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 4, pb: 3, px: 4 }}>
          {elements.map(el => {
            const leftEl = score[left].elements[el.id];
            const rightEl = score[right].elements[el.id];
            if (!leftEl && !rightEl) return null;
            const leftColor = left === 'red' ? '#ef5350' : '#42a5f5';
            const rightColor = right === 'red' ? '#ef5350' : '#42a5f5';
            return (
              <Box key={el.id} sx={{ textAlign: 'center' }}>
                <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: '0.85rem', mb: 0.5 }}>{el.name}</Typography>
                <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
                  <Typography sx={{ color: leftColor, fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {leftEl?.count ?? 0}
                  </Typography>
                  <Typography sx={{ color: rightColor, fontFamily: 'monospace', fontSize: '1.3rem', fontWeight: 700 }}>
                    {rightEl?.count ?? 0}
                  </Typography>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Recent batches (free play) */}
      {isFreePlay && hasRecentBatches && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 6, pb: 2 }}>
          <BatchList batches={leftBatches} color={left === 'red' ? '#ef5350' : '#42a5f5'} />
          <BatchList batches={rightBatches} color={right === 'red' ? '#ef5350' : '#42a5f5'} />
        </Box>
      )}

      {/* Phase breakdown (match mode) */}
      {score.mode === 'match' && score.phaseBreakdown && Object.keys(score.phaseBreakdown).length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'center', gap: 4, pb: 2 }}>
          {Object.entries(score.phaseBreakdown).map(([phase, scores]) => (
            <Box key={phase} sx={{ textAlign: 'center' }}>
              <Typography sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.75rem', textTransform: 'uppercase' }}>
                {phase}
              </Typography>
              <Box sx={{ display: 'flex', gap: 1.5, justifyContent: 'center' }}>
                <Typography
                  sx={{ color: left === 'red' ? '#ef5350' : '#42a5f5', fontFamily: 'monospace', fontSize: '1rem' }}
                >
                  {scores[left].total}
                </Typography>
                <Typography
                  sx={{ color: right === 'red' ? '#ef5350' : '#42a5f5', fontFamily: 'monospace', fontSize: '1rem' }}
                >
                  {scores[right].total}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function AllianceScoreBox({
  alliance,
  total,
  active,
  teams,
}: {
  alliance: Alliance;
  total: number;
  active?: boolean;
  teams?: number[];
}) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const bgColor = alliance === 'red' ? 'rgba(239,83,80,0.08)' : 'rgba(66,165,245,0.08)';
  const desaturated = active === false;

  return (
    <Box
      sx={{
        textAlign: 'center',
        px: 6,
        py: 3,
        borderRadius: 2,
        border: `3px solid ${color}`,
        backgroundColor: bgColor,
        minWidth: 200,
        opacity: desaturated ? 0.3 : 1,
        filter: desaturated ? 'saturate(0.3)' : 'none',
        transition: 'opacity 2s ease, filter 2s ease',
      }}
    >
      <Typography
        sx={{
          fontSize: 'clamp(4rem, 15vw, 12rem)',
          fontWeight: 800,
          fontFamily: 'monospace',
          color,
          lineHeight: 1,
        }}
      >
        {total}
      </Typography>
      <Typography
        sx={{
          color,
          textTransform: 'uppercase',
          letterSpacing: 6,
          fontWeight: 700,
          fontSize: '1.2rem',
          mt: 1,
        }}
      >
        {alliance}
      </Typography>
      {/* Team numbers display */}
      {teams && teams.length > 0 && (
        <Typography
          sx={{
            color: 'rgba(255,255,255,0.4)',
            fontSize: '0.85rem',
            fontFamily: 'monospace',
            mt: 0.5,
          }}
        >
          {teams.join(' \u00B7 ')}
        </Typography>
      )}
    </Box>
  );
}

function formatTimeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function BatchList({ batches, color }: { batches: ScoreBatch[]; color: string }) {
  if (batches.length === 0) return null;
  return (
    <Box>
      <Typography
        sx={{
          color: 'rgba(255,255,255,0.3)',
          fontSize: '0.7rem',
          textTransform: 'uppercase',
          mb: 0.5,
          textAlign: 'center',
        }}
      >
        Previous
      </Typography>
      {batches.map((b, i) => (
        <Box key={i} sx={{ display: 'flex', gap: 1.5, justifyContent: 'center', opacity: 1 - i * 0.15 }}>
          <Typography sx={{ color, fontFamily: 'monospace', fontSize: '0.9rem', fontWeight: 700 }}>
            {b.total}
          </Typography>
          <Typography sx={{ color: 'rgba(255,255,255,0.3)', fontSize: '0.9rem' }}>
            {formatTimeAgo(b.endedAt)}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
