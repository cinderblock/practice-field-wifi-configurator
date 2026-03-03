import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';

import { MatchConfig, MatchPhase, StationName, StationNameList } from '../../../src/types';
import { allianceColor, prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  useLatest,
  sendAdminStartMatch,
  sendAdminStopMatch,
  sendAdminGlobalEStop,
  sendAdminStationEStop,
  sendAdminStationDisable,
  sendAdminClearEStop,
} from '../hooks/useBackend';

// 2026 FRC game defaults
const DEFAULT_AUTO = 20;
const DEFAULT_TELEOP = 110;
const DEFAULT_ENDGAME = 30;
const DEFAULT_PAUSE = 3;

const MIN_PERIOD = 0;
const MAX_PERIOD = 300;

function clampDuration(value: number): number {
  return Math.max(MIN_PERIOD, Math.min(MAX_PERIOD, Math.round(value)));
}

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  countdown: 'warning.main',
  auto: 'info.main',
  pause: 'text.disabled',
  teleop: 'success.main',
  endgame: 'warning.main',
  postMatch: 'text.secondary',
};

const phaseLabels: Record<MatchPhase, string> = {
  idle: 'Idle',
  countdown: 'Countdown',
  auto: 'Autonomous',
  pause: 'Pause',
  teleop: 'Teleoperated',
  endgame: 'Endgame',
  postMatch: 'Post-Match',
};

// ── Global E-Stop ───────────────────────────────────────────────────

function GlobalEStopSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <Button
        variant="contained"
        color="error"
        fullWidth
        sx={{ fontSize: '1.5rem', py: 2.5, mb: 3, fontWeight: 'bold' }}
        onClick={() => setConfirmOpen(true)}
      >
        EMERGENCY STOP ALL
      </Button>
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>Confirm Emergency Stop</DialogTitle>
        <DialogContent>
          <DialogContentText>This will E-Stop ALL stations and end the current match. Are you sure?</DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              sendAdminGlobalEStop();
              setConfirmOpen(false);
            }}
          >
            E-Stop All
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

// ── Per-Station Controls ────────────────────────────────────────────

function StationControlCard({ station }: { station: StationName }) {
  const matchState = useMatchState();
  const latest = useLatest();
  const stationState = matchState?.stationStates[station];
  const teamNumber = stationState?.teamNumber ?? null;
  const isRobotLinked = latest?.radioUpdate?.stationStatuses[station]?.isLinked ?? false;

  const title = teamNumber ? `Team ${teamNumber}` : prettyStationName(station);
  const subtitle = teamNumber ? prettyStationName(station) : null;

  return (
    <Card
      sx={{
        mb: 1,
        borderLeft: `4px solid ${allianceColor(station)}`,
      }}
    >
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Box>
            <Typography variant="subtitle1" fontWeight="bold">
              {title}
              {subtitle && (
                <Typography component="span" variant="body2" sx={{ ml: 1, color: 'text.secondary' }}>
                  {subtitle}
                </Typography>
              )}
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.5, mt: 0.5 }}>
              {isRobotLinked ? (
                <Chip label="Robot Linked" size="small" color="success" variant="outlined" />
              ) : teamNumber ? (
                <Chip label="No Robot" size="small" variant="outlined" color="warning" />
              ) : (
                <Chip label="No Team" size="small" variant="outlined" />
              )}
              {stationState?.eStop && <Chip label="E-STOP" size="small" color="error" />}
              {stationState?.enabled && <Chip label="Enabled" size="small" color="success" />}
              {!stationState?.enabled && !stationState?.eStop && (
                <Chip label="Disabled" size="small" variant="outlined" />
              )}
            </Box>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            {stationState?.eStop ? (
              <Button size="small" variant="outlined" onClick={() => sendAdminClearEStop(station)}>
                Clear E-Stop
              </Button>
            ) : (
              <>
                <Button
                  size="small"
                  variant="outlined"
                  color="warning"
                  onClick={() => sendAdminStationDisable(station)}
                  disabled={!stationState?.enabled}
                >
                  Disable
                </Button>
                <Button size="small" variant="contained" color="error" onClick={() => sendAdminStationEStop(station)}>
                  E-Stop
                </Button>
              </>
            )}
          </Box>
        </Box>
      </CardContent>
    </Card>
  );
}

function StationControlSection() {
  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          Teams & Controls
        </Typography>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 6 }}>
            {(['red1', 'red2', 'red3'] as StationName[]).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
          <Grid size={{ xs: 12, md: 6 }}>
            {(['blue1', 'blue2', 'blue3'] as StationName[]).map(s => (
              <StationControlCard key={s} station={s} />
            ))}
          </Grid>
        </Grid>
      </CardContent>
    </Card>
  );
}

