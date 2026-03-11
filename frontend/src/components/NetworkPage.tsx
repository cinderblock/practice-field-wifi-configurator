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

import { MatchState, MdnsActivity, StationName, StationNetworkStats, StationSubnetScan } from '../../../src/types';
import { allianceColor, describeIp, formatAge, formatBytes, prettyStationName } from '../../../src/utils';
import { useMatchState, useMdnsActivity, useNetworkStats, useSubnetScan } from '../hooks/useBackend';

function StationStatsCard({
  station,
  stats,
  dsIp,
}: {
  station: StationName;
  stats?: StationNetworkStats;
  dsIp?: string;
}) {
  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: stats ? 1 : 0 }}>
          <Typography variant="subtitle1" fontWeight="bold">
            {prettyStationName(station)}
          </Typography>
          {dsIp && (
            <Chip
              label={`DS: ${dsIp}`}
              size="small"
              color="info"
              variant="outlined"
              sx={{ fontFamily: 'monospace', fontSize: '0.7rem' }}
            />
          )}
        </Box>
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
            No iptables rules configured
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function StationDevicesCard({ station, scan }: { station: StationName; scan?: StationSubnetScan }) {
  return (
    <Card sx={{ mb: 1, borderLeft: `4px solid ${allianceColor(station)}` }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        {scan && scan.hosts.length > 0 ? (
          <>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="subtitle1" fontWeight="bold">
                {prettyStationName(station)} — Team {scan.team}
              </Typography>
              <Chip
                label={`${scan.hosts.filter(h => h.alive).length} / ${scan.hosts.length}`}
                size="small"
                color={scan.hosts.some(h => h.alive) ? 'success' : 'default'}
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
          </>
        ) : (
          <>
            <Typography variant="subtitle1" fontWeight="bold" gutterBottom>
              {prettyStationName(station)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {scan ? 'No devices discovered' : 'No team assigned'}
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const RED_STATIONS: StationName[] = ['red1', 'red2', 'red3'];
const BLUE_STATIONS: StationName[] = ['blue1', 'blue2', 'blue3'];

function StationColumns({
  networkStats,
  subnetScan,
  matchState,
  section,
}: {
  networkStats: ReturnType<typeof useNetworkStats>;
  subnetScan: ReturnType<typeof useSubnetScan>;
  matchState: MatchState | null;
  section: 'stats' | 'devices';
}) {
  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}>
        {RED_STATIONS.map(s =>
          section === 'stats' ? (
            <StationStatsCard
              key={s}
              station={s}
              stats={networkStats?.stations[s]}
              dsIp={matchState?.connectedStations[s]}
            />
          ) : (
            <StationDevicesCard key={s} station={s} scan={subnetScan?.stations[s]} />
          ),
        )}
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        {BLUE_STATIONS.map(s =>
          section === 'stats' ? (
            <StationStatsCard
              key={s}
              station={s}
              stats={networkStats?.stations[s]}
              dsIp={matchState?.connectedStations[s]}
            />
          ) : (
            <StationDevicesCard key={s} station={s} scan={subnetScan?.stations[s]} />
          ),
        )}
      </Grid>
    </Grid>
  );
}

function MdnsCard({ activity }: { activity: MdnsActivity | null }) {
  const teams = activity?.teams ?? {};
  const entries = Object.entries(teams).map(([team, counts]) => ({ team: Number(team), ...counts }));

  return (
    <Card sx={{ mt: 2 }}>
      <CardContent>
        <Typography variant="h5" gutterBottom>
          mDNS Reflector
        </Typography>
        {entries.length > 0 ? (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Team</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Queries Forwarded</TableCell>
                <TableCell sx={{ textAlign: 'right' }}>Responses Forwarded</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.map(e => (
                <TableRow key={e.team}>
                  <TableCell sx={{ fontFamily: 'monospace' }}>{e.team}</TableCell>
                  <TableCell sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {e.queriesForwarded.toLocaleString()}
                  </TableCell>
                  <TableCell sx={{ textAlign: 'right', fontFamily: 'monospace' }}>
                    {e.responsesForwarded.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {activity ? 'No mDNS activity' : 'mDNS reflector not enabled'}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

export function NetworkPage() {
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const matchState = useMatchState();
  const mdnsActivity = useMdnsActivity();

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h3" gutterBottom>
        Network Status
      </Typography>

      <Card>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Forwarding Counters
          </Typography>
          <StationColumns networkStats={networkStats} subnetScan={subnetScan} matchState={matchState} section="stats" />
        </CardContent>
      </Card>

      <Card sx={{ mt: 2 }}>
        <CardContent>
          <Typography variant="h5" gutterBottom>
            Discovered Devices
          </Typography>
          <StationColumns
            networkStats={networkStats}
            subnetScan={subnetScan}
            matchState={matchState}
            section="devices"
          />
        </CardContent>
      </Card>

      <MdnsCard activity={mdnsActivity} />
    </Container>
  );
}
