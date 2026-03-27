import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { Alliance, MatchPhase, StationName, StationControlState } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  sendMatchCreate,
  sendMatchCancel,
  sendMatchSwapStation,
  sendMatchSetAutoWinner,
  sendStationStartMatch,
  sendStationPauseMatch,
  sendStationResumeMatch,
  sendStationAbandonMatch,
  sendAdminStationDisable,
  sendAdminStationEStop,
  sendAdminGlobalEStop,
  sendAdminClearEStop,
} from '../hooks/useBackend';
import { MatchTimeline } from './MatchTimeline';
import { getAllianceShiftState } from '../utils/shiftState';

const phaseColors: Record<MatchPhase, string> = {
  idle: 'text.secondary',
  created: 'info.main',
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
  created: 'Match Created',
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
      variant="h1"
      sx={{
        fontFamily: 'monospace',
        textAlign: 'center',
        color: phaseColors[phase],
        lineHeight: 1,
        mb: 2,
      }}
    >
      {minutes}:{seconds.toString().padStart(2, '0')}
    </Typography>
  );
}

function getProgressBarColor(inactiveAlliance: Alliance | null): string {
  if (inactiveAlliance === 'red') return '#42a5f5';
  if (inactiveAlliance === 'blue') return '#ef5350';
  return '#4caf50';
}

function stationLabel(station: StationName, state: StationControlState | undefined): string {
  const team = state?.teamNumber;
  const pretty = prettyStationName(station);
  return team ? `${pretty} (${team})` : pretty;
}

/**
 * The dedicated match controller page at /match.
 *
 * Manages the full match lifecycle: create → setup → start → control → post-match.
 * Only this page has access to start/pause/resume/abandon/e-stop/disable controls.
 */
export function MatchControlPage() {
  const matchState = useMatchState();

  if (!matchState) {
    return (
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Typography variant="h4" sx={{ mb: 2, fontWeight: 700 }}>
          Match Control
        </Typography>
        <Typography color="text.secondary">Connecting...</Typography>
      </Container>
    );
  }

  const { phase } = matchState;

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Match Control
        </Typography>
        <Chip
          label={phaseLabels[phase]}
          sx={{
            fontWeight: 'bold',
            color: phaseColors[phase],
            borderColor: phaseColors[phase],
          }}
          variant="outlined"
        />
      </Box>

      {phase === 'idle' && <IdleView />}
      {phase === 'created' && <CreatedView matchState={matchState} />}
      {phase === 'postMatch' && <PostMatchView matchState={matchState} />}
      {phase !== 'idle' && phase !== 'created' && phase !== 'postMatch' && <ActiveMatchView matchState={matchState} />}
    </Container>
  );
}

/** Idle state — big Create Match button */
function IdleView() {
  return (
    <Card>
      <CardContent sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          No match in progress. Create a match to allow teams to join.
        </Typography>
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={sendMatchCreate}
          sx={{ px: 6, py: 1.5, fontSize: '1.2rem', fontWeight: 'bold' }}
        >
          Create Match
        </Button>
      </CardContent>
    </Card>
  );
}

