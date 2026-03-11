import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { MatchPhase, MatchConfig, StationName, StationControlState } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  sendStationJoin,
  sendStationLeave,
  sendStationReady,
  sendStationStartMatch,
  sendStationPauseMatch,
  sendStationResumeMatch,
  sendStationAbandonMatch,
  sendUpdateMatchConfig,
} from '../hooks/useBackend';

const MIN_PERIOD = 0;
const MAX_PERIOD = 300;

function clampDuration(value: number): number {
  return Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, Math.round(value)));
}

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  countdown: 'warning.main',
  auto: 'info.main',
  autoPause: 'text.disabled',
  paused: 'warning.main',
  teleop: 'success.main',
  endgame: 'warning.main',
  postMatch: 'text.secondary',
};

const phaseLabels: Record<MatchPhase, string> = {
  idle: 'Idle',
  countdown: 'Countdown',
  auto: 'Autonomous',
  autoPause: 'Pause',
  paused: 'Paused',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const clamped = Math.max(0, remainingTime);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  return (
    <Typography
      variant="h2"
      sx={{
        fontFamily: 'monospace',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
        mb: 1,
      }}
    >
      {minutes}:{seconds.toString().padStart(2, '0')}
    </Typography>
  );
}

function TimingConfigEditor({ config }: { config: MatchConfig }) {
  const [auto, setAuto] = useState(config.autoDuration);
  const [teleop, setTeleop] = useState(config.teleopDuration);
  const [endgame, setEndgame] = useState(config.endgameDuration);
  const [pause, setPause] = useState(config.pauseDuration);

  // Sync local state when config changes externally (e.g., another station edits it)
  useEffect(() => {
    setAuto(prev => (prev !== config.autoDuration ? config.autoDuration : prev));
    setTeleop(prev => (prev !== config.teleopDuration ? config.teleopDuration : prev));
    setEndgame(prev => (prev !== config.endgameDuration ? config.endgameDuration : prev));
    setPause(prev => (prev !== config.pauseDuration ? config.pauseDuration : prev));
  }, [config.autoDuration, config.teleopDuration, config.endgameDuration, config.pauseDuration]);

  const handleChange = (field: keyof MatchConfig, value: number) => {
    const updated: MatchConfig = {
      autoDuration: auto,
      teleopDuration: teleop,
      endgameDuration: endgame,
      pauseDuration: pause,
      [field]: value,
    };
    if (field === 'autoDuration') setAuto(value);
    if (field === 'teleopDuration') setTeleop(value);
    if (field === 'endgameDuration') setEndgame(value);
    if (field === 'pauseDuration') setPause(value);
    sendUpdateMatchConfig(updated);
  };

  return (
    <Grid container spacing={1} sx={{ mt: 1 }}>
      <Grid size={{ xs: 6, sm: 3 }}>
        <TextField
          label="Auto (s)"
          type="number"
          size="small"
          fullWidth
          value={auto}
          onChange={e => handleChange('autoDuration', clampDuration(Number(e.target.value)))}
          slotProps={{ htmlInput: { min: 0, max: MAX_PERIOD } }}
        />
      </Grid>
      <Grid size={{ xs: 6, sm: 3 }}>
        <TextField
          label="Teleop (s)"
          type="number"
          size="small"
          fullWidth
          value={teleop}
          onChange={e => handleChange('teleopDuration', clampDuration(Number(e.target.value)))}
          slotProps={{ htmlInput: { min: 0, max: MAX_PERIOD } }}
        />
      </Grid>
      <Grid size={{ xs: 6, sm: 3 }}>
        <TextField
          label="Endgame (s)"
          type="number"
          size="small"
          fullWidth
          value={endgame}
          onChange={e => handleChange('endgameDuration', clampDuration(Number(e.target.value)))}
          slotProps={{ htmlInput: { min: 0, max: MAX_PERIOD } }}
        />
      </Grid>
      <Grid size={{ xs: 6, sm: 3 }}>
        <TextField
          label="Pause (s)"
          type="number"
          size="small"
          fullWidth
          value={pause}
          onChange={e => handleChange('pauseDuration', clampDuration(Number(e.target.value)))}
          slotProps={{ htmlInput: { min: 0, max: 10 } }}
        />
      </Grid>
    </Grid>
  );
}

/** Build a display label for a joined station chip, including team number and duplicate suffix. */
function stationChipLabel(
  station: StationName,
  state: StationControlState | undefined,
  allStates: Partial<Record<StationName, StationControlState>>,
) {
  const pretty = prettyStationName(station);
  const team = state?.teamNumber;
  if (!team) return pretty;

  // Check if another joined station shares the same team number
  const sameTeamStations = (Object.entries(allStates) as [StationName, StationControlState | undefined][])
    .filter(([s, st]) => st?.joined && st?.teamNumber === team && s !== station)
    .length;

  const suffix = state?.ready ? ' \u2713' : '';
  if (sameTeamStations > 0) {
    const tag = station[0].toUpperCase() + station.replace(/[a-z]+/g, '');
    return `${pretty} (${team}-${tag})${suffix}`;
  }
  return `${pretty} (${team})${suffix}`;
}

