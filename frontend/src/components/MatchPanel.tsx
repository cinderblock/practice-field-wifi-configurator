import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { Alliance, MatchPhase, StationName, StationControlState } from '../../../src/types';
import { prettyStationName } from '../../../src/utils';
import {
  useMatchState,
  sendStationJoin,
  sendStationJoinAlliance,
  sendStationLeave,
  sendStationReady,
  sendStationStartMatch,
  sendStationPauseMatch,
  sendStationResumeMatch,
  sendStationAbandonMatch,
} from '../hooks/useBackend';
import { MatchTimeline } from './MatchTimeline';

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
  const sameTeamStations = (Object.entries(allStates) as [StationName, StationControlState | undefined][]).filter(
    ([s, st]) => st?.joined && st?.teamNumber === team && s !== station,
  ).length;

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

  // Don't render per-station panel if no team is configured and no match is active
  if (station && !myState?.teamNumber && !isActive && !isPostMatch) return null;

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

        {/* Match timing config — visual timeline */}
        {showConfigEditor && <MatchTimeline config={config} />}
      </CardContent>
    </Card>
  );
}

/**
 * Build a display label for a joined station chip in the control page context.
 * Uses team number / SSID instead of station name like "Red 1".
 */
function controlChipLabel(station: StationName, state: StationControlState | undefined) {
  const team = state?.teamNumber;
  const readySuffix = state?.ready ? ' \u2713' : '';
  const alliance = state?.alliance;
  const allianceTag = alliance ? `${alliance === 'red' ? 'R' : 'B'}` : '';
  if (team) return `${allianceTag} ${team}${readySuffix}`;
  return `${prettyStationName(station)}${readySuffix}`;
}

/**
 * Team-centric match panel for the /control/<ssid> page.
 * Shows "Join Red" / "Join Blue" buttons instead of "Join Match".
 * Does not reference station names like "Blue 1" or "Red 2".
 */
