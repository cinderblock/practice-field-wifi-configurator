import { useMemo } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { TeamAvatar } from './TeamAvatar';
import {
  Alliance,
  MatchPhase,
  MatchState,
  MatchHistoryEntry,
  StationName,
  StationControlState,
} from '../../../src/types';
import {
  useMatchState,
  useMatchHistory,
  sendMatchCreate,
  sendMatchCancel,
  sendMatchAbortCountdown,
  sendMatchClear,
  sendMatchSwapStation,
  sendMatchKickStation,
  sendMatchSetAutoWinner,
  sendStationStartMatch,
  sendStationPauseMatch,
  sendStationResumeMatch,
  sendStationAbandonMatch,
  sendAdminStationDisable,
  sendAdminStationEStop,
  sendAdminGlobalEStop,
  sendAdminClearEStop,
  sendClearMatchHistory,
} from '../hooks/useBackend';
import { MatchTimeline } from './MatchTimeline';
import { MatchTimer, PHASE_HEX, getActiveColor } from './MatchTimer';
import { getAllianceShiftState } from '../utils/shiftState';

// ── Phase display helpers ───────────────────────────────────────────

// Muted versions for the page background
const PHASE_BG: Record<MatchPhase, string> = {
  idle: 'transparent',
  created: 'rgba(66,165,245,0.10)',
  countdown: 'rgba(255,167,38,0.12)',
  auto: 'rgba(102,187,106,0.12)',
  autoPause: 'rgba(158,158,158,0.08)',
  paused: 'rgba(255,167,38,0.12)',
  teleop: 'rgba(102,187,106,0.10)',
  endgame: 'rgba(255,167,38,0.12)',
  postMatch: 'transparent',
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

/** Muted page background; during teleop shifts, tint by alliance colour. */
function getPageBg(matchState: MatchState): string {
  const { phase } = matchState;

  if (phase === 'teleop' || phase === 'endgame') {
    const inactive = getAllianceShiftState(
      phase,
      matchState.remainingTime,
      matchState.config.teleopDuration,
      matchState.config.endgameDuration,
      matchState.autoWinnerAlliance,
    );
    if (inactive === 'red') return 'rgba(66,165,245,0.10)';
    if (inactive === 'blue') return 'rgba(239,83,80,0.10)';
  }

  return PHASE_BG[phase];
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
  // The bar always shows auto + pause + teleop (even when skipped, they're greyed not hidden)
  const barTotal = config.autoDuration + config.pauseDuration + config.teleopDuration;
  if (barTotal <= 0) return 0;
  const elapsed = Math.max(0, totalMatchTime - countdownDuration);
  if (config.skipAuto) {
    // Auto/pause are skipped in real time but still shown in bar — offset progress past them
    const skipOffset = config.autoDuration + config.pauseDuration;
    return Math.min(1, (skipOffset + elapsed) / barTotal);
  }
  return Math.min(1, elapsed / barTotal);
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
  const matchHistory = useMatchHistory();

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
  const activeColor = getActiveColor(matchState);
  const pageBg = getPageBg(matchState);
  const showHistory = (phase === 'idle' || phase === 'postMatch') && matchHistory && matchHistory.matches.length > 0;

  return (
    <Box sx={{ minHeight: '100dvh', backgroundColor: pageBg, transition: 'background-color 1s ease' }}>
      <Container maxWidth="md" sx={{ py: 4 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Match Control
          </Typography>
          <Chip
            label={phaseLabels[phase]}
            sx={{
              fontWeight: 'bold',
              color: activeColor,
              borderColor: activeColor,
              transition: 'color 1s ease, border-color 1s ease',
            }}
            variant="outlined"
          />
        </Box>

        {phase === 'idle' && <IdleView />}
        {phase === 'created' && <CreatedView matchState={matchState} />}
        {phase === 'postMatch' && <PostMatchView matchState={matchState} />}
        {phase !== 'idle' && phase !== 'created' && phase !== 'postMatch' && (
          <ActiveMatchView matchState={matchState} activeColor={activeColor} />
        )}

        {showHistory && <MatchHistorySection matches={matchHistory.matches} />}
      </Container>
    </Box>
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
                        onKick={() => sendMatchKickStation(s)}
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
                        onKick={() => sendMatchKickStation(s)}
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
              Start Countdown
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
  onKick,
}: {
  station: StationName;
  state: StationControlState | undefined;
  onSwap: () => void;
  onKick: () => void;
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
        <TeamAvatar teamNumber={state?.teamNumber} size={22} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {teamLabel(state)}
        </Typography>
        {state?.ready && <Chip label="Ready" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
      </Box>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Button size="small" variant="outlined" onClick={onSwap}>
          Swap
        </Button>
        <Button size="small" variant="outlined" color="error" onClick={onKick}>
          Kick
        </Button>
      </Box>
    </Box>
  );
}

// ── Active match view ───────────────────────────────────────────────

function ActiveMatchView({
  matchState,
  activeColor,
}: {
  matchState: NonNullable<ReturnType<typeof useMatchState>>;
  activeColor: string;
}) {
  const { phase, remainingTime, totalMatchTime, config, stationStates, awaitingAutoWinner } = matchState;

  const isPaused = phase === 'paused';

  const joinedStations = (Object.entries(stationStates) as [StationName, StationControlState | undefined][])
    .filter(([, s]) => s?.joined)
    .map(([name]) => name);

  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

  const progress = useMemo(() => computeBarProgress(totalMatchTime, config), [totalMatchTime, config]);

  // Pulse the timer in the last 3 seconds of each game period
  const shouldPulse = useMemo(() => {
    if (remainingTime <= 0) return false;

    // Auto / countdown: pulse at end of the phase
    if (phase === 'auto' || phase === 'countdown') return remainingTime <= 3;

    // During teleop/endgame: pulse at the end of each sub-period boundary
    if (phase === 'teleop' || phase === 'endgame') {
      const teleopDur = config.teleopDuration; // 140
      // Period boundaries are at these remainingTime values:
      // TS ends:        130  (elapsed 10)
      // S1 ends:        105  (elapsed 35)
      // S2 ends:         80  (elapsed 60)
      // S3 ends:         55  (elapsed 85)
      // S4 ends:         30  (elapsed 110)
      // End Game ends:    0  (elapsed 140)
      const boundaries = [
        teleopDur - 10, // 130 — end of transition
        teleopDur - 35, // 105 — end of S1
        teleopDur - 60, //  80 — end of S2
        teleopDur - 85, //  55 — end of S3
        teleopDur - 110, // 30 — end of S4
        0, //               0 — end of endgame
      ];
      for (const b of boundaries) {
        if (remainingTime > b && remainingTime <= b + 3) return true;
      }
    }

    return false;
  }, [phase, remainingTime, config.teleopDuration]);

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
                color: activeColor,
                borderColor: activeColor,
                transition: 'color 1s ease, border-color 1s ease',
              }}
              variant="outlined"
            />
          </Box>
          <Box sx={{ mb: 2 }}>
            <MatchTimer remainingTime={remainingTime} color={activeColor} pulse={shouldPulse} />
          </Box>
          <MatchTimeline
            config={config}
            progress={progress}
            autoWinnerAlliance={matchState.autoWinnerAlliance}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
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
            {/* Abort countdown — returns to created/setup phase */}
            {phase === 'countdown' && (
              <Button variant="outlined" color="warning" onClick={sendMatchAbortCountdown}>
                Abort Countdown
              </Button>
            )}

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
        <TeamAvatar teamNumber={state?.teamNumber} size={22} />
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
            {isCounting && <MatchTimer remainingTime={remainingTime} color={PHASE_HEX.postMatch} />}
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
          <MatchTimeline
            config={config}
            progress={Math.min(1, progress)}
            autoWinnerAlliance={autoWinnerAlliance}
            phase={matchState.phase}
            remainingTime={matchState.remainingTime}
          />
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
                      <Box
                        key={s}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          borderRadius: 1,
                          border: 1,
                          borderColor: 'divider',
                        }}
                      >
                        <TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />
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
                      <Box
                        key={s}
                        sx={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 1,
                          px: 1.5,
                          py: 0.5,
                          borderRadius: 1,
                          border: 1,
                          borderColor: 'divider',
                        }}
                      >
                        <TeamAvatar teamNumber={stationStates[s]?.teamNumber} size={20} />
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

