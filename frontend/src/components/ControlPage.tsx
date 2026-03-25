import { useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Tooltip from '@mui/material/Tooltip';
import Chip from '@mui/material/Chip';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import {
  useLatest,
  useMatchState,
  useSavedTeams,
  sendNewConfig,
  sendInternetToggle,
  sendRemoveSavedTeam,
  useLatestTelemetry,
  useUpdateCallback,
  useTelemetryCallback,
  useNetworkStats,
  useSubnetScan,
  useMdnsActivity,
  useBackendStagedChanges,
} from '../hooks/useBackend';
import { MatchPanelForControl } from './MatchPanel';
import { TeamChecksModal } from './TeamChecksModal';
import { StationNetworkCard } from './NetworkPage';
import { StationName, StationNameList, SavedTeamConfig } from '../../../src/types';
import { createHash } from './cryptoUtils';
import { StationChart, handleStatusUpdate, handleTelemetryUpdate } from './StationChart';
import { CopyToClipboard } from './CopyToClipboard';
import IconButton from '@mui/material/IconButton';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import PublicIcon from '@mui/icons-material/Public';
import PublicOffIcon from '@mui/icons-material/PublicOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import TableHead from '@mui/material/TableHead';
import Alert from '@mui/material/Alert';
import { formatBytes, describeIp, formatAge } from '../../../src/utils';

// Helper function to format numbers with thin space as thousands separator
function formatNumberWithThinSpace(num: number | undefined): string {
  if (num === undefined) return '';
  return num.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009');
}

/**
 * Find ALL physical stations assigned to SSIDs belonging to a given team number.
 * Returns a Map of ssid → stationName.
 */
function useStationsForTeam(teamNumber: number): Map<string, StationName> {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const result = new Map<string, StationName>();
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    for (const station of StationNameList) {
      // Check active radio status
      const ssid = stationStatuses?.[station]?.ssid;
      if (ssid) {
        const num = parseInt(ssid.split('-', 2)[0]);
        if (num === teamNumber) {
          result.set(ssid, station);
        }
      }
      // Check staged changes (may override or add)
      const staged = stagedChanges[station];
      if (staged?.ssid) {
        const num = parseInt(staged.ssid.split('-', 2)[0]);
        if (num === teamNumber && !result.has(staged.ssid)) {
          result.set(staged.ssid, station);
        }
      }
    }
    return result;
  }, [latest, stagedChanges, teamNumber]);
}

/**
 * Find the first unconfigured station slot.
 */
function useFindAvailableStation(): StationName | null {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    for (const station of StationNameList) {
      const hasSsid = stationStatuses?.[station]?.ssid;
      const hasStaged = station in stagedChanges && stagedChanges[station] !== null;
      if (!hasSsid && !hasStaged) {
        return station;
      }
    }
    return null;
  }, [latest, stagedChanges]);
}

/**
 * The main control page component.
 * URL: /control/<teamNumber>
 *
 * Shows a robot management dashboard for a single team:
 * - List of saved robot configs for this team
 * - Add new robot form
 * - Active robot status and match controls
 */
export function ControlPage({ teamNumber }: { teamNumber: number }) {
  // All active stations for this team
  const activeStations = useStationsForTeam(teamNumber);
  const availableStation = useFindAvailableStation();

  // Server-side saved team configs filtered to this team
  const savedTeams = useSavedTeams();
  const teamConfigs = useMemo(() => {
    if (!savedTeams) return [];
    return savedTeams.teams.filter(t => {
      const num = parseInt(t.ssid.split('-', 2)[0]);
      return num === teamNumber;
    });
  }, [savedTeams, teamNumber]);

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h4" sx={{ mb: 2, fontWeight: 700 }}>
        Team {teamNumber}
      </Typography>

      {/* Robot list and add-robot form */}
      <RobotList
        teamNumber={teamNumber}
        teamConfigs={teamConfigs}
        activeStations={activeStations}
        availableStation={availableStation}
      />

      {/* Active robot experiences */}
      {Array.from(activeStations.entries()).map(([ssid, station]) => (
        <Box key={ssid} sx={{ mt: 2 }}>
          <Typography variant="h6" sx={{ mb: 1, fontFamily: 'monospace' }}>
            {ssid}
          </Typography>
          <MatchPanelForControl station={station} ssid={ssid} />
          <StationExperience station={station} />
        </Box>
      ))}
    </Container>
  );
}