export function MatchPanelForControl({ station }: { station: StationName; ssid: string }) {
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

  const myState = stationStates[station];
  const joined = myState?.joined ?? false;
  const ready = myState?.ready ?? false;
  const myAlliance = myState?.alliance ?? null;

  const showConfigEditor = joined && !isActive && !isPostMatch;

  const countdownDuration = 3;
  const totalDuration = countdownDuration + config.autoDuration + config.pauseDuration + config.teleopDuration;
  const progress = Math.min(100, (totalMatchTime / totalDuration) * 100);

  // Don't render if no team is configured and no match is active
  if (!myState?.teamNumber && !isActive && !isPostMatch) return null;

  // Group joined stations by alliance for display
  const redStations = joinedStations.filter(s => stationStates[s]?.alliance === 'red');
  const blueStations = joinedStations.filter(s => stationStates[s]?.alliance === 'blue');

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
              {myAlliance && (
                <Typography
                  variant="body2"
                  sx={{ mt: 0.5, color: myAlliance === 'red' ? 'error.main' : 'info.main', fontWeight: 700 }}
                >
                  Playing {myAlliance === 'red' ? 'Red' : 'Blue'} Alliance
                </Typography>
              )}
            </Box>
            <MatchTimer remainingTime={remainingTime} phase={phase} />
            <LinearProgress variant="determinate" value={progress} sx={{ mb: 2, height: 6, borderRadius: 3 }} />
          </>
        )}

        {/* Idle / waiting: show who has joined, grouped by alliance */}
        {!isActive && !isPostMatch && (
          <Box sx={{ mb: 1.5 }}>
            {joinedStations.length === 0 && !joined && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                No teams joined yet. Choose an alliance to join the match.
              </Typography>
            )}
            {(redStations.length > 0 || blueStations.length > 0) && (
              <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                {redStations.length > 0 && (
                  <Box>
                    <Typography variant="caption" sx={{ color: 'error.main', fontWeight: 700 }}>
                      Red Alliance
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {redStations.map(s => (
                        <Chip
                          key={s}
                          label={controlChipLabel(s, stationStates[s])}
                          size="small"
                          color={stationStates[s]?.ready ? 'success' : 'default'}
                          variant={s === station ? 'filled' : 'outlined'}
                          sx={s === station ? { fontWeight: 'bold' } : {}}
                        />
                      ))}
                    </Box>
                  </Box>
                )}
                {blueStations.length > 0 && (
                  <Box>
                    <Typography variant="caption" sx={{ color: 'info.main', fontWeight: 700 }}>
                      Blue Alliance
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                      {blueStations.map(s => (
                        <Chip
                          key={s}
                          label={controlChipLabel(s, stationStates[s])}
                          size="small"
                          color={stationStates[s]?.ready ? 'success' : 'default'}
                          variant={s === station ? 'filled' : 'outlined'}
                          sx={s === station ? { fontWeight: 'bold' } : {}}
                        />
                      ))}
                    </Box>
                  </Box>
                )}
              </Box>
            )}
          </Box>
        )}

        {/* Action buttons */}
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
          {/* Not joined, not active: Join Red / Join Blue buttons */}
          {!joined && !isActive && (
            <>
              <Button
                variant="contained"
                onClick={() => sendStationJoinAlliance(station, 'red')}
                sx={{
                  backgroundColor: '#d32f2f',
                  '&:hover': { backgroundColor: '#b71c1c' },
                  fontWeight: 'bold',
                  flex: 1,
                  minWidth: 120,
                }}
              >
                Join Red
              </Button>
              <Button
                variant="contained"
                onClick={() => sendStationJoinAlliance(station, 'blue')}
                sx={{
                  backgroundColor: '#1565c0',
                  '&:hover': { backgroundColor: '#0d47a1' },
                  fontWeight: 'bold',
                  flex: 1,
                  minWidth: 120,
                }}
              >
                Join Blue
              </Button>
            </>
          )}

          {/* Joined, not active: ready / leave / switch alliance */}
          {joined && !isActive && !isPostMatch && (
            <>
              <Button
                variant={ready ? 'outlined' : 'contained'}
                color={ready ? 'warning' : 'success'}
                onClick={() => sendStationReady(station, !ready)}
              >
                {ready ? 'Not Ready' : 'Ready'}
              </Button>
              {!ready && myAlliance && (
                <Button
                  variant="outlined"
                  onClick={() => sendStationJoinAlliance(station, myAlliance === 'red' ? 'blue' : 'red')}
                  sx={{
                    borderColor: myAlliance === 'red' ? '#1565c0' : '#d32f2f',
                    color: myAlliance === 'red' ? '#1565c0' : '#d32f2f',
                    '&:hover': {
                      borderColor: myAlliance === 'red' ? '#0d47a1' : '#b71c1c',
                      backgroundColor: myAlliance === 'red' ? 'rgba(21,101,192,0.08)' : 'rgba(211,47,47,0.08)',
                    },
                  }}
                >
                  Switch to {myAlliance === 'red' ? 'Blue' : 'Red'}
                </Button>
              )}
              <Button variant="outlined" color="error" onClick={() => sendStationLeave(station)} disabled={ready}>
                Leave
              </Button>
            </>
          )}

          {/* Post-match: leave */}
          {joined && isPostMatch && (
            <Button variant="outlined" color="primary" onClick={() => sendStationLeave(station)}>
              Leave Match
            </Button>
          )}

          {/* Start button: shown when all ready and this station is joined */}
          {joined && !isActive && !isPostMatch && allReady && (
            <Button variant="contained" color="success" sx={{ fontWeight: 'bold' }} onClick={sendStationStartMatch}>
              Start Match
            </Button>
          )}

          {/* Active match: pause */}
          {joined && isActive && !isPaused && phase !== 'countdown' && phase !== 'autoPause' && (
            <Button variant="outlined" color="warning" onClick={sendStationPauseMatch}>
              Pause
            </Button>
          )}

          {/* Paused: resume / abandon */}
          {joined && isPaused && (
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

        {/* Match timing config — visual timeline */}
        {showConfigEditor && <MatchTimeline config={config} />}
      </CardContent>
    </Card>
  );
}
