import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';

import { StationName, StationNetworkStats, StationSubnetScan } from '../../../src/types';
import { allianceColor, describeIp, formatAge, formatBytes, prettyStationName } from '../../../src/utils';
import { useNetworkStats, useSubnetScan } from '../hooks/useBackend';

function StationStatsCard({ station, stats }: { station: StationName; stats?: StationNetworkStats }) {
  if (!stats) return null;

  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
          {prettyStationName(station)}
        </Typography>
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
      </CardContent>
    </Card>
  );
}

function StationDevicesCard({ station, scan }: { station: StationName; scan?: StationSubnetScan }) {
  if (!scan || scan.hosts.length === 0) return null;

  const aliveCount = scan.hosts.filter(h => h.alive).length;

  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            {prettyStationName(station)} — Team {scan.team}
          </Typography>
          <Chip
            label={`${aliveCount} / ${scan.hosts.length}`}
            size="small"
            color={aliveCount > 0 ? 'success' : 'default'}
          />
        </Box>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>IP</TableCell>
              <TableCell>Status</TableCell>
              <TableCell>Description</TableCell>
              <TableCell>Last Seen</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {scan.hosts.map(host => (
              <TableRow key={host.ip} sx={{ opacity: host.alive ? 1 : 0.5 }}>
                <TableCell sx={{ fontFamily: 'monospace', py: 0.5 }}>{host.ip}</TableCell>
                <TableCell sx={{ py: 0.5 }}>
                  <Chip
                    label={host.alive ? 'UP' : 'DOWN'}
                    size="small"
                    color={host.alive ? 'success' : 'error'}
                    variant={host.alive ? 'filled' : 'outlined'}
                  />
                </TableCell>
                <TableCell sx={{ py: 0.5 }}>{describeIp(host) ?? ''}</TableCell>
                <TableCell sx={{ py: 0.5 }}>{formatAge(host.lastSeen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function NetworkPage() {
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();

  const hasAnyStats = networkStats && Object.keys(networkStats.stations).length > 0;
  const hasAnyDevices = subnetScan && Object.values(subnetScan.stations).some(s => s && s.hosts.length > 0);

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Network Status
      </Typography>

      {hasAnyStats && (
        <Card>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Forwarding Counters
            </Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['red1', 'red2', 'red3'] as StationName[]).map(s => (
                  <StationStatsCard key={s} station={s} stats={networkStats!.stations[s]} />
                ))}
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['blue1', 'blue2', 'blue3'] as StationName[]).map(s => (
                  <StationStatsCard key={s} station={s} stats={networkStats!.stations[s]} />
                ))}
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}

      {hasAnyDevices && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            <Typography variant="h5" gutterBottom>
              Discovered Devices
            </Typography>
            <Grid container spacing={2}>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['red1', 'red2', 'red3'] as StationName[]).map(s => (
                  <StationDevicesCard key={s} station={s} scan={subnetScan!.stations[s]} />
                ))}
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                {(['blue1', 'blue2', 'blue3'] as StationName[]).map(s => (
                  <StationDevicesCard key={s} station={s} scan={subnetScan!.stations[s]} />
                ))}
              </Grid>
            </Grid>
          </CardContent>
        </Card>
      )}
    </Container>
  );
}
