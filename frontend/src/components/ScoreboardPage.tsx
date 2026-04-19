import { useCallback, useEffect, useState, useMemo } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import SmoothieComponent from 'react-smoothie';

import { useScoreState, useMatchState, useTelemetryCallback, sendCastReceiverRegister } from '../hooks/useBackend';
import type { Alliance, ScoreBatch, StationControlState, StationName, TelemetryUpdate } from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { getAllianceShiftState } from '../utils/shiftState';
import { MatchTimeline } from './MatchTimeline';
import { MatchTimer, getActiveColor } from './MatchTimer';
import { handleTelemetryUpdate, stationTimeSeries, batteryMinState } from './StationChart';

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

  // Timer colour and pulse for match mode
  const activeColor = matchState ? getActiveColor(matchState) : '#9e9e9e';
  const isActivePeriod =
    matchState &&
    (matchState.phase === 'auto' ||
      matchState.phase === 'teleop' ||
      matchState.phase === 'endgame' ||
      matchState.phase === 'countdown');
  const shouldPulse = !!(isActivePeriod && matchState && matchState.remainingTime > 0 && matchState.remainingTime <= 3);

  // Match timeline progress (0-1)
  const matchProgress = useMemo(() => {
    if (!matchState || !isMatchMode) return null;
    const { phase } = matchState;
    if (phase === 'idle' || phase === 'created') return null;
    const cfg = matchState.config;
    const countdownDuration = 3;
    const barTotal = cfg.autoDuration + cfg.pauseDuration + cfg.teleopDuration;
    if (barTotal <= 0) return null;
    const elapsed = Math.max(0, matchState.totalMatchTime - countdownDuration);
    if (cfg.skipAuto) {
      const skipOffset = cfg.autoDuration + cfg.pauseDuration;
      return Math.min(1, (skipOffset + elapsed) / barTotal);
    }
    return Math.min(1, elapsed / barTotal);
  }, [matchState, isMatchMode]);

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
            sx={{
              color: isMatchMode && matchState ? activeColor : 'rgba(255,255,255,0.3)',
              textTransform: 'uppercase',
              letterSpacing: 4,
              textAlign: 'center',
              transition: 'color 1s ease',
            }}
          >
            {score.mode === 'match' ? (score.matchPhase ?? 'Match') : 'Free Play'}
          </Typography>

          {/* Match countdown timer */}
          {isMatchMode && matchState && matchProgress !== null && (
            <MatchTimer
              remainingTime={matchState.remainingTime}
              color={activeColor}
              pulse={shouldPulse}
              fontSize="clamp(2.5rem, 6vw, 5rem)"
            />
          )}

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

      {/* Match timeline progress bar */}
      {matchProgress !== null && matchState && (
        <Box sx={{ px: 3, pb: 2 }}>
          <MatchTimeline
            config={matchState.config}
            progress={matchProgress}
            autoWinnerAlliance={autoWinner}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
          />
        </Box>
      )}

      {/* Battery voltage for connected robots */}
      <BatteryPanel matchState={matchState} />
    </Box>
  );
}

// ── Battery Panel ────────────────────────────────────────────────────

/** Per-station battery state tracked from telemetry. */
interface BatteryInfo {
  current: number;
  lastSeen: number;
}

