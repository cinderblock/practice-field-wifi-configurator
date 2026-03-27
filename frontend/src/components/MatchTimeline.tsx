import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormControl from '@mui/material/FormControl';
import FormLabel from '@mui/material/FormLabel';
import Radio from '@mui/material/Radio';
import RadioGroup from '@mui/material/RadioGroup';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { MatchConfig, AutoWinnerMode } from '../../../src/types';
import { sendUpdateMatchConfig } from '../hooks/useBackend';

interface SegmentDisplay {
  label: string;
  shortLabel: string;
  color: string;
  duration: number;
}

function formatDuration(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

interface MatchTimelineProps {
  config: MatchConfig;
  disabled?: boolean;
}

/**
 * Static match timeline display showing official period durations.
 * No drag handles — durations are fixed to official 2026 REBUILT timing.
 * Includes "Skip Auto" checkbox and "Auto Winner" radio group.
 */
export function MatchTimeline({ config, disabled }: MatchTimelineProps) {
  const [skipAuto, setSkipAuto] = useState(config.skipAuto ?? false);
  const [autoWinner, setAutoWinner] = useState<AutoWinnerMode>(config.autoWinner ?? 'scores');

  // Sync from external config changes
  useEffect(() => {
    setSkipAuto(config.skipAuto ?? false);
    setAutoWinner(config.autoWinner ?? 'scores');
  }, [config.skipAuto, config.autoWinner]);

  // Build visible segments based on config
  const segments: SegmentDisplay[] = skipAuto
    ? [
        { label: 'Teleoperated', shortLabel: 'Teleop', color: '#4caf50', duration: config.teleopDuration },
        { label: 'Endgame', shortLabel: 'End', color: '#ff9800', duration: config.endgameDuration },
      ]
    : [
        { label: 'Autonomous', shortLabel: 'Auto', color: '#2196f3', duration: config.autoDuration },
        { label: 'Pause', shortLabel: 'P', color: '#9e9e9e', duration: config.pauseDuration },
        { label: 'Teleoperated', shortLabel: 'Teleop', color: '#4caf50', duration: config.teleopDuration },
        { label: 'Endgame', shortLabel: 'End', color: '#ff9800', duration: config.endgameDuration },
      ];

  const total = segments.reduce((sum, s) => sum + s.duration, 0);

  const handleSkipAutoChange = (checked: boolean) => {
    setSkipAuto(checked);
    // When skipping auto, force auto winner to 'red' if currently 'scores' or 'pause'
    const newAutoWinner = checked && (autoWinner === 'scores' || autoWinner === 'pause') ? 'red' : autoWinner;
    if (checked && newAutoWinner !== autoWinner) {
      setAutoWinner(newAutoWinner);
    }
    sendUpdateMatchConfig({
      ...config,
      skipAuto: checked,
      autoWinner: newAutoWinner,
    });
  };

  const handleAutoWinnerChange = (value: AutoWinnerMode) => {
    setAutoWinner(value);
    sendUpdateMatchConfig({
      ...config,
      skipAuto,
      autoWinner: value,
    });
  };

  // When skipAuto is checked, only 'red' and 'blue' are valid auto winner modes
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
    <Box sx={{ mb: 2 }}>
      {/* Timeline bar — static, no drag handles */}
      <Box
        sx={{
          display: 'flex',
          height: 48,
          borderRadius: 1,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {segments.map(seg => (
          <Tooltip key={seg.shortLabel} title={`${seg.label}: ${formatDuration(seg.duration)}`} arrow>
            <Box
              sx={{
                flex: seg.duration,
                minWidth: seg.duration > 0 ? 40 : 0,
                backgroundColor: seg.color,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'flex 0.15s ease',
              }}
            >
              {seg.duration > 0 && (
                <Typography
                  sx={{
                    color: '#fff',
                    fontWeight: 700,
                    fontSize: seg.duration >= 30 ? '0.85rem' : '0.7rem',
                    textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    px: 0.5,
                  }}
                >
                  {seg.duration >= 30
                    ? `${seg.shortLabel} ${formatDuration(seg.duration)}`
                    : formatDuration(seg.duration)}
                </Typography>
              )}
            </Box>
          </Tooltip>
        ))}
      </Box>

      {/* Total duration label */}
      <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
        Total: {formatDuration(total)}
      </Typography>

      {/* Controls below the timeline */}
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
    </Box>
  );
}