/** Created state — pre-match setup with participants, config, and start controls */
function CreatedView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { config, stationStates } = matchState;

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');
  const allReady = joinedStations.length > 0 && joinedStations.every(s => stationStates[s]?.ready);

  return (
    <>
      {/* Participants */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1.5 }}>
            Participants
          </Typography>

          {joinedStations.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Waiting for teams to join from their control pages...
            </Typography>
          ) : (
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {/* Red Alliance */}
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 1 }}>
                  Red Alliance
                </Typography>
                {redStations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No teams
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {redStations.map(s => (
                      <ParticipantRow
                        key={s}
                        station={s}
                        state={stationStates[s]}
                        onSwap={() => sendMatchSwapStation(s)}
                      />
                    ))}
                  </Box>
                )}
              </Box>

              {/* Blue Alliance */}
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 1 }}>
                  Blue Alliance
                </Typography>
                {blueStations.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No teams
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {blueStations.map(s => (
                      <ParticipantRow
                        key={s}
                        station={s}
                        state={stationStates[s]}
                        onSwap={() => sendMatchSwapStation(s)}
                      />
                    ))}
                  </Box>
                )}
              </Box>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Match Config */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Match Configuration
          </Typography>
          <MatchTimeline config={config} />
        </CardContent>
      </Card>

      {/* Start / Cancel controls */}
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
            <Button
              variant="contained"
              color="success"
              size="large"
              disabled={!allReady}
              onClick={sendStationStartMatch}
              sx={{ px: 6, fontWeight: 'bold' }}
            >
              Start Match
            </Button>
            <Button variant="outlined" color="error" onClick={sendMatchCancel}>
              Cancel Match
            </Button>
          </Box>
          {!allReady && joinedStations.length > 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, textAlign: 'center' }}>
              Waiting for all teams to ready up...
            </Typography>
          )}
          {joinedStations.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1, textAlign: 'center' }}>
              At least one team must join before starting.
            </Typography>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** A single participant row in the pre-match setup */
function ParticipantRow({
  station,
  state,
  onSwap,
}: {
  station: StationName;
  state: StationControlState | undefined;
  onSwap: () => void;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {stationLabel(station, state)}
        </Typography>
        {state?.ready && <Chip label="Ready" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
      </Box>
      <Button size="small" variant="outlined" onClick={onSwap}>
        Swap
      </Button>
    </Box>
  );
}

/** Active match — timer, progress bar, robot controls */
function ActiveMatchView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { phase, remainingTime, totalMatchTime, config, stationStates, awaitingAutoWinner } = matchState;

  const isPaused = phase === 'paused';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const inactiveAlliance = useMemo(() => {
    return getAllianceShiftState(
      matchState.phase,
      matchState.remainingTime,
      matchState.config.teleopDuration,
      matchState.config.endgameDuration,
      matchState.autoWinnerAlliance,
    );
  }, [matchState]);

  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = Math.min(100, (totalMatchTime / totalDuration) * 100);

  return (
    <>
      {/* Timer and progress */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ textAlign: 'center', mb: 1 }}>
            <Chip
              label={awaitingAutoWinner ? 'Awaiting Auto Winner' : phaseLabels[phase]}
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
          <LinearProgress
            variant="determinate"
            value={progress}
            sx={{
              height: 10,
              borderRadius: 5,
              '& .MuiLinearProgress-bar': {
                backgroundColor: getProgressBarColor(inactiveAlliance),
                transition: 'background-color 2s ease',
              },
            }}
          />
        </CardContent>
      </Card>

      {/* Auto winner prompt — shown during autoPause in 'pause' mode */}
      {awaitingAutoWinner && (
        <Card sx={{ mb: 2, border: 2, borderColor: 'warning.main' }}>
          <CardContent sx={{ textAlign: 'center' }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 2 }}>
              Select Auto Winner
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              The match is paused until you select which alliance won autonomous.
            </Typography>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                variant="contained"
                size="large"
                onClick={() => sendMatchSetAutoWinner('red')}
                sx={{
                  backgroundColor: '#d32f2f',
                  '&:hover': { backgroundColor: '#b71c1c' },
                  fontWeight: 'bold',
                  px: 4,
                  py: 1.5,
                  fontSize: '1.1rem',
                }}
              >
                Red Wins Auto
              </Button>
              <Button
                variant="contained"
                size="large"
                onClick={() => sendMatchSetAutoWinner('blue')}
                sx={{
                  backgroundColor: '#1565c0',
                  '&:hover': { backgroundColor: '#0d47a1' },
                  fontWeight: 'bold',
                  px: 4,
                  py: 1.5,
                  fontSize: '1.1rem',
                }}
              >
                Blue Wins Auto
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Participants status */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1 }}>
            Participants
          </Typography>
          <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 0.5 }}>
                Red Alliance
              </Typography>
              {redStations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  —
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {redStations.map(s => (
                    <ActiveParticipantRow key={s} station={s} state={stationStates[s]} />
                  ))}
                </Box>
              )}
            </Box>
            <Box sx={{ flex: 1, minWidth: 200 }}>
              <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 0.5 }}>
                Blue Alliance
              </Typography>
              {blueStations.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  —
                </Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {blueStations.map(s => (
                    <ActiveParticipantRow key={s} station={s} state={stationStates[s]} />
                  ))}
                </Box>
              )}
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Global match controls */}
      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ mb: 1.5 }}>
            Match Controls
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {/* Pause (not during countdown, autoPause, or already paused) */}
            {!isPaused && phase !== 'countdown' && phase !== 'autoPause' && (
              <Button variant="outlined" color="warning" onClick={sendStationPauseMatch}>
                Pause Match
              </Button>
            )}

            {/* Paused: resume / abandon */}
            {isPaused && (
              <>
                <Button variant="contained" color="success" onClick={sendStationResumeMatch}>
                  Resume
                </Button>
                <Button variant="outlined" color="error" onClick={sendStationAbandonMatch}>
                  Abandon Match
                </Button>
              </>
            )}

            {/* Global E-Stop — always available during active match */}
            <Button variant="contained" color="error" onClick={sendAdminGlobalEStop} sx={{ fontWeight: 'bold' }}>
              E-Stop All
            </Button>
          </Box>
        </CardContent>
      </Card>
    </>
  );
}

