import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';
import SmoothieComponent from 'react-smoothie';

import { useScoreState, useMatchState, useTelemetryCallback, sendCastReceiverRegister } from '../hooks/useBackend';
import type { Alliance, ScoreBatch, StationName, TelemetryUpdate } from '../../../src/types';
import { StationNameList } from '../../../src/types';
import { getAllianceShiftState, getAllianceScoringShifts, getMatchSubPeriod } from '../utils/shiftState';
import type { MatchSubPeriod } from '../utils/shiftState';
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

// ── Background colour per match period ─────────────────────────────

const BG_GREEN = 'rgba(76, 175, 80, 0.12)';
const BG_GREY = 'rgba(158, 158, 158, 0.10)';
const BG_RED = 'rgba(239, 83, 80, 0.12)';
const BG_BLUE = 'rgba(66, 165, 245, 0.12)';
const BG_GOLD = 'rgba(255, 167, 38, 0.12)';
const BG_PURPLE = 'rgba(171, 71, 188, 0.12)';
const BG_BLACK = '#000';

/** Compute the match-period background color (or BG_BLACK for non-match phases). */
function getMatchBgColor(matchState: ReturnType<typeof useMatchState>): string {
  if (!matchState) return BG_BLACK;

  const { phase } = matchState;

  switch (phase) {
    case 'idle':
    case 'created':
      return BG_BLACK;
    case 'countdown':
      return BG_GREY;
    case 'auto':
      return BG_GREEN;
    case 'autoPause':
      return BG_GREY;
    case 'teleop': {
      const inactive = getAllianceShiftState(
        phase,
        matchState.remainingTime,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      if (!inactive) return BG_GREEN; // transition — both active
      if (inactive === 'red') return BG_BLUE; // blue scoring
      return BG_RED; // red scoring
    }
    case 'endgame':
      return BG_GOLD;
    case 'postMatch':
      return BG_PURPLE;
    case 'paused':
      return BG_GREY;
    default:
      return BG_BLACK;
  }
}

/**
 * Build the CSS background value for the scoreboard.
 * - Both sides in match (or full freeplay): solid color.
 * - Half-freeplay: hard-stop gradient so only the match half is colored.
 */
function getScoreboardBg(
  matchState: ReturnType<typeof useMatchState>,
  leftInMatch: boolean,
  rightInMatch: boolean,
): string {
  const matchColor = getMatchBgColor(matchState);

  if (leftInMatch && rightInMatch) return matchColor;
  if (!leftInMatch && !rightInMatch) return BG_BLACK;

  // Half-freeplay: one side match color, other side black
  const leftColor = leftInMatch ? matchColor : BG_BLACK;
  const rightColor = rightInMatch ? matchColor : BG_BLACK;
  return `linear-gradient(to right, ${leftColor} 50%, ${rightColor} 50%)`;
}

function getInitialSwap(): boolean {
  const params = new URLSearchParams(window.location.search);
  const param = params.get('swap');
  if (param !== null) return param === '1' || param === 'true';
  return localStorage.getItem('scoreboard-swap') === '1';
}

/** Phases where the countdown timer is actively counting down. */
const COUNTING_PHASES = new Set(['countdown', 'auto', 'autoPause', 'teleop', 'endgame']);

export function ScoreboardPage() {
  const score = useScoreState();
  const matchState = useMatchState();
  const [, setTick] = useState(0);
  const [swapped, setSwapped] = useState(getInitialSwap);

  // Track when we last received a match state for client-side time interpolation
  const matchReceivedAt = useRef(0);
  const lastMatchRef = useRef(matchState);
  if (matchState !== lastMatchRef.current) {
    lastMatchRef.current = matchState;
    matchReceivedAt.current = Date.now();
  }

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

  /** Is this alliance's scoring currently counting? Mirrors backend isGoalActive
   *  including the 3-second grace period after a goal turns off. */
  const isScoringActive = useCallback(
    (alliance: Alliance): boolean => {
      if (!matchState) return true;
      if (matchState.phase !== 'teleop') return true;

      const inactive = getAllianceShiftState(
        matchState.phase,
        matchState.remainingTime,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      if (inactive !== alliance) return true;

      // Currently inactive — check 3-second grace
      const graceRemaining = matchState.remainingTime + 3;
      const inactiveAtGrace = getAllianceShiftState(
        'teleop',
        graceRemaining,
        matchState.config.teleopDuration,
        matchState.config.endgameDuration,
        matchState.autoWinnerAlliance,
      );
      return inactiveAtGrace !== alliance;
    },
    [matchState],
  );

  const autoWinner = matchState?.autoWinnerAlliance ?? null;
  // An alliance is "in match" if the scoring engine says so
  const matchAlliances = score?.matchAlliances ?? [];
  const isMatchMode = score?.mode === 'match';
  const leftInMatch = matchAlliances.includes(left);
  const rightInMatch = matchAlliances.includes(right);

  // Client-interpolated remaining time — subtracts elapsed client time since last server update.
  // Keeps the timer smooth between 250ms server ticks. Uses setTick to re-evaluate each second.
  const displayRemaining = (() => {
    if (!matchState) return 0;
    const { phase, remainingTime } = matchState;
    if (phase === 'paused' || !COUNTING_PHASES.has(phase)) return remainingTime;
    const elapsed = (Date.now() - matchReceivedAt.current) / 1000;
    return Math.max(0, remainingTime - elapsed);
  })();

  // Timer colour and pulse for match mode
  const activeColor = matchState ? getActiveColor(matchState) : '#9e9e9e';
  const isActivePeriod =
    matchState &&
    (matchState.phase === 'auto' ||
      matchState.phase === 'teleop' ||
      matchState.phase === 'endgame' ||
      matchState.phase === 'countdown');
  const shouldPulse = !!(isActivePeriod && matchState && displayRemaining > 0 && displayRemaining <= 3);

  // Match timeline progress (0-1) — shown whenever any alliance is in a match
  const anyMatchActive = matchAlliances.length > 0;
  const matchProgress = useMemo(() => {
    if (!matchState || !anyMatchActive) return null;
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
  }, [matchState, anyMatchActive]);

  // Current sub-period for period breakdown highlight / future detection
  // (must be before the early return so hook count is stable)
  const currentSubPeriod: MatchSubPeriod | null = useMemo(() => {
    if (!matchState || !isMatchMode) return null;
    return getMatchSubPeriod(matchState.phase, displayRemaining, matchState.config.teleopDuration);
  }, [matchState, isMatchMode, displayRemaining]);

  // Background — split when only one side is in a match
  const scoreboardBg = getScoreboardBg(matchState, leftInMatch, rightInMatch);

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

  const isFreePlay = score.mode === 'freePlay';

  // Desaturation: match alliances desaturate when scoring stops counting
  // (after the 3-second grace period); freeplay alliances desaturate on batch timeout
  const leftBatchActive = left === 'red' ? score.redBatchActive : score.blueBatchActive;
  const rightBatchActive = right === 'red' ? score.redBatchActive : score.blueBatchActive;
  const leftActive = leftInMatch ? isScoringActive(left) : isFreePlay ? leftBatchActive : true;
  const rightActive = rightInMatch ? isScoringActive(right) : isFreePlay ? rightBatchActive : true;

  const leftBatches = score.recentBatches?.[left] ?? [];
  const rightBatches = score.recentBatches?.[right] ?? [];

  // Inactive scores for match alliances
  const leftInactive = score.inactiveScores?.[left]?.total ?? 0;
  const rightInactive = score.inactiveScores?.[right]?.total ?? 0;

  // Title text
  const titleText = isMatchMode
    ? (score.matchPhase ?? 'Match')
        .toString()
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toUpperCase()
    : 'FREE PLAY';

  // Freeplay-side labels for half-freeplay mode
  const leftLabel = isMatchMode && !leftInMatch ? 'FREE PLAY' : null;
  const rightLabel = isMatchMode && !rightInMatch ? 'FREE PLAY' : null;

  return (
    <Box
      sx={{
        position: 'relative',
        isolation: 'isolate',
        display: 'flex',
        flexDirection: 'column',
        height: window.__isCastReceiver ? '100vh' : '100dvh',
        background: scoreboardBg,
        color: '#fff',
        userSelect: 'none',
        transition: 'background 1s ease',
      }}
    >
      {/* Freeplay score-reactive glow backgrounds */}
      {isFreePlay && (
        <FreeplayGlow
          leftScore={score[left].total}
          rightScore={score[right].total}
          leftAlliance={left}
          rightAlliance={right}
        />
      )}

      {/* Controls — top right (hidden on Chromecast receiver) */}
      {!window.__isCastReceiver && (
        <Box
          sx={{ position: 'absolute', top: 12, right: 16, display: 'flex', gap: 1, alignItems: 'center', zIndex: 1 }}
        >
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

      {/* Match timeline progress bar — full width across top */}
      {matchProgress !== null && matchState && (
        <Box sx={{ px: 0 }}>
          <MatchTimeline
            config={matchState.config}
            progress={matchProgress}
            autoWinnerAlliance={autoWinner}
            phase={matchState.phase}
            remainingTime={displayRemaining}
          />
        </Box>
      )}

      {/* Title bar at top */}
      <Box sx={{ pt: 2, pb: 1, textAlign: 'center' }}>
        <Typography
          sx={{
            color: isMatchMode && matchState ? activeColor : 'rgba(255,255,255,0.5)',
            textTransform: 'uppercase',
            letterSpacing: 6,
            fontWeight: 800,
            fontSize: 'clamp(1.2rem, 3vw, 2rem)',
            textAlign: 'center',
            transition: 'color 1s ease',
          }}
        >
          {titleText}
        </Typography>
        {isFreePlay && (
          <Typography
            sx={{
              color: 'rgba(255,255,255,0.35)',
              fontSize: 'clamp(0.7rem, 1.5vw, 1rem)',
              mt: 0.25,
            }}
          >
            Scores reset after {score.batchTimeoutSeconds}s of inactivity
          </Typography>
        )}
      </Box>

      {/* Main score display — forced 50/50 split with period breakdowns on outside */}
      <Box
        sx={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
          alignItems: 'center',
          px: 'max(16px, 3vw)',
          minHeight: 0,
        }}
      >
        {/* Left alliance — flanking info + score box */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            pr: 2,
            gap: 2,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {isFreePlay && leftBatches.length > 0 && (
            <BatchList batches={leftBatches} color={left === 'red' ? '#ef5350' : '#42a5f5'} align="right" />
          )}
          {isMatchMode && leftInMatch && score.periodBreakdown && (
            <PeriodBreakdown
              alliance={left}
              breakdown={score.periodBreakdown}
              autoWinner={autoWinner}
              currentSubPeriod={currentSubPeriod}
              align="right"
            />
          )}
          <AllianceScoreBox
            alliance={left}
            total={score[left].total}
            active={leftActive}
            inactiveTotal={leftInMatch ? leftInactive : undefined}
            freePlayLabel={leftLabel}
            isAutoWinner={isMatchMode && autoWinner === left}
            isFreePlay={isFreePlay}
          />
        </Box>

        {/* Center panel */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1, minWidth: 120 }}>
          {/* Match countdown timer */}
          {isMatchMode && matchState && matchProgress !== null && (
            <MatchTimer
              remainingTime={displayRemaining}
              color={activeColor}
              pulse={shouldPulse}
              fontSize="clamp(2.5rem, 6vw, 5rem)"
            />
          )}
        </Box>

        {/* Right alliance — score box + period breakdown */}
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-start',
            alignItems: 'center',
            pl: 2,
            gap: 2,
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          <AllianceScoreBox
            alliance={right}
            total={score[right].total}
            active={rightActive}
            inactiveTotal={rightInMatch ? rightInactive : undefined}
            freePlayLabel={rightLabel}
            isAutoWinner={isMatchMode && autoWinner === right}
            isFreePlay={isFreePlay}
          />
          {isMatchMode && rightInMatch && score.periodBreakdown && (
            <PeriodBreakdown
              alliance={right}
              breakdown={score.periodBreakdown}
              autoWinner={autoWinner}
              currentSubPeriod={currentSubPeriod}
              align="left"
            />
          )}
          {isFreePlay && rightBatches.length > 0 && (
            <BatchList batches={rightBatches} color={right === 'red' ? '#ef5350' : '#42a5f5'} align="left" />
          )}
        </Box>
      </Box>

      {/* Battery voltage for connected robots */}
      <BatteryPanel matchState={matchState} leftAlliance={left} matchAlliances={matchAlliances} />
    </Box>
  );
}

// ── Freeplay Glow ─────────────────────────────────────────────────────

const GLOW_RGB = { red: '239, 83, 80', blue: '66, 165, 245' } as const;

function FreeplayGlow({
  leftScore,
  rightScore,
  leftAlliance,
  rightAlliance,
}: {
  leftScore: number;
  rightScore: number;
  leftAlliance: Alliance;
  rightAlliance: Alliance;
}) {
  return (
    <Box sx={{ position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none', overflow: 'hidden' }}>
      <GlowSpot score={leftScore} alliance={leftAlliance} side="left" />
      <GlowSpot score={rightScore} alliance={rightAlliance} side="right" />
    </Box>
  );
}

function GlowSpot({ score, alliance, side }: { score: number; alliance: Alliance; side: 'left' | 'right' }) {
  if (score <= 0) return null;

  const rgb = GLOW_RGB[alliance];
  // Normalized intensity 0→1 over the 0→400 range
  const t = Math.min(1, score / 400);

  // Core glow parameters — scale with score intensity
  const radius = 15 + t * 55; // 15% → 70%
  const opacity = 0.04 + t * 0.36; // 0.04 → 0.40
  const pulseDuration = 12 - t * 5; // 12 s → 7 s (gentle breathing)
  const pulseScale = 1 + t * 0.08; // 1.0× → 1.08× (subtle)

  // Wander parameters — gentle drift, not jumpy
  const w = 1 + t * 2.5; // 1% → 3.5% wander range
  const wanderDuration = 40 - t * 10; // 40 s → 30 s

  const cx = side === 'left' ? '25%' : '75%';

  // Primary gradient: multi-stop for natural radiance
  const layers = [
    `radial-gradient(circle at ${cx} 50%, rgba(${rgb}, ${opacity}) 0%, rgba(${rgb}, ${opacity * 0.4}) ${radius * 0.5}%, rgba(${rgb}, ${opacity * 0.1}) ${radius * 0.8}%, transparent ${radius}%)`,
  ];

  // Secondary haze layer at higher scores (>100 pts)
  if (t > 0.25) {
    const hazeOpacity = (t - 0.25) * 0.12;
    layers.unshift(
      `radial-gradient(circle at ${cx} 50%, rgba(${rgb}, ${hazeOpacity}) 0%, transparent ${radius * 1.5}%)`,
    );
  }

  // Outer element wanders, inner element pulses.
  // Pad beyond the container so the wander translate never exposes a gap at the edges.
  const pad = Math.ceil(w * 1.2); // enough to cover max wander displacement
  return (
    <Box
      sx={{
        position: 'absolute',
        inset: `-${pad}%`,
        '@keyframes glowWander': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '25%': { transform: `translate(${w * 0.6}%, ${-w * 0.4}%)` },
          '50%': { transform: `translate(${-w * 0.5}%, ${w * 0.3}%)` },
          '75%': { transform: `translate(${-w * 0.3}%, ${-w * 0.6}%)` },
        },
        animation: `glowWander ${wanderDuration}s ease-in-out infinite`,
      }}
    >
      <Box
        sx={{
          width: '100%',
          height: '100%',
          background: layers.join(', '),
          transformOrigin: `${cx} 50%`,
          '@keyframes glowPulse': {
            '0%, 100%': { transform: 'scale(1)' },
            '50%': { transform: `scale(${pulseScale})` },
          },
          animation: `glowPulse ${pulseDuration}s ease-in-out infinite`,
        }}
      />
    </Box>
  );
}

// ── Battery Panel ────────────────────────────────────────────────────

/** Per-station battery state tracked from telemetry. */
interface BatteryInfo {
  current: number;
  lastSeen: number;
}

function BatteryPanel({
  matchState,
  leftAlliance,
  matchAlliances,
}: {
  matchState: ReturnType<typeof useMatchState>;
  leftAlliance: Alliance;
  matchAlliances: Alliance[];
}) {
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

    // Sort: left alliance, then unassigned in the middle, then right alliance
    const rightAlliance = leftAlliance === 'red' ? 'blue' : 'red';
    result.sort((a, b) => {
      const order = (ally: Alliance | null) => (ally === leftAlliance ? 0 : ally === rightAlliance ? 2 : 1);
      return order(a.alliance) - order(b.alliance);
    });

    return result;
  }, [batteries, matchState, leftAlliance]);

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
        // Robots participating in a match get alliance colors; non-participants get white
        const inMatch = robot.alliance != null && matchAlliances.includes(robot.alliance);
        const color = inMatch ? (robot.alliance === 'red' ? '#ef5350' : '#42a5f5') : 'rgba(255,255,255,0.5)';
        const bgColor = inMatch
          ? robot.alliance === 'red'
            ? 'rgba(239,83,80,0.10)'
            : 'rgba(66,165,245,0.10)'
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
              width: 180,
              overflow: 'hidden',
            }}
          >
            {/* Chart with all info overlaid */}
            <Box sx={{ position: 'relative', '& canvas': { display: 'block', height: '52px !important' } }}>
              <SmoothieComponent
                responsive
                height={52}
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
              {/* Overlay: team, current V, min V — all on baseline */}
              <Box
                sx={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 1,
                  px: 0.75,
                  pb: 0.25,
                  pointerEvents: 'none',
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, flex: 1, minWidth: 0 }}>
                  <TeamAvatar teamNumber={robot.teamNumber} size={16} />
                  <Typography
                    sx={{
                      fontSize: '0.9rem',
                      fontWeight: 700,
                      color: 'rgba(255,255,255,0.7)',
                      textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {robot.teamNumber ?? robot.station}
                    {isDuplicate && (
                      <span style={{ color: 'rgba(255,255,255,0.3)', fontWeight: 400, fontSize: '0.7rem' }}>
                        {' '}
                        ({robot.station.replace('slot', '#')})
                      </span>
                    )}
                  </Typography>
                </Box>
                <Typography
                  sx={{
                    fontFamily: 'monospace',
                    fontSize: '1.1rem',
                    fontWeight: 700,
                    color,
                    textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {robot.battery.current.toFixed(1)}V
                </Typography>
                {!isNaN(minFloor) && (
                  <Typography
                    sx={{
                      fontFamily: 'monospace',
                      fontSize: '0.8rem',
                      color: 'rgba(244, 67, 54, 0.8)',
                      textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ↓{minFloor.toFixed(1)}V
                  </Typography>
                )}
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Period Breakdown ──────────────────────────────────────────────────

/** Ordered sub-periods for determining which are "in the future". */
const SUB_PERIOD_ORDER: MatchSubPeriod[] = ['auto', 'transition', 'shift1', 'shift2', 'shift3', 'shift4', 'endgame'];

function PeriodBreakdown({
  alliance,
  breakdown,
  autoWinner,
  currentSubPeriod,
  align,
}: {
  alliance: Alliance;
  breakdown: Record<string, { red: number; blue: number }>;
  autoWinner: Alliance | null;
  currentSubPeriod: MatchSubPeriod | null;
  /** Which side of the score box this panel sits on. */
  align: 'left' | 'right';
}) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const [scoring1, scoring2] = getAllianceScoringShifts(alliance, autoWinner);

  // Map display rows to their absolute sub-period keys
  const rows: { label: string; period: MatchSubPeriod }[] = [
    { label: 'Auto', period: 'auto' },
    { label: 'Transition', period: 'transition' },
    { label: 'Period 1', period: scoring1 },
    { label: 'Period 2', period: scoring2 },
    { label: 'Endgame', period: 'endgame' },
  ];

  // Determine which sub-periods are in the future
  const currentIdx = currentSubPeriod ? SUB_PERIOD_ORDER.indexOf(currentSubPeriod) : -1;
  const isFuture = (period: MatchSubPeriod) => {
    if (currentIdx < 0) return true; // no current period = all future (pre-match)
    return SUB_PERIOD_ORDER.indexOf(period) > currentIdx;
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      {rows.map(({ label, period }) => {
        const points = breakdown[period]?.[alliance] ?? 0;
        const future = isFuture(period);
        const isCurrent = currentSubPeriod === period;

        return (
          <Box
            key={label}
            sx={{
              display: 'flex',
              gap: 1.5,
              alignItems: 'baseline',
              flexDirection: align === 'right' ? 'row' : 'row-reverse',
            }}
          >
            <Typography
              sx={{
                color: 'rgba(255,255,255,0.35)',
                fontSize: 'clamp(0.6rem, 1.2vw, 0.8rem)',
                textTransform: 'uppercase',
                fontWeight: isCurrent ? 700 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </Typography>
            <Typography
              sx={{
                color: future ? 'rgba(255,255,255,0.15)' : color,
                fontFamily: 'monospace',
                fontSize: 'clamp(0.9rem, 1.8vw, 1.3rem)',
                fontWeight: 700,
                minWidth: '2ch',
                textAlign: align === 'right' ? 'right' : 'left',
              }}
            >
              {future ? '–' : points}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Alliance Score Box ────────────────────────────────────────────────

function AllianceScoreBox({
  alliance,
  total,
  active,
  inactiveTotal,
  freePlayLabel,
  isAutoWinner,
  isFreePlay,
}: {
  alliance: Alliance;
  total: number;
  active?: boolean;
  /** Goals scored while the hub was off (displayed as secondary count) */
  inactiveTotal?: number;
  /** If set, show this label instead of the alliance name (half-freeplay mode) */
  freePlayLabel?: string | null;
  /** Whether this alliance won auto */
  isAutoWinner?: boolean;
  /** Whether scoring is in freePlay mode (enables glow-proof bg + 400pt flourish) */
  isFreePlay?: boolean;
}) {
  const color = alliance === 'red' ? '#ef5350' : '#42a5f5';
  const rgb = alliance === 'red' ? '239, 83, 80' : '66, 165, 245';
  const bgColor = isFreePlay
    ? alliance === 'red'
      ? 'rgba(15, 3, 3, 0.65)'
      : 'rgba(3, 8, 18, 0.65)'
    : alliance === 'red'
      ? 'rgba(239,83,80,0.08)'
      : 'rgba(66,165,245,0.08)';
  const goalOff = active === false;
  const hasInactive = inactiveTotal != null && inactiveTotal > 0;

  // Border flourish at every 100-point crossing, intensity scales with level (freeplay only).
  // Uses a ref-managed timeout instead of effect cleanup so score updates don't cancel it early.
  const [flourishLevel, setFlourishLevel] = useState(0); // 0 = idle, 1+ = which hundred was crossed
  const prevHundred = useRef(Math.floor(total / 100));
  const flourishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isFreePlay) return;
    const cur = Math.floor(total / 100);
    const prev = prevHundred.current;
    prevHundred.current = cur;
    if (cur > prev && cur >= 1) {
      if (flourishTimer.current) clearTimeout(flourishTimer.current);
      setFlourishLevel(cur);
      flourishTimer.current = setTimeout(() => {
        setFlourishLevel(0);
        flourishTimer.current = null;
      }, 1600);
    }
    if (cur < prev) {
      if (flourishTimer.current) clearTimeout(flourishTimer.current);
      setFlourishLevel(0);
      flourishTimer.current = null;
    }
  }, [total, isFreePlay]);

  // Flourish intensity: 0.4 at 100 → 1.0 at 400+
  const fi = flourishLevel > 0 ? Math.min(1, (flourishLevel + 0.6) / 4.6) * 0.75 + 0.25 : 0;
  const peakBorder = flourishLevel >= 4 ? '#fff' : flourishLevel >= 3 ? `rgba(255,255,255,0.7)` : color;
  const peakOuterBlur = 15 + fi * 35;
  const peakOuterSpread = 4 + fi * 8;
  const peakOuterAlpha = 0.4 + fi * 0.5;
  const peakInnerBlur = 10 + fi * 25;
  const peakInnerAlpha = 0.15 + fi * 0.2;

  return (
    <Box
      sx={{
        textAlign: 'center',
        px: 6,
        py: 3,
        borderRadius: 2,
        border: `3px solid ${color}`,
        backgroundColor: bgColor,
        '@keyframes borderFlourish': {
          '0%': { borderColor: color, boxShadow: `0 0 0 0 rgba(${rgb}, 0)` },
          '15%': {
            borderColor: peakBorder,
            boxShadow: `0 0 ${peakOuterBlur}px ${peakOuterSpread}px rgba(${rgb}, ${peakOuterAlpha}), inset 0 0 ${peakInnerBlur}px rgba(${rgb}, ${peakInnerAlpha})`,
          },
          '50%': {
            borderColor: color,
            boxShadow: `0 0 ${peakOuterBlur * 0.6}px ${peakOuterSpread * 0.5}px rgba(${rgb}, ${peakOuterAlpha * 0.5}), inset 0 0 ${peakInnerBlur * 0.5}px rgba(${rgb}, ${peakInnerAlpha * 0.3})`,
          },
          '100%': { borderColor: color, boxShadow: `0 0 0 0 rgba(${rgb}, 0)` },
        },
        animation: flourishLevel > 0 ? `borderFlourish 1.5s ease-out` : undefined,
      }}
    >
      {/* Main score — desaturates abruptly when goal is off */}
      <Typography
        sx={{
          fontSize: 'clamp(4rem, 15vw, 12rem)',
          fontWeight: 800,
          fontFamily: 'monospace',
          color,
          lineHeight: 1,
          opacity: goalOff ? 0.3 : 1,
          filter: goalOff ? 'saturate(0.3)' : 'none',
        }}
      >
        {total}
      </Typography>
      {/* Off-goal count — swaps saturation prominence with main score */}
      {hasInactive && (
        <Typography
          sx={{
            color,
            fontSize: 'clamp(1.5rem, 4vw, 3rem)',
            fontFamily: 'monospace',
            fontWeight: 700,
            mt: 0.5,
            opacity: goalOff ? 1 : 0.3,
            filter: goalOff ? 'none' : 'saturate(0.3)',
          }}
        >
          +{inactiveTotal}
        </Typography>
      )}
      {freePlayLabel && (
        <Typography
          sx={{
            color: 'rgba(255,255,255,0.35)',
            textTransform: 'uppercase',
            letterSpacing: 6,
            fontWeight: 700,
            fontSize: '1.2rem',
            mt: 1,
          }}
        >
          {freePlayLabel}
        </Typography>
      )}
      {/* Auto winner badge — shown below the winning alliance's score */}
      {isAutoWinner && (
        <Typography
          sx={{
            color,
            fontSize: '0.8rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: 2,
            mt: 0.5,
            opacity: 0.8,
          }}
        >
          Auto Winner
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

function BatchList({ batches, color, align }: { batches: ScoreBatch[]; color: string; align: 'left' | 'right' }) {
  if (batches.length === 0) return null;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {batches.map((b, i) => (
        <Box
          key={i}
          sx={{
            display: 'flex',
            gap: 1,
            alignItems: 'baseline',
            flexDirection: align === 'right' ? 'row' : 'row-reverse',
            opacity: 1 - i * 0.15,
          }}
        >
          <Typography sx={{ color: 'rgba(255,255,255,0.25)', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
            {formatTimeAgo(b.endedAt)}
          </Typography>
          <Typography sx={{ color, fontFamily: 'monospace', fontSize: '1rem', fontWeight: 700 }}>{b.total}</Typography>
        </Box>
      ))}
    </Box>
  );
}