function BatteryPanel({ matchState }: { matchState: ReturnType<typeof useMatchState> }) {
  const [batteries, setBatteries] = useState<Partial<Record<StationName, BatteryInfo>>>({});

  // Populate TimeSeries (for charts) and track numeric values
  useTelemetryCallback(
    useCallback((entry: TelemetryUpdate) => {
      handleTelemetryUpdate(entry);
      if (entry.batteryVoltage !== undefined) {
        setBatteries(prev => ({
          ...prev,
          [entry.station]: {
            current: entry.batteryVoltage,
            lastSeen: Date.now(),
          },
        }));
      }
    }, []),
  );

  // Build the list of robots to display (stations with recent telemetry)
  const robots = useMemo(() => {
    const now = Date.now();
    const result: Array<{
      station: StationName;
      teamNumber: number | null;
      alliance: Alliance | null;
      ssid: string | null;
      battery: BatteryInfo;
    }> = [];

    for (const station of StationNameList) {
      const batt = batteries[station];
      if (!batt || now - batt.lastSeen > 15_000) continue;

      // Get team number and alliance from match state
      const stationState = matchState?.stationStates?.[station];
      const teamNumber = stationState?.teamNumber ?? null;
      const alliance = stationState?.alliance ?? null;

      result.push({ station, teamNumber, alliance, ssid: null, battery: batt });
    }

    return result;
  }, [batteries, matchState]);

  // Detect duplicate team numbers to show station name as disambiguator
  const teamCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const r of robots) {
      if (r.teamNumber) counts.set(r.teamNumber, (counts.get(r.teamNumber) ?? 0) + 1);
    }
    return counts;
  }, [robots]);

  if (robots.length === 0) return null;

  return (
    <Box
      sx={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: 1.5,
        px: 2,
        pb: 2,
      }}
    >
      {robots.map(robot => {
        const color =
          robot.alliance === 'red' ? '#ef5350' : robot.alliance === 'blue' ? '#42a5f5' : 'rgba(255,255,255,0.5)';
        const bgColor =
          robot.alliance === 'red'
            ? 'rgba(239,83,80,0.10)'
            : robot.alliance === 'blue'
              ? 'rgba(66,165,245,0.10)'
              : 'rgba(255,255,255,0.05)';
        const ts = stationTimeSeries[robot.station];
        const minFloor = batteryMinState[robot.station]?.floor;
        const isDuplicate = robot.teamNumber ? (teamCounts.get(robot.teamNumber) ?? 0) > 1 : false;

        return (
          <Box
            key={robot.station}
            sx={{
              border: `1px solid ${color}`,
              borderRadius: 1,
              backgroundColor: bgColor,
              width: 140,
              overflow: 'hidden',
            }}
          >
            {/* Mini chart */}
            <Box sx={{ '& canvas': { display: 'block', height: '35px !important' } }}>
              <SmoothieComponent
                responsive
                height={35}
                streamDelay={-1000}
                millisPerPixel={200}
                minValue={5}
                maxValue={14}
                grid={{
                  borderVisible: false,
                  fillStyle: 'transparent',
                  strokeStyle: 'rgba(255,255,255,0.05)',
                  verticalSections: 1,
                  millisPerLine: 0,
                }}
                labels={{ disabled: true }}
                title={{ text: '' }}
                yMinFormatter={() => ''}
                yMaxFormatter={() => ''}
                yIntermediateFormatter={() => ''}
                series={[
                  {
                    data: ts.batteryVoltage,
                    strokeStyle: color,
                    lineWidth: 1.5,
                  },
                  {
                    data: ts.batteryMinVoltage,
                    strokeStyle: 'rgba(244, 67, 54, 0.6)',
                    fillStyle: 'rgba(244, 67, 54, 0.08)',
                    lineWidth: 1,
                  },
                ]}
              />
            </Box>

            {/* Numeric values and team label */}
            <Box sx={{ px: 1, py: 0.5, borderTop: `1px solid rgba(255,255,255,0.1)` }}>
              {/* Voltage values */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Typography
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.85rem',
                    fontWeight: 700,
                    color,
                  }}
                >
                  {robot.battery.current.toFixed(1)}V
                </Typography>
                <Typography
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '0.7rem',
                    color: 'rgba(244, 67, 54, 0.8)',
                  }}
                >
                  {!isNaN(minFloor) ? `↓${minFloor.toFixed(1)}V` : ''}
                </Typography>
              </Box>

              {/* Team number */}
              <Typography
                sx={{
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  color: 'rgba(255,255,255,0.6)',
                  textAlign: 'center',
                  mt: 0.25,
                }}
              >
                {robot.teamNumber ?? robot.station}
                {isDuplicate && (
                  <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: 400 }}>
                    {' '}
                    ({robot.station.replace('slot', '#')})
                  </span>
                )}
              </Typography>
            </Box>
          </Box>
        );
      })}
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