/**
 * List of saved robot configs for this team + add-robot form.
 */
function RobotList({
  teamNumber,
  teamConfigs,
  activeStations,
  availableStation,
}: {
  teamNumber: number;
  teamConfigs: SavedTeamConfig[];
  activeStations: Map<string, StationName>;
  availableStation: StationName | null;
}) {
  const [showAddForm, setShowAddForm] = useState(false);

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Robots</Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setShowAddForm(!showAddForm)}>
            Add Robot
          </Button>
        </Box>

        {!availableStation && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            All 6 radio slots are in use. Remove a team from another station before enabling a new robot.
          </Alert>
        )}

        {showAddForm && (
          <AddRobotForm
            teamNumber={teamNumber}
            availableStation={availableStation}
            onDone={() => setShowAddForm(false)}
          />
        )}

        {teamConfigs.length === 0 && !showAddForm ? (
          <Typography variant="body2" color="text.secondary">
            No saved robots for this team. Click "Add Robot" to configure one.
          </Typography>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            {teamConfigs.map(config => (
              <RobotRow
                key={config.ssid}
                config={config}
                isActive={activeStations.has(config.ssid)}
                availableStation={availableStation}
              />
            ))}
          </Box>
        )}

        {/* Passphrase checker for any saved config */}
        {teamConfigs.length > 0 && <PassphraseChecker teamConfigs={teamConfigs} />}
      </CardContent>
    </Card>
  );
}

/**
 * A single row in the robot list showing a saved config.
 */
function RobotRow({
  config,
  isActive,
  availableStation,
}: {
  config: SavedTeamConfig;
  isActive: boolean;
  availableStation: StationName | null;
}) {
  const suffix = config.ssid.includes('-') ? config.ssid.split('-').slice(1).join('-') : null;

  const handleEnable = (stage: boolean) => {
    if (!availableStation) return;
    sendNewConfig(availableStation, config.ssid, config.wpaKey, stage);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        px: 2,
        py: 1,
        borderRadius: 1,
        '&:hover': { backgroundColor: 'action.hover' },
        transition: 'background-color 0.15s',
      }}
    >
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
            {suffix ?? config.ssid}
          </Typography>
          {isActive && <Chip label="Active" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
        </Box>
        <Typography variant="caption" color="text.secondary">
          Last used {formatAge(config.lastUsedAt)}
        </Typography>
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {!isActive && (
          <>
            <Button size="small" variant="outlined" disabled={!availableStation} onClick={() => handleEnable(true)}>
              Stage
            </Button>
            <Button size="small" variant="contained" disabled={!availableStation} onClick={() => handleEnable(false)}>
              Enable
            </Button>
          </>
        )}
        <Tooltip title="Remove saved robot">
          <IconButton
            size="small"
            onClick={() => sendRemoveSavedTeam(config.ssid)}
            sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
          >
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}

/**
 * Form for adding a new robot (suffix + passphrase).
 */
function AddRobotForm({
  teamNumber,
  availableStation,
  onDone,
}: {
  teamNumber: number;
  availableStation: StationName | null;
  onDone: () => void;
}) {
  const [suffix, setSuffix] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const ssid = suffix ? `${teamNumber}-${suffix}` : `${teamNumber}`;
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;
  const isValid = passphraseRegex.test(passphrase);

  const handleSubmit = (stage: boolean) => {
    if (!isValid || !availableStation) return;
    sendNewConfig(availableStation, ssid, passphrase, stage);
    onDone();
  };

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        New Robot
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        SSID: <strong>{ssid}</strong>
      </Typography>
      <TextField
        label="Suffix (optional)"
        value={suffix}
        onChange={e => setSuffix(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 10))}
        fullWidth
        size="small"
        sx={{ mb: 1 }}
      />
      <TextField
        label="Passphrase"
        value={passphrase}
        onChange={e => setPassphrase(e.target.value)}
        fullWidth
        size="small"
        helperText={passphrase && !isValid ? 'Must be 8-16 alphanumeric characters.' : ''}
        error={!!passphrase && !isValid}
        sx={{ mb: 2 }}
      />
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button
          variant="outlined"
          size="small"
          disabled={!isValid || !availableStation}
          onClick={() => handleSubmit(true)}
        >
          Stage
        </Button>
        <Button
          variant="contained"
          size="small"
          disabled={!isValid || !availableStation}
          onClick={() => handleSubmit(false)}
        >
          Apply Now
        </Button>
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </Box>
    </Card>
  );
}

