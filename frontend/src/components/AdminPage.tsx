import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';

import { MatchPhase, StationName } from '../../../src/types';
import { allianceColor, prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  useLatest,
  sendAdminStopMatch,
  sendAdminGlobalEStop,
  sendAdminStationEStop,
  sendAdminStationDisable,
  sendAdminClearEStop,
} from '../hooks/useBackend';

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

// ── Global E-Stop ───────────────────────────────────────────────────

function GlobalEStopSection() {
  return (
    <Button
      variant="contained"
      color="error"
      fullWidth
      sx={{ fontSize: '1.5rem', py: 2.5, mb: 3, fontWeight: 'bold' }}
      onClick={() => sendAdminGlobalEStop()}
    >
      EMERGENCY STOP ALL
    </Button>
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
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
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
              {stationState?.joined && <Chip label="Joined" size="small" color="primary" variant="outlined" />}
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

// ── Match Status (read-only, admin can force-stop) ───────────────────

function MatchStatusSection() {
  const matchState = useMatchState();
  if (!matchState) return null;

  const { phase, remainingTime, totalMatchTime, config } = matchState;
  const isActive = phase !== 'idle' && phase !== 'postMatch';

  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = Math.min(100, (totalMatchTime / totalDuration) * 100);

  return (
    <Card sx={{ mb: 3 }}>
      <CardContent>
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

        {isActive && (
          <Button
            variant="contained"
            color="error"
            size="large"
            fullWidth
            sx={{ fontWeight: 'bold', fontSize: '1.1rem' }}
            onClick={sendAdminStopMatch}
          >
            Force Stop Match
          </Button>
        )}
      </CardContent>
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
      <MatchStatusSection />
      <StationControlSection />
    </Container>
  );
}
