import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import Typography from '@mui/material/Typography';

import { StationName, StationNetworkStats } from '../../../src/types';
import { allianceColor, prettyStationName } from '../../../src/utils';
import { useNetworkStats } from '../hooks/useBackend';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function StationStatsCard({ station, stats }: { station: StationName; stats?: StationNetworkStats }) {
  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
          {prettyStationName(station)}
        </Typography>
        {stats ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1 }}>
            <Box />
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
              Packets
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
              Bytes
            </Typography>

            <Typography variant="body2">From robot</Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {stats.rxPackets.toLocaleString()}
            </Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {formatBytes(stats.rxBytes)}
            </Typography>

            <Typography variant="body2">To robot</Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {stats.txPackets.toLocaleString()}
            </Typography>
            <Typography variant="body2" sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
              {formatBytes(stats.txBytes)}
            </Typography>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No forwarding rules active
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export function NetworkPage() {
  const networkStats = useNetworkStats();

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Network Status
      </Typography>

      {!networkStats ? (
        <Card>
          <CardContent>
            <Typography color="text.secondary">Waiting for network stats...</Typography>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Forwarding Counters
            </Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['red1', 'red2', 'red3'] as StationName[]).map(s => (
                  <StationStatsCard key={s} station={s} stats={networkStats.stations[s]} />
                ))}
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['blue1', 'blue2', 'blue3'] as StationName[]).map(s => (
                  <StationStatsCard key={s} station={s} stats={networkStats.stations[s]} />
                ))}
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}
    </Container>
  );
}
