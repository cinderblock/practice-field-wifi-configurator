import { useState, useEffect, useMemo } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { Alliance, MatchConfig, AutoWinnerMode } from '../../../src/types';
import { sendUpdateMatchConfig } from '../hooks/useBackend';

// ── Colors ──────────────────────────────────────────────────────────
const RED_SOLID = '#ef5350';
const BLUE_SOLID = '#42a5f5';
const AUTO_COLOR = '#2196f3';
const PAUSE_COLOR = '#9e9e9e';
const NEUTRAL_COLOR = '#66bb6a'; // Transition / endgame (both active)

// ── REBUILT shift timing within teleop ──────────────────────────────
const TRANSITION_DURATION = 10; // Both goals active
const SHIFT_DURATION = 25; // Each of 4 shifts

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

/**
 * CSS background for a shift sub-segment.
 *
 * - Winner known: solid red or blue
 *   Odd shifts (1, 3) = winner's color, even shifts (2, 4) = loser's color.
 * - Winner unknown: diagonal red/blue stripes, alternating direction at each
 *   shift boundary so consecutive shifts form a chevron pattern.
 */
function getShiftStyle(shiftIndex: number, winner: Alliance | null): React.CSSProperties {
  if (!winner) {
    const angle = shiftIndex % 2 === 0 ? 45 : -45;
    return {
      background: `repeating-linear-gradient(${angle}deg, ${RED_SOLID} 0px, ${RED_SOLID} 6px, ${BLUE_SOLID} 6px, ${BLUE_SOLID} 12px)`,
    };
  }
  // Known winner: shifts 0,2 (1st,3rd) = winner; shifts 1,3 (2nd,4th) = loser
  const isWinnerShift = shiftIndex % 2 === 0;
  const winnerColor = winner === 'red' ? RED_SOLID : BLUE_SOLID;
  const loserColor = winner === 'red' ? BLUE_SOLID : RED_SOLID;
  return { backgroundColor: isWinnerShift ? winnerColor : loserColor };
}

// ── Component ───────────────────────────────────────────────────────

interface MatchTimelineProps {
  config: MatchConfig;
  disabled?: boolean;
  /** Actual auto winner alliance (set after auto period ends). */
  autoWinnerAlliance?: Alliance | null;
  /**
   * When provided (0-1), the timeline doubles as a progress bar:
   * a dark mask covers the future portion and a white cursor marks the
   * current position.  Controls are hidden in progress mode.
   */
  progress?: number;
}

/**
 * Match timeline visualisation.
 *
 * Shows the official 2026 REBUILT match structure as a proportional bar:
 *   Auto (20 s) │ Pause (5 s) │ Teleop (110 s, with shift colouring)
 *
 * Teleop is subdivided into:
 *   10 s transition │ 25 s shift 1 │ 25 s shift 2 │ 25 s shift 3 │ 25 s shift 4
 * with an endgame marker at the appropriate position.
 *
 * When `progress` is supplied, the bar acts as a live progress indicator.
 * Otherwise it shows the static plan with Skip-Auto / Auto-Winner controls.
 */
