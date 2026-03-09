import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonGroup from '@mui/material/ButtonGroup';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import { StationName } from '../../../src/types';
import { allianceColor, prettyStationName } from '../../../src/utils';
import { useRoutePreferenceState, sendRoutePreference } from '../hooks/useBackend';

function ConflictingTeamCard({
  team,
  stations,
  currentPreference,
}: {
  team: string;
  stations: StationName[];
  currentPreference: StationName | null;
}) {
  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
          Team {team}
        </Typography>
        <ButtonGroup variant="outlined" size="large" fullWidth>
          {stations.map(station => {
            const selected = currentPreference === station;
            return (
              <Button
                key={station}
                onClick={() => sendRoutePreference(selected ? null : station)}
                variant={selected ? 'contained' : 'outlined'}
                sx={{
                  borderColor: allianceColor(station),
                  color: selected ? 'white' : allianceColor(station),
                  backgroundColor: selected ? allianceColor(station) : undefined,
                  '&:hover': {
                    backgroundColor: allianceColor(station),
                    color: 'white',
                    borderColor: allianceColor(station),
                  },
                }}
              >
                {prettyStationName(station)}
              </Button>
            );
          })}
        </ButtonGroup>
        {currentPreference && stations.includes(currentPreference) && (
          <Box sx={{ mt: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Routed to:
            </Typography>
            <Chip
              label={prettyStationName(currentPreference)}
              size="small"
              sx={{ backgroundColor: allianceColor(currentPreference), color: 'white' }}
            />
            <Button size="small" onClick={() => sendRoutePreference(null)} sx={{ ml: 'auto' }}>
              Clear
            </Button>
          </Box>
        )}
      </CardContent>
    </Card>
  );
}

export function RoutePage() {
  const state = useRoutePreferenceState();

  const conflictingTeams = state?.conflictingTeams ?? {};
  const hasConflicts = Object.keys(conflictingTeams).length > 0;

  return (
    <Container maxWidth="sm" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Robot Routing
      </Typography>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        When a team has two robots on the field, choose which one your laptop connects to.
      </Typography>

      {state && (
        <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Your IP:
          </Typography>
          <Typography variant="body2" fontFamily="monospace">
            {state.yourIp}
          </Typography>
        </Box>
      )}

      {!state && (
        <Typography color="text.secondary">Connecting...</Typography>
      )}

      {state && !hasConflicts && (
        <Card>
          <CardContent>
            <Typography color="text.secondary">
              No teams are currently on multiple stations. Routing is automatic.
            </Typography>
          </CardContent>
        </Card>
      )}

      {hasConflicts &&
        Object.entries(conflictingTeams).map(([team, stations]) => (
          <ConflictingTeamCard
            key={team}
            team={team}
            stations={stations}
            currentPreference={state!.preference}
          />
        ))}
    </Container>
  );
}
