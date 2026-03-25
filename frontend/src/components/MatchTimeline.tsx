import { useState, useEffect, useRef, useCallback } from 'react';
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

/** Standard snap values for durations */
const SNAP_VALUES = [0, 3, 5, 10, 15, 20, 25, 30, 45, 60, 90, 110, 120, 135, 150, 180, 210, 240, 270, 300];
const SNAP_THRESHOLD = 3; // seconds — snap to standard value if within this range

function snapToStandard(value: number): number {
  for (const snap of SNAP_VALUES) {
    if (Math.abs(value - snap) <= SNAP_THRESHOLD) return snap;
  }
  return Math.round(value);
}

const MIN_SEGMENT = 0;
const MAX_TOTAL = 600; // 10 minutes max total

type Segment = 'auto' | 'pause' | 'teleop' | 'endgame';

interface SegmentConfig {
  key: Segment;
  label: string;
  shortLabel: string;
  color: string;
  configKey: keyof Pick<MatchConfig, 'autoDuration' | 'pauseDuration' | 'teleopDuration' | 'endgameDuration'>;
}

const SEGMENTS: SegmentConfig[] = [
  { key: 'auto', label: 'Autonomous', shortLabel: 'Auto', color: '#2196f3', configKey: 'autoDuration' },
  { key: 'pause', label: 'Pause', shortLabel: 'P', color: '#9e9e9e', configKey: 'pauseDuration' },
  { key: 'teleop', label: 'Teleoperated', shortLabel: 'Teleop', color: '#4caf50', configKey: 'teleopDuration' },
  { key: 'endgame', label: 'Endgame', shortLabel: 'End', color: '#ff9800', configKey: 'endgameDuration' },
];

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
 * Visual match timeline with draggable segment boundaries.
 *
 * Segments are rendered as proportional flex-width colored bars.
 * Drag handles between segments let users adjust durations.
 * Includes "Skip Auto" checkbox and "Auto Winner" radio group.
 */