/**
 * Match control panel.
 * - With `station` prop: per-station view with join/leave/ready buttons (for station pages)
 * - Without `station` prop: master overview with global controls (for main page)
 */
export function MatchPanel({ station }: { station?: StationName }) {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config, stationStates } = matchState;

  const isActive = phase !== 'idle' && phase !== 'postMatch';
  const isPaused = phase === 'paused';
  const isPostMatch = phase === 'postMatch';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);
  const allReady = joinedStations.length > 0 && joinedStations.every(s => stationStates[s]?.ready);

  // Per-station state (only when station prop is provided)
  const myState = station ? stationStates[station] : undefined;
  const joined = myState?.joined ?? false;
  const ready = myState?.ready ?? false;

  // Master view: any station joined means we show controls
  const anyJoined = joinedStations.length > 0;
  const showConfigEditor = station ? joined && !isActive && !isPostMatch : anyJoined && !isActive && !isPostMatch;

  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = Math.min(100, (totalMatchTime / totalDuration) * 100);

  // Don't render the master panel at all if nothing is happening
  if (!station && !anyJoined && !isActive && !isPostMatch) return null;

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        {/* Phase display when active */}
        {(isActive || isPostMatch) && (
          <>
            <Box sx={{ textAlign: 'center', mb: 1 }}>
              <Chip
                label={phaseLabels[phase]}
                sx={{
                  fontSize: '1rem',
                  py: 2,
                  px: 1.5,
                  fontWeight: 'bold',
                  color: phaseColors[phase],
                  borderColor: phaseColors[phase],
                }}
                variant="outlined"
              />
            </Box>
            <MatchTimer remainingTime={remainingTime} phase={phase} />
            <LinearProgress variant="determinate" value={progress} sx={{ mb: 2, height: 6, borderRadius: 3 }} />
          </>
        )}

        {/* Idle / waiting: show who has joined */}
        {!isActive && !isPostMatch && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mb: 1.5 }}>
            {joinedStations.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No stations joined yet
              </Typography>
            )}
            {joinedStations.map(s => (
              <Chip
                key={s}
                label={stationChipLabel(s, stationStates[s], stationStates)}
                size="small"
                color={stationStates[s]?.ready ? 'success' : 'default'}
                variant="outlined"
              />
            ))}
          </Box>
        )}

        {/* Action buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {station && (
            <>
              {/* Not joined, not active: join button */}
              {!joined && !isActive && (
                <Button variant="contained" color="primary" onClick={() => sendStationJoin(station)}>
                  Join Match
                </Button>
              )}

              {/* Joined, not active: ready / leave */}
              {joined && !isActive && !isPostMatch && (
                <>
                  <Button
                    variant={ready ? 'outlined' : 'contained'}
                    color={ready ? 'warning' : 'success'}
                    onClick={() => sendStationReady(station, !ready)}
                  >
                    {ready ? 'Not Ready' : 'Ready'}
                  </Button>
                  <Button variant="outlined" color="error" onClick={() => sendStationLeave(station)} disabled={ready}>
                    Leave
                  </Button>
                </>
              )}

              {/* Post-match: leave to get control back */}
              {joined && isPostMatch && (
                <Button variant="outlined" color="primary" onClick={() => sendStationLeave(station)}>
                  Leave Match
                </Button>
              )}
            </>
          )}

          {/* Global controls: available in both master and station views */}
          {/* Start button: shown when all ready (station view: only if joined) */}
          {(!station || joined) && !isActive && !isPostMatch && allReady && (
            <Button variant="contained" color="success" sx={{ fontWeight: 'bold' }} onClick={sendStationStartMatch}>
              Start Match
            </Button>
          )}

          {/* Active match: pause */}
          {(!station || joined) && isActive && !isPaused && phase !== 'countdown' && phase !== 'autoPause' && (
            <Button variant="outlined" color="warning" onClick={sendStationPauseMatch}>
              Pause
            </Button>
          )}

          {/* Paused: resume / abandon */}
          {(!station || joined) && isPaused && (
            <>
              <Button variant="contained" color="success" onClick={sendStationResumeMatch}>
                Resume
              </Button>
              <Button variant="outlined" color="error" onClick={sendStationAbandonMatch}>
                Abandon
              </Button>
            </>
          )}
        </Box>

        {/* Timing config editor */}
        {showConfigEditor && <TimingConfigEditor config={config} />}
      </CardContent>
    </Card>
  );
}