/**
 * Passphrase verification feature.
 * Computes SHA-256(ssid + input) on each keypress and compares to saved hashes.
 */
function PassphraseChecker({ teamConfigs }: { teamConfigs: SavedTeamConfig[] }) {
  const [checkValue, setCheckValue] = useState('');
  const [matchedSsid, setMatchedSsid] = useState<string | null>(null);

  const handleCheck = useCallback(
    async (value: string) => {
      setCheckValue(value);

      if (value.length < 8) {
        setMatchedSsid(null);
        return;
      }

      // Check against all team configs
      for (const config of teamConfigs) {
        if (!config.wpaKeyHash) continue;
        const hash = await createHash(config.ssid + value);
        if (hash === config.wpaKeyHash) {
          setMatchedSsid(config.ssid);
          return;
        }
      }
      setMatchedSsid(null);
    },
    [teamConfigs],
  );

  // Only show if there are configs with hashes
  const hasHashes = teamConfigs.some(c => c.wpaKeyHash);
  if (!hasHashes) return null;

  return (
    <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Check passphrase
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <TextField
          size="small"
          placeholder="Enter passphrase to verify"
          value={checkValue}
          onChange={e => handleCheck(e.target.value)}
          sx={{ flex: 1 }}
        />
        {matchedSsid && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <CheckCircleIcon sx={{ color: 'success.main' }} />
            <Typography variant="body2" color="success.main" sx={{ fontFamily: 'monospace' }}>
              {matchedSsid}
            </Typography>
          </Box>
        )}
        {checkValue.length >= 8 && !matchedSsid && (
          <Typography variant="body2" color="error">
            No match
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * Full station experience shown once a robot is configured on a physical station.
 * Shows radio status, telemetry, charts, network diagnostics, etc.
 */
function StationExperience({ station }: { station: StationName }) {
  const [chartMode, setChartMode] = useState(true);
  const [internetAccess, setInternetAccess] = useState(false);
  const latest = useLatest();
  const matchState = useMatchState();
  const telemetry = useLatestTelemetry(station);
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const mdnsActivity = useMdnsActivity();

  // Always register the chart data collection handler
  useUpdateCallback(handleStatusUpdate);
  useTelemetryCallback(handleTelemetryUpdate);

  const stationStatus = latest?.radioUpdate?.stationStatuses[station];
  const {
    ssid: stationSsid,
    isLinked,
    macAddress,
    signalDbm,
    noiseDbm,
    signalNoiseRatio,
    rxRateMbps,
    rxPackets,
    rxBytes,
    txRateMbps,
    txPackets,
    txBytes,
    bandwidthUsedMbps,
    connectionQuality,
    dataAgeMs,
  } = stationStatus || {};

  return (
    <>
      <TeamChecksModal station={station} />

      {/* DS connection alerts */}
      {matchState?.connectedStations[station]?.blockedDsIps &&
        matchState.connectedStations[station]!.blockedDsIps!.length > 0 && (
          <Alert
            severity="error"
            sx={{ mb: 1, fontWeight: 700, fontSize: '1.1rem', '& .MuiAlert-icon': { fontSize: '1.5rem' } }}
          >
            MULTIPLE DRIVER STATIONS DETECTED — {matchState.connectedStations[station]!.blockedDsIps!.join(', ')}{' '}
            blocked. Close the extra Driver Station
            {matchState.connectedStations[station]!.blockedDsIps!.length > 1 ? 's' : ''}.
          </Alert>
        )}

      <Card sx={{ mb: 2 }}>
        <CardContent sx={{ display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="h6">Radio Status</Typography>
              {isLinked ? (
                <Chip label="Linked" color="success" size="small" />
              ) : stationSsid ? (
                <Chip label="Not Linked" color="warning" size="small" variant="outlined" />
              ) : null}
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              {/* Internet access toggle */}
              {stationSsid && (
                <Tooltip title={internetAccess ? 'Disable internet access' : 'Enable internet access'}>
                  <IconButton
                    onClick={() => {
                      const next = !internetAccess;
                      setInternetAccess(next);
                      sendInternetToggle(station, next);
                    }}
                    size="small"
                    sx={{
                      color: internetAccess ? 'success.main' : 'text.secondary',
                      '&:hover': {
                        color: internetAccess ? 'success.dark' : 'success.main',
                        backgroundColor: 'action.hover',
                      },
                    }}
                  >
                    {internetAccess ? <PublicIcon /> : <PublicOffIcon />}
                  </IconButton>
                </Tooltip>
              )}
              {/* Chart/table toggle */}
              <Tooltip title={chartMode ? 'Show table view' : 'Show live charts'}>
                <IconButton
                  onClick={() => setChartMode(!chartMode)}
                  size="small"
                  sx={{
                    color: chartMode ? 'primary.main' : 'text.secondary',
                    backgroundColor: chartMode ? 'primary.light' : 'transparent',
                    '&:hover': {
                      backgroundColor: chartMode ? 'primary.main' : 'action.hover',
                      color: chartMode ? 'primary.contrastText' : 'text.primary',
                    },
                  }}
                >
                  <ShowChartIcon />
                </IconButton>
              </Tooltip>
            </Box>
          </Box>

          {isLinked && macAddress && (
            <CopyToClipboard text={macAddress} tooltipText="Click to copy MAC address">
              <Typography
                variant="body2"
                sx={{
                  fontFamily: 'monospace',
                  fontSize: '0.75rem',
                  color: 'text.secondary',
                  mb: 1,
                  cursor: 'pointer',
                  '&:hover': { color: 'text.primary', backgroundColor: 'action.hover' },
                  borderRadius: 0.5,
                  px: 0.5,
                  py: 0.25,
                  transition: 'all 0.2s',
                  width: 'fit-content',
                }}
              >
                {macAddress}
              </Typography>
            </CopyToClipboard>
          )}

          {chartMode && stationSsid ? (
            <Box sx={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
              <StationChart station={station} metric="signalLevels" height="60px" />
              <StationChart station={station} metric="snr" height="60px" />
              <StationChart station={station} metric="rates" height="60px" />
              <StationChart station={station} metric="packets" height="60px" />
              <StationChart station={station} metric="bytes" height="60px" />
              <StationChart station={station} metric="bandwidth" height="60px" />
              <StationChart station={station} metric="dataAge" height="60px" />
              <StationChart station={station} metric="quality" height="60px" />
              <StationChart station={station} metric="batteryVoltage" height="60px" />
              <StationChart station={station} metric="dsCpuPercent" height="60px" />
              <StationChart station={station} metric="robotStatus" height="60px" />
            </Box>
          ) : stationSsid && isLinked ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              {/* Signal Levels */}
              <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ textAlign: 'right' }}>Signal</TableCell>
                    <TableCell sx={{ textAlign: 'right' }}>Noise</TableCell>
                    <TableCell sx={{ textAlign: 'right' }}>SNR</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.light', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(signalDbm)} dBm
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.light', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(noiseDbm)} dBm
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(signalNoiseRatio)} dB
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              {/* Connection Quality, Bandwidth, and Data Age */}
              <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                <TableHead>
                  <TableRow>
                    <TableCell>Quality</TableCell>
                    <TableCell sx={{ textAlign: 'right' }}>Used</TableCell>
                    <TableCell sx={{ textAlign: 'right' }}>of Available</TableCell>
                    <TableCell sx={{ textAlign: 'right' }}>Data Age</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell
                      sx={{
                        color:
                          connectionQuality === 'excellent'
                            ? 'success.main'
                            : connectionQuality === 'good'
                              ? 'success.light'
                              : connectionQuality === 'caution'
                                ? 'warning.main'
                                : connectionQuality === 'warning'
                                  ? 'error.main'
                                  : 'text.disabled',
                      }}
                    >
                      {connectionQuality}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(bandwidthUsedMbps)} Mbps
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                      {rxRateMbps && txRateMbps
                        ? `${formatNumberWithThinSpace((bandwidthUsedMbps! / Math.min(rxRateMbps, txRateMbps)) * 100)}%`
                        : '—'}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'warning.light', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(dataAgeMs)} ms
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              {/* TX/RX */}
              <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                <TableHead>
                  <TableRow>
                    <TableCell></TableCell>
                    <Tooltip title="To robot">
                      <TableCell sx={{ textAlign: 'right' }}>TX</TableCell>
                    </Tooltip>
                    <Tooltip title="From robot">
                      <TableCell sx={{ textAlign: 'right' }}>RX</TableCell>
                    </Tooltip>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <TableRow>
                    <TableCell>Rate</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(txRateMbps)} Mbps
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(rxRateMbps)} Mbps
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Packets</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(txPackets)}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(rxPackets)}
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Bytes</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(txBytes)}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: 'error.main', textAlign: 'right' }}>
                      {formatNumberWithThinSpace(rxBytes)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>

              {/* IP Forwarding Counters */}
              {networkStats?.stations[station] &&
                (() => {
                  const fwd = networkStats.stations[station]!;
                  return (
                    <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>IP Forwarding</TableCell>
                          <Tooltip title="Packet count">
                            <TableCell sx={{ textAlign: 'right' }}>Packets</TableCell>
                          </Tooltip>
                          <Tooltip title="Byte count">
                            <TableCell sx={{ textAlign: 'right' }}>Bytes</TableCell>
                          </Tooltip>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell>From robot</TableCell>
                          <TableCell
                            sx={{
                              whiteSpace: 'nowrap',
                              color: 'error.main',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            {fwd.rxPackets.toLocaleString()}
                          </TableCell>
                          <TableCell
                            sx={{
                              whiteSpace: 'nowrap',
                              color: 'error.main',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            {formatBytes(fwd.rxBytes)}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>To robot</TableCell>
                          <TableCell
                            sx={{
                              whiteSpace: 'nowrap',
                              color: 'success.main',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            {fwd.txPackets.toLocaleString()}
                          </TableCell>
                          <TableCell
                            sx={{
                              whiteSpace: 'nowrap',
                              color: 'success.main',
                              textAlign: 'right',
                              fontFamily: 'monospace',
                            }}
                          >
                            {formatBytes(fwd.txBytes)}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  );
                })()}

              {/* Robot Telemetry */}
              {telemetry && (
                <>
                  <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ textAlign: 'right' }}>Battery</TableCell>
                        <TableCell sx={{ textAlign: 'right' }}>RTT</TableCell>
                        <TableCell sx={{ textAlign: 'right' }}>Lost Pkts</TableCell>
                        <TableCell sx={{ textAlign: 'right' }}>CAN</TableCell>
                        <TableCell sx={{ textAlign: 'right' }}>DS CPU</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      <TableRow>
                        <TableCell sx={{ whiteSpace: 'nowrap', color: 'success.main', textAlign: 'right' }}>
                          {telemetry.batteryVoltage?.toFixed(1)} V
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {telemetry.rttMs !== undefined ? `${telemetry.rttMs} ms` : '—'}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {telemetry.lostPackets !== undefined ? telemetry.lostPackets : '—'}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                          {telemetry.canUtil !== undefined ? `${telemetry.canUtil}%` : '—'}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap', color: 'info.light', textAlign: 'right' }}>
                          {telemetry.dsCpuPercent !== undefined ? `${telemetry.dsCpuPercent}%` : '—'}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>

                  {/* Status Chips */}
                  {telemetry.dsStatus && (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 0.5 }}>
                      <Chip
                        label={
                          telemetry.dsStatus.mode === 'teleOp'
                            ? 'TeleOp'
                            : telemetry.dsStatus.mode === 'auto'
                              ? 'Auto'
                              : 'Test'
                        }
                        size="small"
                        sx={{
                          backgroundColor:
                            telemetry.dsStatus.mode === 'teleOp'
                              ? 'info.main'
                              : telemetry.dsStatus.mode === 'auto'
                                ? 'success.main'
                                : 'warning.main',
                          color: '#fff',
                          fontSize: '0.7rem',
                          height: 20,
                        }}
                      />
                      <Chip
                        label={telemetry.dsStatus.robotComms ? 'Comms' : 'No Comms'}
                        size="small"
                        sx={{
                          backgroundColor: telemetry.dsStatus.robotComms ? 'success.main' : 'error.main',
                          color: '#fff',
                          fontSize: '0.7rem',
                          height: 20,
                        }}
                      />
                      <Chip
                        label={telemetry.dsStatus.radioPing ? 'Radio' : 'No Radio'}
                        size="small"
                        sx={{
                          backgroundColor: telemetry.dsStatus.radioPing ? 'info.main' : 'error.main',
                          color: '#fff',
                          fontSize: '0.7rem',
                          height: 20,
                        }}
                      />
                      <Chip
                        label={telemetry.dsStatus.rioPing ? 'RIO' : 'No RIO'}
                        size="small"
                        sx={{
                          backgroundColor: telemetry.dsStatus.rioPing ? 'info.main' : 'error.main',
                          color: '#fff',
                          fontSize: '0.7rem',
                          height: 20,
                        }}
                      />
                      {telemetry.dsStatus.eStop && (
                        <Chip
                          label="E-STOP"
                          size="small"
                          sx={{
                            backgroundColor: 'error.main',
                            color: '#fff',
                            fontSize: '0.7rem',
                            height: 20,
                            fontWeight: 'bold',
                          }}
                        />
                      )}
                      {telemetry.brownout && (
                        <Chip
                          label="BROWNOUT"
                          size="small"
                          sx={{
                            backgroundColor: 'warning.main',
                            color: '#fff',
                            fontSize: '0.7rem',
                            height: 20,
                            fontWeight: 'bold',
                          }}
                        />
                      )}
                    </Box>
                  )}
                </>
              )}

              {/* Subnet Scan */}
              {(() => {
                const scan = subnetScan?.stations[station];
                if (!scan || scan.hosts.length === 0) return null;
                const aliveCount = scan.hosts.filter(h => h.alive).length;
                return (
                  <Box sx={{ mt: 0.5 }}>
                    <Box
                      sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1, mb: 0.25 }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        Subnet {scan.subnet}
                      </Typography>
                      <Chip
                        label={`${aliveCount} / ${scan.hosts.length}`}
                        size="small"
                        color={aliveCount > 0 ? 'success' : 'default'}
                        sx={{ height: 18, fontSize: '0.7rem' }}
                      />
                    </Box>
                    <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                      <TableHead>
                        <TableRow>
                          <TableCell>IP</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Device</TableCell>
                          <TableCell>Last Seen</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {scan.hosts.map(host => (
                          <TableRow key={host.ip} sx={{ opacity: host.alive ? 1 : 0.5 }}>
                            <TableCell sx={{ fontFamily: 'monospace' }}>{host.ip}</TableCell>
                            <TableCell>
                              <Chip
                                label={host.alive ? 'UP' : 'DOWN'}
                                size="small"
                                color={host.alive ? 'success' : 'error'}
                                variant={host.alive ? 'filled' : 'outlined'}
                                sx={{ height: 18, fontSize: '0.7rem' }}
                              />
                            </TableCell>
                            <TableCell>{describeIp(host) ?? ''}</TableCell>
                            <TableCell>{formatAge(host.lastSeen)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                );
              })()}

              {/* mDNS Activity */}
              {(() => {
                const mdns = mdnsActivity?.stations[station];
                if (!mdns) return null;
                return (
                  <Box sx={{ mt: 0.5 }}>
                    <Box
                      sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1, mb: 0.25 }}
                    >
                      <Typography variant="caption" color="text.secondary">
                        mDNS Reflector
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                        {mdns.queriesForwarded}q / {mdns.responsesForwarded}r
                      </Typography>
                    </Box>
                    {mdns.recentNames.length > 0 && (
                      <Table size="small" sx={{ '& .MuiTableCell-root': { padding: '2px 8px', fontSize: '0.875rem' } }}>
                        <TableHead>
                          <TableRow>
                            <TableCell>Name</TableCell>
                            <TableCell>IP</TableCell>
                            <TableCell>Requester</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {mdns.recentNames.map(entry => (
                            <TableRow key={entry.name}>
                              <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                {entry.services && entry.services.length > 0 ? (
                                  <Tooltip title={entry.services.join(', ')} arrow placement="right">
                                    <span style={{ cursor: 'help', textDecoration: 'underline dotted' }}>
                                      {entry.name}
                                    </span>
                                  </Tooltip>
                                ) : (
                                  entry.name
                                )}
                              </TableCell>
                              <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                {entry.resolvedIp ?? '—'}
                              </TableCell>
                              <TableCell sx={{ fontFamily: 'monospace', fontSize: '0.75rem' }}>
                                {entry.requester ?? '—'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </Box>
                );
              })()}
            </Box>
          ) : stationSsid ? (
            <Typography variant="body2" color="warning.main" sx={{ fontStyle: 'italic', mt: 1 }}>
              Radio not linked — waiting for connection...
            </Typography>
          ) : null}
        </CardContent>
      </Card>

      {/* Network diagnostics card */}
      <StationNetworkCard
        station={station}
        stats={networkStats?.stations[station]}
        scan={subnetScan?.stations[station]}
        mdns={mdnsActivity?.stations[station]}
        dsInfo={matchState?.connectedStations[station]}
      />
    </>
  );
}