export function MatchTimeline({ config, disabled, autoWinnerAlliance, progress }: MatchTimelineProps) {
  const isProgressMode = progress !== undefined;

  // ── Local state for controls ────────────────────────────────────
  const [skipAuto, setSkipAuto] = useState(config.skipAuto ?? false);
  const [autoWinner, setAutoWinner] = useState<AutoWinnerMode>(config.autoWinner ?? 'scores');

  useEffect(() => {
    setSkipAuto(config.skipAuto ?? false);
    setAutoWinner(config.autoWinner ?? 'scores');
  }, [config.skipAuto, config.autoWinner]);

  // ── Visual winner ───────────────────────────────────────────────
  // During progress mode: use actual auto winner.
  // During config mode: infer from selected mode.
  const visualWinner: Alliance | null = useMemo(() => {
    if (autoWinnerAlliance) return autoWinnerAlliance;
    const mode = config.autoWinner ?? 'scores';
    if (mode === 'red') return 'red';
    if (mode === 'blue') return 'blue';
    return null;
  }, [autoWinnerAlliance, config.autoWinner]);

  // ── Durations ───────────────────────────────────────────────────
  const hasAuto = !skipAuto;
  const autoDuration = hasAuto ? config.autoDuration : 0;
  const pauseDuration = hasAuto ? config.pauseDuration : 0;
  const teleopTotal = config.teleopDuration; // 110 s (includes endgame)
  const barTotal = autoDuration + pauseDuration + teleopTotal;

  // Endgame marker position (seconds into teleop section)
  const endgameStartInTeleop = teleopTotal - config.endgameDuration;

  // ── Handlers ────────────────────────────────────────────────────
  const handleSkipAutoChange = (checked: boolean) => {
    setSkipAuto(checked);
    const newAutoWinner = checked && (autoWinner === 'scores' || autoWinner === 'pause') ? 'red' : autoWinner;
    if (checked && newAutoWinner !== autoWinner) setAutoWinner(newAutoWinner);
    sendUpdateMatchConfig({ ...config, skipAuto: checked, autoWinner: newAutoWinner });
  };

  const handleAutoWinnerChange = (value: AutoWinnerMode) => {
    setAutoWinner(value);
    sendUpdateMatchConfig({ ...config, skipAuto, autoWinner: value });
  };

  const autoWinnerOptions: { value: AutoWinnerMode; label: string; color?: string }[] = skipAuto
    ? [
        { value: 'red', label: 'Red', color: '#d32f2f' },
        { value: 'blue', label: 'Blue', color: '#1565c0' },
      ]
    : [
        { value: 'scores', label: 'Scores' },
        { value: 'red', label: 'Red', color: '#d32f2f' },
        { value: 'blue', label: 'Blue', color: '#1565c0' },
        { value: 'pause', label: 'Pause' },
      ];

  // ── Render ──────────────────────────────────────────────────────
  return (
    <Box sx={{ mb: isProgressMode ? 0 : 2 }}>
      {/* ── Timeline bar ─────────────────────────────────────────── */}
      <Box
        sx={{
          display: 'flex',
          height: isProgressMode ? 32 : 48,
          borderRadius: 1,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
          position: 'relative',
        }}
      >
        {/* Auto section */}
        {hasAuto && (
          <Tooltip title={`Autonomous: ${formatDuration(autoDuration)}`} arrow>
            <Box
              sx={{
                flex: autoDuration,
                minWidth: 32,
                backgroundColor: AUTO_COLOR,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography
                sx={{
                  color: '#fff',
                  fontWeight: 700,
                  fontSize: '0.8rem',
                  textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                  whiteSpace: 'nowrap',
                  px: 0.5,
                }}
              >
                Auto {formatDuration(autoDuration)}
              </Typography>
            </Box>
          </Tooltip>
        )}

        {/* Pause section */}
        {hasAuto && (
          <Tooltip title={`Pause: ${formatDuration(pauseDuration)}`} arrow>
            <Box
              sx={{
                flex: pauseDuration,
                minWidth: pauseDuration > 0 ? 20 : 0,
                backgroundColor: PAUSE_COLOR,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {!isProgressMode && (
                <Typography
                  sx={{
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: '0.65rem',
                    textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                  }}
                >
                  {formatDuration(pauseDuration)}
                </Typography>
              )}
            </Box>
          </Tooltip>
        )}

        {/* Teleop section — contains shift sub-segments */}
        <Tooltip title={`Teleoperated: ${formatDuration(teleopTotal)}`} arrow>
          <Box
            sx={{
              flex: teleopTotal,
              display: 'flex',
              position: 'relative',
              minWidth: 0,
            }}
          >
            {/* Transition (both active) */}
            <Box sx={{ flex: TRANSITION_DURATION, backgroundColor: NEUTRAL_COLOR }} />

            {/* 4 shifts */}
            {[0, 1, 2, 3].map(i => (
              <Box key={i} sx={{ flex: SHIFT_DURATION, ...getShiftStyle(i, visualWinner) }} />
            ))}

            {/* "Teleop" label centred over the section */}
            <Typography
              sx={{
                position: 'absolute',
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%)',
                color: '#fff',
                fontWeight: 700,
                fontSize: isProgressMode ? '0.75rem' : '0.85rem',
                textShadow: '0 1px 3px rgba(0,0,0,0.7)',
                whiteSpace: 'nowrap',
                pointerEvents: 'none',
              }}
            >
              Teleop {formatDuration(teleopTotal)}
            </Typography>

            {/* Endgame marker line */}
            <Box
              sx={{
                position: 'absolute',
                left: `${(endgameStartInTeleop / teleopTotal) * 100}%`,
                top: 0,
                bottom: 0,
                width: 2,
                backgroundColor: 'rgba(255,255,255,0.45)',
                pointerEvents: 'none',
              }}
            >
              {!isProgressMode && (
                <Typography
                  sx={{
                    position: 'absolute',
                    bottom: 2,
                    left: 4,
                    color: 'rgba(255,255,255,0.85)',
                    fontSize: '0.55rem',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  Endgame
                </Typography>
              )}
            </Box>
          </Box>
        </Tooltip>

        {/* ── Progress cursor & future mask ───────────────────────── */}
        {isProgressMode && (
          <Box
            sx={{
              position: 'absolute',
              left: `${Math.min(100, Math.max(0, progress * 100))}%`,
              right: 0,
              top: 0,
              bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.45)',
              borderLeft: '2px solid #fff',
              pointerEvents: 'none',
              transition: 'left 0.3s linear',
            }}
          />
        )}
      </Box>

      {/* ── Total label ──────────────────────────────────────────── */}
      {!isProgressMode && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          Total: {formatDuration(barTotal)}
        </Typography>
      )}

      {/* ── Controls (config mode only) ──────────────────────────── */}
      {!isProgressMode && (
        <Box sx={{ display: 'flex', gap: 3, mt: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          {/* Skip Auto checkbox */}
          <FormControlLabel
            control={
              <Checkbox
                checked={skipAuto}
                onChange={(_, checked) => handleSkipAutoChange(checked)}
                disabled={disabled}
                size="small"
              />
            }
            label={<Typography variant="body2">Skip Auto</Typography>}
          />

          {/* Auto Winner selector */}
          <FormControl disabled={disabled}>
            <FormLabel sx={{ fontSize: '0.75rem' }}>
              <Tooltip title="Determines which alliance's goal goes inactive first (REBUILT game data)" arrow>
                <span>Auto Winner</span>
              </Tooltip>
            </FormLabel>
            <RadioGroup row value={autoWinner} onChange={e => handleAutoWinnerChange(e.target.value as AutoWinnerMode)}>
              {autoWinnerOptions.map(opt => (
                <FormControlLabel
                  key={opt.value}
                  value={opt.value}
                  control={
                    <Radio
                      size="small"
                      sx={opt.color ? { color: opt.color, '&.Mui-checked': { color: opt.color } } : undefined}
                    />
                  }
                  label={
                    <Typography variant="body2" sx={opt.color ? { color: opt.color } : undefined}>
                      {opt.label}
                    </Typography>
                  }
                />
              ))}
            </RadioGroup>
          </FormControl>
        </Box>
      )}
    </Box>
  );
}