/** A participant row during an active match, with per-station disable/e-stop controls */
function ActiveParticipantRow({ station, state }: { station: StationName; state: StationControlState | undefined }) {
  const isEnabled = state?.enabled ?? false;
  const isEStopped = state?.eStop ?? false;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        border: 1,
        borderColor: isEStopped ? 'error.main' : !isEnabled ? 'warning.main' : 'divider',
        backgroundColor: isEStopped ? 'rgba(211,47,47,0.08)' : !isEnabled ? 'rgba(255,167,38,0.08)' : undefined,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {stationLabel(station, state)}
        </Typography>
        {isEStopped && (
          <Chip
            label="E-STOPPED"
            color="error"
            size="small"
            sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }}
          />
        )}
        {!isEStopped && !isEnabled && (
          <Chip label="Disabled" color="warning" size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
        )}
        {!isEStopped && isEnabled && (
          <Chip label="Enabled" color="success" size="small" sx={{ height: 20, fontSize: '0.65rem' }} />
        )}
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        {isEStopped ? (
          <Button size="small" variant="outlined" onClick={() => sendAdminClearEStop(station)}>
            Clear
          </Button>
        ) : (
          <>
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={() => sendAdminStationDisable(station)}
              disabled={!isEnabled}
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
  );
}

/** Post-match view — results summary and create new match button */
function PostMatchView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { endReason, autoWinnerAlliance } = matchState;

  const endReasonLabels: Record<string, string> = {
    completed: 'Match Completed',
    stopped: 'Match Stopped',
    estop: 'Emergency Stopped',
    abandoned: 'Match Abandoned',
    empty: 'All Teams Left',
  };

  return (
    <Card>
      <CardContent sx={{ textAlign: 'center', py: 4 }}>
        <Typography variant="h5" sx={{ fontWeight: 700, mb: 1 }}>
          {endReasonLabels[endReason ?? ''] ?? 'Post-Match'}
        </Typography>
        {autoWinnerAlliance && (
          <Typography
            variant="body1"
            sx={{
              color: autoWinnerAlliance === 'red' ? 'error.main' : 'info.main',
              fontWeight: 700,
              mb: 2,
            }}
          >
            Auto Winner: {autoWinnerAlliance === 'red' ? 'Red' : 'Blue'}
          </Typography>
        )}
        <Button
          variant="contained"
          color="primary"
          size="large"
          onClick={sendMatchCreate}
          sx={{ px: 6, py: 1.5, fontSize: '1.1rem', fontWeight: 'bold' }}
        >
          Create New Match
        </Button>
      </CardContent>
    </Card>
  );
}
