import { useState, useMemo, useCallback } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Container from '@mui/material/Container';
import Link from '@mui/material/Link';
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
import { StationChart, GroupedChart, handleStatusUpdate, handleTelemetryUpdate } from './StationChart';
import { TeamChecksPanel } from './TeamChecksPanel';
import { CopyToClipboard } from './CopyToClipboard';
import IconButton from '@mui/material/IconButton';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import PublicIcon from '@mui/icons-material/Public';
import PublicOffIcon from '@mui/icons-material/PublicOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import Switch from '@mui/material/Switch';
import FormControlLabel from '@mui/material/FormControlLabel';
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
 * Find the physical station for a given SSID from radio status data.
 */
function useStationForSsid(ssid: string): StationName | null {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    // Check active radio status
    if (stationStatuses) {
      for (const station of StationNameList) {
        if (stationStatuses[station]?.ssid === ssid) {
          return station;
        }
      }
    }

    // Check staged changes
    for (const station of StationNameList) {
      const staged = stagedChanges[station];
      if (staged && staged.ssid === ssid) {
        return station;
      }
    }

    return null;
  }, [latest, stagedChanges, ssid]);
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
 * URL: /control/<ssid>
 *
 * This page replaces the old /red1, /blue2, etc. station pages.
 * Users see their team config and can join matches by choosing an alliance.
 */
export function ControlPage({ ssid }: { ssid: string }) {
  // Parse team number from SSID
  const teamNumber = parseInt(ssid.split('-', 2)[0]);
  const suffix = ssid.includes('-') ? ssid.split('-').slice(1).join('-') : undefined;
  const displayName = isNaN(teamNumber) ? ssid : suffix ? `${teamNumber}-${suffix}` : `${teamNumber}`;

  // Find the physical station this SSID is currently assigned to
  const station = useStationForSsid(ssid);
  const availableStation = useFindAvailableStation();

  // Server-side saved team configs
  const savedTeams = useSavedTeams();
  const savedConfig = savedTeams?.teams.find(t => t.ssid === ssid);

  const handleChangeTeam = () => {
    localStorage.removeItem('saved-team-number');
    localStorage.removeItem('saved-team-suffix');
    window.location.href = '/';
  };

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h4" sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          Team {displayName}
          {station && <Chip label="Connected" color="success" size="small" icon={<CheckCircleIcon />} />}
        </Typography>
        <Link
          component="button"
          variant="body2"
          onClick={handleChangeTeam}
          underline="hover"
          sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}
        >
          Change Team
        </Link>
      </Box>

      {/* Show match panel if station is assigned */}
      {station && <MatchPanelForControl station={station} ssid={ssid} />}

      {/* Configuration section */}
      {station ? (
        <StationExperience station={station} ssid={ssid} />
      ) : (
        <ConfigurationPanel ssid={ssid} savedConfig={savedConfig} availableStation={availableStation} />
      )}
    </Container>
  );
}

/**
 * Panel shown when this SSID is not yet configured on any station.
 * Shows saved config (if available) or passphrase entry form.
 */
function ConfigurationPanel({
  ssid,
  savedConfig,
  availableStation,
}: {
  ssid: string;
  savedConfig: SavedTeamConfig | undefined;
  availableStation: StationName | null;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [internetAccess, setInternetAccess] = useState(false);

  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;
  const isPassphraseValid = passphraseRegex.test(passphrase);

  const handleEnable = (wpaKey: string, stage = false, internet = false) => {
    if (!availableStation) return;
    sendNewConfig(availableStation, ssid, wpaKey, stage, internet);
  };

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        {!availableStation && (
          <Alert severity="error" sx={{ mb: 2 }}>
            All 6 radio slots are in use. Remove a team from another station before enabling this one.
          </Alert>
        )}

        {savedConfig ? (
          <SavedConfigSection savedConfig={savedConfig} availableStation={availableStation} onEnable={handleEnable} />
        ) : (
          <Box>
            <Typography variant="h6" gutterBottom>
              Configure Wi-Fi
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Enter the WPA passphrase for SSID <strong>FRC-{ssid}</strong>
            </Typography>
            <TextField
              label="Passphrase"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              fullWidth
              margin="normal"
              helperText={
                passphrase && !isPassphraseValid ? 'Passphrase must be alphanumeric and between 8-16 characters.' : ''
              }
              error={!!passphrase && !isPassphraseValid}
            />
            <FormControlLabel
              control={<Switch checked={internetAccess} onChange={(_, checked) => setInternetAccess(checked)} />}
              label="Internet access"
            />
            <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
              <Button
                variant="contained"
                color="primary"
                disabled={!isPassphraseValid || !availableStation}
                onClick={() => handleEnable(passphrase, false, internetAccess)}
              >
                Enable
              </Button>
              <Button
                variant="outlined"
                color="secondary"
                disabled={!isPassphraseValid || !availableStation}
                onClick={() => handleEnable(passphrase, true, internetAccess)}
              >
                Stage
              </Button>
            </Box>
          </Box>
        )}

        {/* Passphrase check section (optional) */}
        <PassphraseChecker ssid={ssid} savedConfig={savedConfig} />
      </CardContent>
    </Card>
  );
}