// ── Match History ──────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const endReasonChip: Record<string, { label: string; color: 'success' | 'warning' | 'error' | 'default' }> = {
  normal: { label: 'Completed', color: 'success' },
  stopped: { label: 'Stopped', color: 'warning' },
  estop: { label: 'E-Stopped', color: 'error' },
  abandoned: { label: 'Abandoned', color: 'default' },
};

function MatchHistorySection({ matches }: { matches: MatchHistoryEntry[] }) {
  // Show most recent first
  const reversed = [...matches].reverse();

  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Match History</Typography>
          <Button size="small" color="inherit" onClick={sendClearMatchHistory} sx={{ opacity: 0.6 }}>
            Clear
          </Button>
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {reversed.map((match, i) => (
            <MatchHistoryRow key={match.startedAt} match={match} index={matches.length - i} />
          ))}
        </Box>
      </CardContent>
    </Card>
  );
}

function MatchHistoryRow({ match, index }: { match: MatchHistoryEntry; index: number }) {
  const redTeams = match.teams.filter(t => t.alliance === 'red');
  const blueTeams = match.teams.filter(t => t.alliance === 'blue');
  const chipInfo = endReasonChip[match.endReason] ?? endReasonChip.normal;
  const redWon = match.redScore > match.blueScore;
  const blueWon = match.blueScore > match.redScore;

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2,
        py: 1,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
      }}
    >
      {/* Match number */}
      <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary', minWidth: 24 }}>
        #{index}
      </Typography>

      {/* Red alliance teams + score */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1, justifyContent: 'flex-end' }}>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {redTeams.map(t => (
            <Box key={t.station} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TeamAvatar teamNumber={t.teamNumber} size={16} />
              <Typography variant="body2" sx={{ fontWeight: 500, color: 'error.main' }}>
                {t.teamNumber}
              </Typography>
            </Box>
          ))}
        </Box>
        <Typography
          variant="h6"
          sx={{
            fontWeight: 700,
            color: 'error.main',
            minWidth: 40,
            textAlign: 'right',
            opacity: redWon ? 1 : 0.6,
          }}
        >
          {match.redScore}
        </Typography>
      </Box>

      {/* Separator */}
      <Typography variant="body2" sx={{ color: 'text.disabled', fontWeight: 300 }}>
        —
      </Typography>

      {/* Blue alliance teams + score */}
      <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography
          variant="h6"
          sx={{
            fontWeight: 700,
            color: 'info.main',
            minWidth: 40,
            textAlign: 'left',
            opacity: blueWon ? 1 : 0.6,
          }}
        >
          {match.blueScore}
        </Typography>
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          {blueTeams.map(t => (
            <Box key={t.station} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TeamAvatar teamNumber={t.teamNumber} size={16} />
              <Typography variant="body2" sx={{ fontWeight: 500, color: 'info.main' }}>
                {t.teamNumber}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Duration + end reason + time ago */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 160, justifyContent: 'flex-end' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {formatDuration(match.durationSeconds)}
        </Typography>
        <Chip label={chipInfo.label} color={chipInfo.color} size="small" variant="outlined" />
        <Typography variant="caption" sx={{ color: 'text.disabled', minWidth: 50, textAlign: 'right' }}>
          {formatTimeAgo(match.endedAt)}
        </Typography>
      </Box>
    </Box>
  );
}