export function MatchTimeline({ config, disabled }: MatchTimelineProps) {
  // Local state for interactive editing (committed on pointer-up)
  const [durations, setDurations] = useState({
    auto: config.autoDuration,
    pause: config.pauseDuration,
    teleop: config.teleopDuration,
    endgame: config.endgameDuration,
  });
  const [skipAuto, setSkipAuto] = useState(config.skipAuto ?? false);
  const [autoWinner, setAutoWinner] = useState<AutoWinnerMode>(config.autoWinner ?? 'scores');
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [editValue, setEditValue] = useState('');

  // Sync from external config changes
  useEffect(() => {
    setDurations({
      auto: config.autoDuration,
      pause: config.pauseDuration,
      teleop: config.teleopDuration,
      endgame: config.endgameDuration,
    });
    setSkipAuto(config.skipAuto ?? false);
    setAutoWinner(config.autoWinner ?? 'scores');
  }, [
    config.autoDuration,
    config.pauseDuration,
    config.teleopDuration,
    config.endgameDuration,
    config.skipAuto,
    config.autoWinner,
  ]);

  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{
    handleIndex: number; // index between segment i and i+1
    startX: number;
    startDurations: typeof durations;
  } | null>(null);

  // Get visible segments (skip auto and pause if skipAuto is true)
  const visibleSegments = skipAuto ? SEGMENTS.filter(s => s.key !== 'auto' && s.key !== 'pause') : SEGMENTS;

  const total = visibleSegments.reduce((sum, s) => sum + durations[s.key], 0);

  const commitConfig = useCallback(
    (newDurations: typeof durations, newSkipAuto?: boolean, newAutoWinner?: AutoWinnerMode) => {
      const sa = newSkipAuto ?? skipAuto;
      const aw = newAutoWinner ?? autoWinner;
      sendUpdateMatchConfig({
        autoDuration: sa ? 0 : newDurations.auto,
        pauseDuration: sa ? 0 : newDurations.pause,
        teleopDuration: newDurations.teleop,
        endgameDuration: newDurations.endgame,
        skipAuto: sa,
        autoWinner: aw,
      });
    },
    [skipAuto, autoWinner],
  );

  // Drag handler
  const handlePointerDown = useCallback(
    (handleIndex: number, e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      draggingRef.current = {
        handleIndex,
        startX: e.clientX,
        startDurations: { ...durations },
      };
    },
    [durations, disabled],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag || !containerRef.current) return;

      const containerWidth = containerRef.current.getBoundingClientRect().width;
      const totalSeconds = visibleSegments.reduce((sum, s) => sum + drag.startDurations[s.key], 0);
      const pixelsPerSecond = containerWidth / Math.max(totalSeconds, 1);

      const dx = e.clientX - drag.startX;
      const dSeconds = dx / pixelsPerSecond;

      const leftSeg = visibleSegments[drag.handleIndex];
      const rightSeg = visibleSegments[drag.handleIndex + 1];
      if (!leftSeg || !rightSeg) return;

      const leftStart = drag.startDurations[leftSeg.key];
      const rightStart = drag.startDurations[rightSeg.key];

      let newLeft = snapToStandard(leftStart + dSeconds);
      let newRight = snapToStandard(rightStart - dSeconds);

      // Clamp
      if (newLeft < MIN_SEGMENT) {
        newRight += newLeft - MIN_SEGMENT;
        newLeft = MIN_SEGMENT;
      }
      if (newRight < MIN_SEGMENT) {
        newLeft += newRight - MIN_SEGMENT;
        newRight = MIN_SEGMENT;
      }
      newLeft = Math.max(MIN_SEGMENT, newLeft);
      newRight = Math.max(MIN_SEGMENT, newRight);

      setDurations(prev => ({
        ...prev,
        [leftSeg.key]: newLeft,
        [rightSeg.key]: newRight,
      }));
    },
    [visibleSegments],
  );

  const handlePointerUp = useCallback(() => {
    if (draggingRef.current) {
      draggingRef.current = null;
      commitConfig(durations);
    }
  }, [durations, commitConfig]);

  // Click a segment to edit duration numerically
  const handleSegmentClick = (seg: Segment) => {
    if (disabled) return;
    setEditingSegment(seg);
    setEditValue(String(durations[seg]));
  };

  const handleEditCommit = () => {
    if (!editingSegment) return;
    const val = Math.max(MIN_SEGMENT, Math.min(MAX_TOTAL, Math.round(Number(editValue) || 0)));
    const newDurations = { ...durations, [editingSegment]: val };
    setDurations(newDurations);
    setEditingSegment(null);
    commitConfig(newDurations);
  };

  const handleSkipAutoChange = (checked: boolean) => {
    setSkipAuto(checked);
    if (checked) {
      // When skipping auto, zero out auto and pause durations
      const newDurations = { ...durations, auto: 0, pause: 0 };
      setDurations(newDurations);
      commitConfig(newDurations, true);
    } else {
      // Restore to 2026 REBUILT defaults: 20s auto, 3s pause (scoring assessment)
      const newDurations = { ...durations, auto: 20, pause: 3 };
      setDurations(newDurations);
      commitConfig(newDurations, false);
    }
  };

  const handleAutoWinnerChange = (value: AutoWinnerMode) => {
    setAutoWinner(value);
    commitConfig(durations, undefined, value);
  };

  return (
    <Box sx={{ mb: 2 }}>
      {/* Timeline bar */}
      <Box
        ref={containerRef}
        sx={{
          display: 'flex',
          height: 48,
          borderRadius: 1,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          userSelect: 'none',
          cursor: disabled ? 'default' : undefined,
          opacity: disabled ? 0.5 : 1,
        }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {visibleSegments.map((seg, i) => {
          const duration = durations[seg.key];
          const isEditing = editingSegment === seg.key;
          const minWidth = duration > 0 ? 40 : 0;

          return (
            <Box key={seg.key} sx={{ display: 'contents' }}>
              {/* Segment */}
              <Tooltip title={`${seg.label}: ${formatDuration(duration)}`} arrow>
                <Box
                  onClick={() => handleSegmentClick(seg.key)}
                  sx={{
                    flex: duration,
                    minWidth: duration > 0 ? minWidth : 0,
                    backgroundColor: seg.color,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    cursor: disabled ? 'default' : 'pointer',
                    position: 'relative',
                    transition: draggingRef.current ? 'none' : 'flex 0.15s ease',
                    '&:hover': disabled
                      ? {}
                      : {
                          filter: 'brightness(1.1)',
                        },
                  }}
                >
                  {isEditing ? (
                    <input
                      type="number"
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={handleEditCommit}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleEditCommit();
                        if (e.key === 'Escape') setEditingSegment(null);
                      }}
                      autoFocus
                      style={{
                        width: '4em',
                        textAlign: 'center',
                        fontSize: '0.8rem',
                        fontWeight: 700,
                        border: 'none',
                        borderRadius: 4,
                        padding: '2px 4px',
                        background: 'rgba(255,255,255,0.9)',
                        color: '#000',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    duration > 0 && (
                      <Typography
                        sx={{
                          color: '#fff',
                          fontWeight: 700,
                          fontSize: duration >= 30 ? '0.85rem' : '0.7rem',
                          textShadow: '0 1px 2px rgba(0,0,0,0.4)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          px: 0.5,
                        }}
                      >
                        {duration >= 30 ? `${seg.shortLabel} ${formatDuration(duration)}` : formatDuration(duration)}
                      </Typography>
                    )
                  )}
                </Box>
              </Tooltip>

              {/* Drag handle between segments */}
              {i < visibleSegments.length - 1 && (
                <Box
                  onPointerDown={e => handlePointerDown(i, e)}
                  sx={{
                    width: 8,
                    cursor: disabled ? 'default' : 'col-resize',
                    backgroundColor: 'background.paper',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    '&:hover': disabled
                      ? {}
                      : {
                          backgroundColor: 'action.hover',
                          '& .drag-indicator': { opacity: 1 },
                        },
                  }}
                >
                  <Box
                    className="drag-indicator"
                    sx={{
                      width: 2,
                      height: '60%',
                      backgroundColor: 'text.disabled',
                      borderRadius: 1,
                      opacity: 0.5,
                      transition: 'opacity 0.15s',
                    }}
                  />
                </Box>
              )}
            </Box>
          );
        })}
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
        <FormControl disabled={disabled || skipAuto}>
          <FormLabel sx={{ fontSize: '0.75rem' }}>
            <Tooltip title="Determines which alliance's goal goes inactive first (REBUILT game data)" arrow>
              <span>Auto Winner</span>
            </Tooltip>
          </FormLabel>
          <RadioGroup row value={autoWinner} onChange={e => handleAutoWinnerChange(e.target.value as AutoWinnerMode)}>
            <FormControlLabel
              value="scores"
              control={<Radio size="small" />}
              label={<Typography variant="body2">Scores</Typography>}
            />
            <FormControlLabel
              value="red"
              control={<Radio size="small" sx={{ color: '#d32f2f', '&.Mui-checked': { color: '#d32f2f' } }} />}
              label={
                <Typography variant="body2" sx={{ color: skipAuto ? undefined : '#d32f2f' }}>
                  Red
                </Typography>
              }
            />
            <FormControlLabel
              value="blue"
              control={<Radio size="small" sx={{ color: '#1565c0', '&.Mui-checked': { color: '#1565c0' } }} />}
              label={
                <Typography variant="body2" sx={{ color: skipAuto ? undefined : '#1565c0' }}>
                  Blue
                </Typography>
              }
            />
          </RadioGroup>
        </FormControl>
      </Box>
    </Box>
  );
}