// ── Match Timer ─────────────────────────────────────────────────────

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const clamped = Math.max(0, remainingTime);
  const minutes = Math.floor(clamped / 60);
  const seconds = Math.floor(clamped % 60);
  const display = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <Typography
      variant="h1"
      sx={{
        fontFamily: 'monospace',
        fontSize: '6rem',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
      }}
    >
      {display}
    </Typography>
  );
}

// ── Match Control ───────────────────────────────────────────────────

function MatchSetupForm() {
  const [autoDuration, setAutoDuration] = useState(DEFAULT_AUTO);
  const [teleopDuration, setTeleopDuration] = useState(DEFAULT_TELEOP);
  const [endgameDuration, setEndgameDuration] = useState(DEFAULT_ENDGAME);
  const [pauseDuration, setPauseDuration] = useState(DEFAULT_PAUSE);
  const [stations, setStations] = useState<StationName[]>([...StationNameList]);
  const matchState = useMatchState();

  const toggleStation = (s: StationName) => {
    setStations(prev => (prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]));
  };

  const handleStart = () => {
    const config: MatchConfig = {
      autoDuration,
      teleopDuration,
      endgameDuration: Math.min(endgameDuration, teleopDuration),
      pauseDuration,
      stations,
    };
    sendAdminStartMatch(config);
  };

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Match Setup
      </Typography>
      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField
            label="Auto (s)"
            type="number"
            value={autoDuration}
            onChange={e => setAutoDuration(clampDuration(Number(e.target.value)))}
            slotProps={{ htmlInput: { min: MIN_PERIOD, max: MAX_PERIOD } }}
            fullWidth
            size="small"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField
            label="Teleop (s)"
            type="number"
            value={teleopDuration}
            onChange={e => setTeleopDuration(clampDuration(Number(e.target.value)))}
            slotProps={{ htmlInput: { min: MIN_PERIOD, max: MAX_PERIOD } }}
            fullWidth
            size="small"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField
            label="Endgame (s)"
            type="number"
            value={endgameDuration}
            onChange={e => setEndgameDuration(clampDuration(Number(e.target.value)))}
            slotProps={{ htmlInput: { min: MIN_PERIOD, max: MAX_PERIOD } }}
            fullWidth
            size="small"
          />
        </Grid>
        <Grid size={{ xs: 6, sm: 3 }}>
          <TextField
            label="Pause (s)"
            type="number"
            value={pauseDuration}
            onChange={e => setPauseDuration(clampDuration(Number(e.target.value)))}
            slotProps={{ htmlInput: { min: MIN_PERIOD, max: 10 } }}
            fullWidth
            size="small"
          />
        </Grid>
      </Grid>

      <Typography variant="subtitle2" gutterBottom>
        Participating Stations
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
        {StationNameList.map(s => {
          const team = matchState?.stationStates[s]?.teamNumber;
          const label = team ? `Team ${team} (${prettyStationName(s)})` : prettyStationName(s);
          return (
            <FormControlLabel
              key={s}
              control={<Checkbox checked={stations.includes(s)} onChange={() => toggleStation(s)} size="small" />}
              label={label}
            />
          );
        })}
      </Box>

      <Button
        variant="contained"
        color="success"
        size="large"
        sx={{ mt: 2, fontWeight: 'bold' }}
        onClick={handleStart}
        disabled={stations.length === 0}
        fullWidth
      >
        Start Match
      </Button>
    </Box>
  );
}

function MatchLiveDisplay() {
  const matchState = useMatchState();
  if (!matchState || !matchState.config) return null;

  const { phase, remainingTime, totalMatchTime, config } = matchState;
  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = totalDuration > 0 ? Math.min(100, (totalMatchTime / totalDuration) * 100) : 0;

  return (
    <Box>
      <Box sx={{ textAlign: 'center', mb: 2 }}>
        <Chip
          label={phaseLabels[phase]}
          sx={{
            fontSize: '1.2rem',
            py: 2.5,
            px: 2,
            fontWeight: 'bold',
            color: phaseColors[phase],
            borderColor: phaseColors[phase],
          }}
          variant="outlined"
        />
      </Box>

      <MatchTimer remainingTime={remainingTime} phase={phase} />

      <LinearProgress variant="determinate" value={progress} sx={{ my: 2, height: 8, borderRadius: 4 }} />

      <Button
        variant="contained"
        color="error"
        size="large"
        fullWidth
        sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}
        onClick={sendAdminStopMatch}
      >
        Stop Match
      </Button>
    </Box>
  );
}

function MatchControlSection() {
  const matchState = useMatchState();
  const isIdle = !matchState || matchState.phase === 'idle' || matchState.phase === 'postMatch';

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>{isIdle ? <MatchSetupForm /> : <MatchLiveDisplay />}</CardContent>
    </Card>
  );
}

// ── Admin Page ──────────────────────────────────────────────────────

export function AdminPage() {
  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Field Admin
      </Typography>

      <GlobalEStopSection />
      <MatchControlSection />
      <StationControlSection />
    </Container>
  );
}
