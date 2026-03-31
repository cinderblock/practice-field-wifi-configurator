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
const NEUTRAL_COLOR = '#66bb6a'; // Both hubs active (auto, transition, endgame)
const PAUSE_COLOR = '#9e9e9e';
const SKIPPED_COLOR = '#bdbdbd'; // Greyed-out auto when skipped

// ── REBUILT shift timing within teleop ──────────────────────────────
const TRANSITION_DURATION = 10;
const SHIFT_DURATION = 25;
const ENDGAME_DURATION = 30;

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

/** Shared text style for phase labels inside the bar. */
const phaseLabelSx = {
  color: '#fff',
  fontWeight: 700,
  textShadow: '0 1px 2px rgba(0,0,0,0.4)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  px: 0.5,
  lineHeight: 1,
} as const;

/**
 * CSS background for a shift sub-segment.
 *
 * - Winner known: solid colour.
 *   Shifts 0,2 (1st,3rd) = loser; shifts 1,3 (2nd,4th) = winner.
 * - Winner unknown: diagonal red/blue stripes, alternating direction.
 */
function getShiftStyle(shiftIndex: number, winner: Alliance | null): React.CSSProperties {
  if (!winner) {
    const angle = shiftIndex % 2 === 0 ? 45 : -45;
    return {
      background: `repeating-linear-gradient(${angle}deg, ${RED_SOLID} 0px, ${RED_SOLID} 6px, ${BLUE_SOLID} 6px, ${BLUE_SOLID} 12px)`,
    };
  }
  const isLoserShift = shiftIndex % 2 === 0;
  const winnerColor = winner === 'red' ? RED_SOLID : BLUE_SOLID;
  const loserColor = winner === 'red' ? BLUE_SOLID : RED_SOLID;
  return { backgroundColor: isLoserShift ? loserColor : winnerColor };
}

// ── Component ───────────────────────────────────────────────────────

interface MatchTimelineProps {
  config: MatchConfig;
  disabled?: boolean;
  autoWinnerAlliance?: Alliance | null;
  /** 0-1 progress; when set, the bar acts as a live progress indicator. */
  progress?: number;
}

export function MatchTimeline({ config, disabled, autoWinnerAlliance, progress }: MatchTimelineProps) {
  const isProgressMode = progress !== undefined;

  const [skipAuto, setSkipAuto] = useState(config.skipAuto ?? false);
  const [autoWinner, setAutoWinner] = useState<AutoWinnerMode>(config.autoWinner ?? 'scores');

  useEffect(() => {
    setSkipAuto(config.skipAuto ?? false);
    setAutoWinner(config.autoWinner ?? 'scores');
  }, [config.skipAuto, config.autoWinner]);

  const visualWinner: Alliance | null = useMemo(() => {
    if (autoWinnerAlliance) return autoWinnerAlliance;
    const mode = config.autoWinner ?? 'scores';
    if (mode === 'red') return 'red';
    if (mode === 'blue') return 'blue';
    return null;
  }, [autoWinnerAlliance, config.autoWinner]);

  // ── Durations ───────────────────────────────────────────────────
  // Auto + pause are always in the bar (greyed when skipped, not hidden)
  const autoDuration = config.autoDuration; // 20 s
  const pauseDuration = config.pauseDuration; // 3 s
  const teleopTotal = config.teleopDuration; // 140 s
  const barTotal = autoDuration + pauseDuration + teleopTotal;

  // Font size adapts to bar height
  const fontSize = isProgressMode ? '0.65rem' : '0.75rem';

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
        {/* AUTO — green (greyed out when skipped) */}
        <Tooltip title={`Autonomous: ${formatDuration(autoDuration)}`} arrow>
          <Box
            sx={{
              flex: autoDuration,
              minWidth: 32,
              backgroundColor: skipAuto ? SKIPPED_COLOR : NEUTRAL_COLOR,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: skipAuto ? 0.6 : 1,
            }}
          >
            <Typography sx={{ ...phaseLabelSx, fontSize, opacity: skipAuto ? 0.7 : 1 }}>AUTO</Typography>
          </Box>
        </Tooltip>

        {/* Pause — no text label */}
        <Tooltip title={`Scoring Delay: ${formatDuration(pauseDuration)}`} arrow>
          <Box
            sx={{
              flex: pauseDuration,
              minWidth: pauseDuration > 0 ? 8 : 0,
              backgroundColor: skipAuto ? SKIPPED_COLOR : PAUSE_COLOR,
              opacity: skipAuto ? 0.6 : 1,
            }}
          />
        </Tooltip>

        {/* Teleop section — sub-segments with per-phase labels */}
        <Box
          sx={{
            flex: teleopTotal,
            display: 'flex',
            minWidth: 0,
          }}
        >
          {/* TS — Transition Shift */}
          <Tooltip title="Transition Shift" arrow>
            <Box
              sx={{
                flex: TRANSITION_DURATION,
                backgroundColor: NEUTRAL_COLOR,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography sx={{ ...phaseLabelSx, fontSize }}>TS</Typography>
            </Box>
          </Tooltip>

          {/* S1-S4 — shifts */}
          {[0, 1, 2, 3].map(i => (
            <Tooltip key={i} title={`Shift ${i + 1}: ${formatDuration(SHIFT_DURATION)}`} arrow>
              <Box
                sx={{
                  flex: SHIFT_DURATION,
                  ...getShiftStyle(i, visualWinner),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Typography sx={{ ...phaseLabelSx, fontSize }}>S{i + 1}</Typography>
              </Box>
            </Tooltip>
          ))}

          {/* END GAME */}
          <Tooltip title={`End Game: ${formatDuration(ENDGAME_DURATION)}`} arrow>
            <Box
              sx={{
                flex: ENDGAME_DURATION,
                backgroundColor: NEUTRAL_COLOR,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Typography sx={{ ...phaseLabelSx, fontSize }}>END GAME</Typography>
            </Box>
          </Tooltip>
        </Box>

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

      {/* ── Duration labels ──────────────────────────────────────── */}
      {!isProgressMode && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
          Total: {formatDuration(barTotal)} &middot; Teleop: {formatDuration(teleopTotal)}
        </Typography>
      )}

      {/* ── Controls (config mode only) ──────────────────────────── */}
      {!isProgressMode && (
        <Box sx={{ display: 'flex', gap: 3, mt: 1, flexWrap: 'wrap', alignItems: 'flex-start' }}>
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