/**
 * Shows a saved config with enable/stage buttons.
 */
function SavedConfigSection({
  savedConfig,
  availableStation,
  onEnable,
}: {
  savedConfig: SavedTeamConfig;
  availableStation: StationName | null;
  onEnable: (wpaKey: string, stage?: boolean, internet?: boolean) => void;
}) {
  const [internetAccess, setInternetAccess] = useState(savedConfig.internetAccess ?? false);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="h6">Saved Configuration</Typography>
        <Tooltip title="Remove saved configuration">
          <IconButton
            size="small"
            onClick={() => sendRemoveSavedTeam(savedConfig.ssid)}
            sx={{ color: 'text.secondary', '&:hover': { color: 'error.main' } }}
          >
            <DeleteOutlineIcon />
          </IconButton>
        </Tooltip>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Last used {formatAge(savedConfig.lastUsedAt)}
      </Typography>

      <FormControlLabel
        control={<Switch checked={internetAccess} onChange={(_, checked) => setInternetAccess(checked)} />}
        label="Internet access"
      />

      <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
        <Button
          variant="contained"
          color="primary"
          size="large"
          disabled={!availableStation}
          onClick={() => onEnable(savedConfig.wpaKey, false, internetAccess)}
          sx={{ flex: 1 }}
        >
          Enable
        </Button>
        <Button
          variant="outlined"
          color="secondary"
          disabled={!availableStation}
          onClick={() => onEnable(savedConfig.wpaKey, true, internetAccess)}
        >
          Stage
        </Button>
      </Box>
    </Box>
  );
}

/**
 * Optional passphrase verification feature.
 * Computes SHA-256(ssid + input) on each keypress and compares to the server's hash.
 */
function PassphraseChecker({ ssid, savedConfig }: { ssid: string; savedConfig: SavedTeamConfig | undefined }) {
  const [checkValue, setCheckValue] = useState('');
  const [hashMatch, setHashMatch] = useState<boolean | null>(null);
  const savedTeams = useSavedTeams();

  const handleCheck = useCallback(
    async (value: string) => {
      setCheckValue(value);

      if (value.length < 8) {
        setHashMatch(null);
        return;
      }

      // Compute SHA-256(ssid + value) and compare against all saved teams
      const hash = await createHash(ssid + value);
      const teams = savedTeams?.teams ?? [];
      const match = teams.some(t => t.ssid === ssid && t.wpaKeyHash === hash);
      setHashMatch(match);
    },
    [ssid, savedTeams],
  );

  // Only show if there's a saved config with a hash to compare against
  if (!savedConfig?.wpaKeyHash) return null;

  return (
    <Box sx={{ mt: 3, pt: 2, borderTop: 1, borderColor: 'divider' }}>
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
        {hashMatch === true && <CheckCircleIcon sx={{ color: 'success.main' }} />}
        {hashMatch === false && (
          <Typography variant="body2" color="error">
            No match
          </Typography>
        )}
      </Box>
    </Box>
  );
}

/**
 * Full station experience shown once a team is configured on a physical station.
 * Shows robot connection status, telemetry, charts, network diagnostics, etc.
 */
function StationExperience({ station }: { station: StationName; ssid: string }) {
  const [chartMode, setChartMode] = useState(true);
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

  const internetAccess = latest?.radioUpdate?.stationStatuses[station]?.ssid ? false : false; // TODO: get actual internet state

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
