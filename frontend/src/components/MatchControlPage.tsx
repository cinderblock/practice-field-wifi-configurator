import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { Alliance, MatchPhase, StationName, StationControlState } from '../../../src/types';
import {
  useMatchState,
  sendMatchCreate,
  sendMatchCancel,
  sendMatchClear,
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

// ── Phase display helpers ───────────────────────────────────────────

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

// ── Timer with ceil rounding ────────────────────────────────────────
// Auto starts at 0:20 and shows 0:20 for the first second.
// When the displayed number hits 0:00, that moment is the end.

function MatchTimer({ remainingTime, phase }: { remainingTime: number; phase: MatchPhase }) {
  const display = Math.ceil(Math.max(0, remainingTime));
  const minutes = Math.floor(display / 60);
  const seconds = display % 60;
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

// ── Station label — uses team number, never exposes slot/radio ids ──

function teamLabel(state: StationControlState | undefined): string {
  const team = state?.teamNumber;
  if (team) return String(team);
  return '(no team)';
}

// ── Progress computation ────────────────────────────────────────────

function computeBarProgress(
  totalMatchTime: number,
  config: { autoDuration: number; pauseDuration: number; teleopDuration: number; skipAuto?: boolean },
): number {
  const countdownDuration = 3;
  const autoDur = config.skipAuto ? 0 : config.autoDuration;
  const pauseDur = config.skipAuto ? 0 : config.pauseDuration;
  const barTotal = autoDur + pauseDur + config.teleopDuration;
  if (barTotal <= 0) return 0;
  const barElapsed = Math.max(0, totalMatchTime - countdownDuration);
  return Math.min(1, barElapsed / barTotal);
}

// ── Root component ──────────────────────────────────────────────────

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

// ── Idle view ───────────────────────────────────────────────────────

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

// ── Created view — pre-match setup ──────────────────────────────────

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
              At least one team must join and &lsquo;Ready Up&rsquo; before starting.
            </Typography>
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** A single participant row in the pre-match setup */
function ParticipantRow({
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
          {teamLabel(state)}
        </Typography>
        {state?.ready && <Chip label="Ready" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
      </Box>
      <Button size="small" variant="outlined" onClick={onSwap}>
        Swap
      </Button>
    </Box>
  );
}

// ── Active match view ───────────────────────────────────────────────

function ActiveMatchView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { phase, remainingTime, totalMatchTime, config, stationStates, awaitingAutoWinner } = matchState;

  const isPaused = phase === 'paused';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

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
          <MatchTimeline config={config} progress={progress} autoWinnerAlliance={matchState.autoWinnerAlliance} />
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
          {teamLabel(state)}
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

// ── Post-match view ─────────────────────────────────────────────────

function PostMatchView({ matchState }: { matchState: NonNullable<ReturnType<typeof useMatchState>> }) {
  const { remainingTime, totalMatchTime, config, stationStates, endReason, autoWinnerAlliance } = matchState;

  const isCounting = remainingTime > 0;

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

  const endReasonLabels: Record<string, string> = {
    normal: 'Match Completed',
    completed: 'Match Completed',
    stopped: 'Match Stopped',
    estop: 'Emergency Stopped',
    abandoned: 'Match Abandoned',
    empty: 'All Teams Left',
  };

  return (
    <>
      {/* Result header + timeline */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ textAlign: 'center', mb: 2 }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 0.5 }}>
              {isCounting ? 'Counting...' : (endReasonLabels[endReason ?? ''] ?? 'Post-Match')}
            </Typography>
            {isCounting && <MatchTimer remainingTime={remainingTime} phase="postMatch" />}
            {autoWinnerAlliance && (
              <Typography
                variant="body1"
                sx={{
                  color: autoWinnerAlliance === 'red' ? 'error.main' : 'info.main',
                  fontWeight: 700,
                }}
              >
                Auto Winner: {autoWinnerAlliance === 'red' ? 'Red' : 'Blue'}
              </Typography>
            )}
          </Box>

          {/* Timeline bar at 100% (or near if still counting) */}
          <MatchTimeline config={config} progress={Math.min(1, progress)} autoWinnerAlliance={autoWinnerAlliance} />
        </CardContent>
      </Card>

      {/* Participants — still in the match */}
      {joinedStations.length > 0 && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="h6" sx={{ mb: 1 }}>
              Participants
            </Typography>
            <Box sx={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {redStations.length > 0 && (
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography variant="subtitle2" sx={{ color: 'error.main', fontWeight: 700, mb: 0.5 }}>
                    Red Alliance
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {redStations.map(s => (
                      <Box key={s} sx={{ px: 1.5, py: 0.5, borderRadius: 1, border: 1, borderColor: 'divider' }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {teamLabel(stationStates[s])}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
              {blueStations.length > 0 && (
                <Box sx={{ flex: 1, minWidth: 200 }}>
                  <Typography variant="subtitle2" sx={{ color: 'info.main', fontWeight: 700, mb: 0.5 }}>
                    Blue Alliance
                  </Typography>
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                    {blueStations.map(s => (
                      <Box key={s} sx={{ px: 1.5, py: 0.5, borderRadius: 1, border: 1, borderColor: 'divider' }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {teamLabel(stationStates[s])}
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                </Box>
              )}
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Actions — only when counting period is done */}
      {!isCounting && (
        <Card>
          <CardContent>
            <Box sx={{ display: 'flex', gap: 2, justifyContent: 'center' }}>
              <Button
                variant="contained"
                color="primary"
                size="large"
                onClick={sendMatchCreate}
                sx={{ px: 4, py: 1.5, fontSize: '1.1rem', fontWeight: 'bold' }}
              >
                Create New Match
              </Button>
              <Button variant="outlined" onClick={sendMatchClear}>
                Clear Match
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}
    </>
  );
}
