import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
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
  sendSaveTeam,
  sendInternetToggle,
  useLatestTelemetry,
  useUpdateCallback,
  useTelemetryCallback,
  useNetworkStats,
  useSubnetScan,
  useMdnsActivity,
  useBackendStagedChanges,
  useLastLinked,
  sendRoutePreference,
  useRoutePreferenceState,
  usePortBridgeState,
  sendPortBridge,
} from '../hooks/useBackend';
import { MatchPanelForControl } from './MatchPanel';
import { TeamChecksModal } from './TeamChecksModal';
import { StationNetworkCard } from './NetworkPage';
import { StationName, StationNameList, SavedTeamConfig, PortConfig } from '../../../src/types';
import { createHash } from './cryptoUtils';
import { StationChart, handleStatusUpdate, handleTelemetryUpdate } from './StationChart';
import { CopyToClipboard } from './CopyToClipboard';
import IconButton from '@mui/material/IconButton';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import EthernetIcon from '@mui/icons-material/SettingsEthernet';
import ShowChartIcon from '@mui/icons-material/ShowChart';
import PublicIcon from '@mui/icons-material/Public';
import PublicOffIcon from '@mui/icons-material/PublicOff';
import InputAdornment from '@mui/material/InputAdornment';
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
 * Collect all SSIDs currently active or staged across ALL stations.
 * Used to prevent configuring the same SSID on multiple stations.
 */
function useAllActiveSSIDs(): Set<string> {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const ssids = new Set<string>();
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    for (const station of StationNameList) {
      // A staged clear means the station is being released — skip its active SSID
      const hasStagedClear = station in stagedChanges && stagedChanges[station] === null;

      // Staged config takes precedence
      const staged = stagedChanges[station];
      if (staged?.ssid) {
        ssids.add(staged.ssid);
        continue;
      }

      if (hasStagedClear) continue;

      const ssid = stationStatuses?.[station]?.ssid;
      if (ssid) ssids.add(ssid);
    }
    return ssids;
  }, [latest, stagedChanges]);
}

/**
 * Find ALL physical stations assigned to SSIDs belonging to a given team number.
 * Returns a Map of ssid → stationName.
 *
 * Stations with a staged clear (null) are excluded — they are pending release
 * and should not show as active for this team.
 */
function useStationsForTeam(teamNumber: number): Map<string, StationName> {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const result = new Map<string, StationName>();
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    for (const station of StationNameList) {
      const hasStagedClear = station in stagedChanges && stagedChanges[station] === null;

      // Check staged changes first — a staged config overrides active status,
      // and a staged clear means this station is pending release.
      const staged = stagedChanges[station];
      if (staged?.ssid) {
        const num = parseInt(staged.ssid.split('-', 2)[0]);
        if (num === teamNumber) {
          result.set(staged.ssid, station);
        }
        continue; // Staged config takes precedence over active radio status
      }

      if (hasStagedClear) continue; // Station pending release — skip

      // Check active radio status
      const ssid = stationStatuses?.[station]?.ssid;
      if (ssid) {
        const num = parseInt(ssid.split('-', 2)[0]);
        if (num === teamNumber) {
          result.set(ssid, station);
        }
      }
    }
    return result;
  }, [latest, stagedChanges, teamNumber]);
}

/**
 * Find the first unconfigured station slot.
 *
 * A station is considered available if it will be empty after pending changes
 * are applied: either it has no active config and no staged config, or it has
 * an active config but a staged clear (null) pending.
 */
function useFindAvailableStation(): StationName | null {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();

  return useMemo(() => {
    const stationStatuses = latest?.radioUpdate?.stationStatuses;

    for (const station of StationNameList) {
      const hasSsid = stationStatuses?.[station]?.ssid;
      const hasStagedConfig = station in stagedChanges && stagedChanges[station] !== null;
      const hasStagedClear = station in stagedChanges && stagedChanges[station] === null;
      // Available if: (no active config and no staged config) OR (staged clear pending)
      if ((!hasSsid && !hasStagedConfig) || hasStagedClear) {
        return station;
      }
    }
    return null;
  }, [latest, stagedChanges]);
}

type DisconnectedStation = {
  station: StationName;
  ssid: string;
  lastLinked: number | null;
};

/**
 * Find all configured stations where the robot is NOT currently linked.
 * Returns them sorted by lastLinked timestamp ascending (oldest first = best takeover candidates).
 */
function useFindDisconnectedStations(): DisconnectedStation[] {
  const latest = useLatest();
  const stagedChanges = useBackendStagedChanges();
  const lastLinked = useLastLinked();

  return useMemo(() => {
    const stationStatuses = latest?.radioUpdate?.stationStatuses;
    const disconnected: DisconnectedStation[] = [];

    for (const station of StationNameList) {
      // Skip stations with staged changes — they're in flux
      if (station in stagedChanges) continue;

      const status = stationStatuses?.[station];
      if (!status?.ssid) continue; // Not configured

      // Robot not linked = disconnected
      if (!status.isLinked) {
        disconnected.push({
          station,
          ssid: status.ssid,
          lastLinked: lastLinked[station] ?? null,
        });
      }
    }

    // Sort by lastLinked ascending (null = never linked = oldest = first)
    return disconnected.sort((a, b) => {
      const aTime = a.lastLinked ?? 0;
      const bTime = b.lastLinked ?? 0;
      return aTime - bTime;
    });
  }, [latest, stagedChanges, lastLinked]);
}

/**
 * The main control page component.
 * URL: /<ssid>
 *
 * Shows a robot management dashboard for a single team:
 * - List of saved robot configs for this team (always visible)
 * - Add new robot form
 * - Selected robot's status and match controls
 *
 * Each DS laptop opens /<ssid> for the specific robot it drives.
 * Selecting a different robot updates the URL via replaceState.
 */
export function ControlPage({ teamNumber, selectedSsid }: { teamNumber: number; selectedSsid: string }) {
  const [currentSsid, setCurrentSsid] = useState(selectedSsid);

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

  // Selection handler — updates URL, and sets route preference when team has multiple robots
  const handleSelectRobot = useCallback(
    (ssid: string) => {
      setCurrentSsid(ssid);
      window.history.replaceState(null, '', `/${encodeURIComponent(ssid)}`);

      const station = activeStations.get(ssid);
      if (station && activeStations.size > 1) {
        sendRoutePreference(station);
      }
    },
    [activeStations],
  );

  // Auto-select: if the current SSID is not active but another robot for this team is,
  // switch to the first active one.
  useEffect(() => {
    if (activeStations.has(currentSsid)) return;
    if (activeStations.size > 0) {
      const firstSsid = activeStations.keys().next().value as string;
      handleSelectRobot(firstSsid);
    }
  }, [activeStations, currentSsid, handleSelectRobot]);

  const selectedStation = activeStations.get(currentSsid) ?? null;

  // Route preference state — for multi-robot routing feedback
  const routeState = useRoutePreferenceState();
  const routePreference = routeState?.preference ?? null;
  const isMultiRobot = activeStations.size >= 2;

  // Resolve the SSID that the laptop is currently routed to
  const routedSsid = useMemo(() => {
    if (!routePreference) return null;
    for (const [ssid, station] of activeStations) {
      if (station === routePreference) return ssid;
    }
    return null;
  }, [routePreference, activeStations]);

  return (
    <Container maxWidth="md" sx={{ py: 2 }}>
      <Typography variant="h4" sx={{ mb: 2, fontWeight: 700 }}>
        Team {teamNumber}
      </Typography>

      {/* Routing banner for multi-robot teams */}
      {isMultiRobot && (
        <Alert
          severity={routedSsid ? (routedSsid === currentSsid ? 'success' : 'warning') : 'info'}
          sx={{ mb: 2, '& .MuiAlert-message': { width: '100%' } }}
        >
          {routedSsid ? (
            <>
              This laptop is routed to <strong>{routedSsid}</strong>.
              {routedSsid !== currentSsid && ' Select it below or click the robot you want to drive.'}
            </>
          ) : (
            'Select a robot below to route this laptop to its network.'
          )}
          <Typography variant="caption" display="block" sx={{ mt: 0.5 }}>
            Each Driver Station laptop should open{' '}
            <strong>
              /<em>SSID</em>
            </strong>{' '}
            for the robot it drives.
          </Typography>
        </Alert>
      )}

      {/* Robot list and add-robot form */}
      <RobotList
        teamNumber={teamNumber}
        teamConfigs={teamConfigs}
        activeStations={activeStations}
        availableStation={availableStation}
        selectedSsid={currentSsid}
        onSelectRobot={handleSelectRobot}
        routePreference={routePreference}
        isMultiRobot={isMultiRobot}
      />

      {/* All active robots' station experiences — charts only for selected */}
      {activeStations.size === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2, textAlign: 'center' }}>
          No active robots. Enable a robot above to see its status.
        </Typography>
      ) : (
        Array.from(activeStations.entries()).map(([ssid, station]) => {
          const isSelected = ssid === currentSsid;
          return (
            <Box key={ssid} sx={{ mt: 2 }}>
              <Typography variant="h6" sx={{ fontFamily: 'monospace', mb: 1 }}>
                {ssid}
              </Typography>
              <MatchPanelForControl station={station} ssid={ssid} />
              <PortSelector station={station} />
              <StationExperience station={station} showCharts={isSelected} />
            </Box>
          );
        })
      )}
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
  selectedSsid,
  onSelectRobot,
  routePreference,
  isMultiRobot,
}: {
  teamNumber: number;
  teamConfigs: SavedTeamConfig[];
  activeStations: Map<string, StationName>;
  availableStation: StationName | null;
  selectedSsid: string;
  onSelectRobot: (ssid: string) => void;
  routePreference: StationName | null;
  isMultiRobot: boolean;
}) {
  const [showAddForm, setShowAddForm] = useState(false);
  const disconnectedStations = useFindDisconnectedStations();

  return (
    <Card sx={{ mb: 2 }}>
      <CardContent>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
          <Typography variant="h6">Robots</Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => setShowAddForm(!showAddForm)}>
            Add Robot
          </Button>
        </Box>

        {!availableStation && disconnectedStations.length > 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            All 6 radio slots are in use, but {disconnectedStations.length} disconnected robot
            {disconnectedStations.length > 1 ? 's are' : ' is'} available to take over.
          </Alert>
        )}

        {!availableStation && disconnectedStations.length === 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            All 6 radio slots are in use and all robots are connected. Wait for a team to leave before enabling a new
            robot.
          </Alert>
        )}

        {showAddForm && (
          <AddRobotForm
            teamNumber={teamNumber}
            availableStation={availableStation}
            disconnectedStations={disconnectedStations}
            onDone={() => setShowAddForm(false)}
            onSelectRobot={onSelectRobot}
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
                isSelected={config.ssid === selectedSsid}
                activeStation={activeStations.get(config.ssid) ?? null}
                availableStation={availableStation}
                disconnectedStations={disconnectedStations}
                onSelect={() => onSelectRobot(config.ssid)}
                routePreference={routePreference}
                isMultiRobot={isMultiRobot}
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
 * Clickable to select — the selected robot's experience is shown below the list.
 */
function RobotRow({
  config,
  isActive,
  isSelected,
  activeStation,
  availableStation,
  disconnectedStations,
  onSelect,
  routePreference,
  isMultiRobot,
}: {
  config: SavedTeamConfig;
  isActive: boolean;
  isSelected: boolean;
  activeStation: StationName | null;
  availableStation: StationName | null;
  disconnectedStations: DisconnectedStation[];
  onSelect: () => void;
  routePreference: StationName | null;
  isMultiRobot: boolean;
}) {
  const [showTakeover, setShowTakeover] = useState(false);
  const suffix = config.ssid.includes('-') ? config.ssid.split('-').slice(1).join('-') : null;
  const canTakeover = !isActive && !availableStation && disconnectedStations.length > 0;

  const handleEnable = (stage: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!availableStation) return;
    sendNewConfig(availableStation, config.ssid, config.wpaKey, stage);
    onSelect(); // Auto-select the robot being enabled
  };

  const handleRelease = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!activeStation) return;
    sendNewConfig(activeStation, '', '', true);
  };

  const handleTakeover = (targetStation: StationName, stage: boolean) => {
    sendNewConfig(targetStation, '', '', true);
    sendNewConfig(targetStation, config.ssid, config.wpaKey, stage);
    setShowTakeover(false);
    onSelect(); // Auto-select the robot being configured
  };

  return (
    <>
      <Box
        onClick={onSelect}
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 2,
          py: 1,
          borderRadius: 1,
          cursor: 'pointer',
          backgroundColor: isSelected ? 'action.selected' : 'transparent',
          borderLeft: isSelected ? 3 : 0,
          borderColor: 'primary.main',
          '&:hover': { backgroundColor: isSelected ? 'action.selected' : 'action.hover' },
          transition: 'background-color 0.15s',
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Typography variant="body1" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
              {suffix ?? config.ssid}
            </Typography>
            {isActive && <Chip label="Active" color="success" size="small" sx={{ height: 20, fontSize: '0.7rem' }} />}
            {isActive &&
              isMultiRobot &&
              (routePreference === activeStation ? (
                <Chip
                  label="Driving"
                  color="info"
                  size="small"
                  sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700 }}
                />
              ) : (
                <Button
                  size="small"
                  variant="contained"
                  onClick={e => {
                    e.stopPropagation();
                    sendRoutePreference(activeStation!);
                    onSelect();
                  }}
                  sx={{ height: 22, fontSize: '0.7rem', textTransform: 'none', minWidth: 0, px: 1.5 }}
                >
                  Drive
                </Button>
              ))}
          </Box>
          <Typography variant="caption" color="text.secondary">
            Last used {formatAge(config.lastUsedAt)}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {isActive ? (
            <Tooltip title="Release this robot's radio slot">
              <Button size="small" variant="outlined" color="warning" onClick={e => handleRelease(e)}>
                Release
              </Button>
            </Tooltip>
          ) : availableStation ? (
            <>
              <Button size="small" variant="outlined" onClick={e => handleEnable(true, e)}>
                Stage
              </Button>
              <Button size="small" variant="contained" onClick={e => handleEnable(false, e)}>
                Enable
              </Button>
            </>
          ) : canTakeover ? (
            <Button
              size="small"
              variant="outlined"
              color="warning"
              onClick={e => {
                e.stopPropagation();
                setShowTakeover(!showTakeover);
              }}
            >
              Take Over Slot
            </Button>
          ) : (
            <Tooltip title="All slots in use and connected">
              <span>
                <Button size="small" variant="outlined" disabled>
                  Enable
                </Button>
              </span>
            </Tooltip>
          )}
        </Box>
      </Box>

      {showTakeover && (
        <TakeoverPicker
          disconnectedStations={disconnectedStations}
          onSelect={(station, stage) => handleTakeover(station, stage)}
          onCancel={() => setShowTakeover(false)}
        />
      )}
    </>
  );
}

/**
 * Inline picker showing disconnected stations sorted by staleness.
 * Lets the user choose which slot to take over.
 */
function TakeoverPicker({
  disconnectedStations,
  onSelect,
  onCancel,
}: {
  disconnectedStations: DisconnectedStation[];
  onSelect: (station: StationName, stage: boolean) => void;
  onCancel: () => void;
}) {
  return (
    <Card variant="outlined" sx={{ mx: 2, mb: 1, p: 1.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Select a slot to take over
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        The selected team&apos;s config will be cleared and replaced with yours.
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        {disconnectedStations.map(({ station, ssid, lastLinked }) => (
          <Box
            key={station}
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              px: 1.5,
              py: 0.5,
              borderRadius: 1,
              border: 1,
              borderColor: 'divider',
            }}
          >
            <Box>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                {ssid}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {lastLinked ? `Last connected ${formatAge(lastLinked)}` : 'Never connected'}
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', gap: 0.5 }}>
              <Button size="small" variant="outlined" onClick={() => onSelect(station, true)}>
                Stage
              </Button>
              <Button size="small" variant="contained" onClick={() => onSelect(station, false)}>
                Apply Now
              </Button>
            </Box>
          </Box>
        ))}
      </Box>
      <Button size="small" onClick={onCancel} sx={{ mt: 1 }}>
        Cancel
      </Button>
    </Card>
  );
}

/**
 * Form for adding a new robot (suffix + passphrase).
 */
function AddRobotForm({
  teamNumber,
  availableStation,
  disconnectedStations,
  onDone,
  onSelectRobot,
}: {
  teamNumber: number;
  availableStation: StationName | null;
  disconnectedStations: DisconnectedStation[];
  onDone: () => void;
  onSelectRobot: (ssid: string) => void;
}) {
  const [suffix, setSuffix] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showTakeover, setShowTakeover] = useState(false);
  const allActiveSSIDs = useAllActiveSSIDs();

  const ssid = suffix ? `${teamNumber}-${suffix}` : `${teamNumber}`;
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;
  const isValid = passphraseRegex.test(passphrase);
  const isDuplicate = allActiveSSIDs.has(ssid);
  const canTakeover = !availableStation && disconnectedStations.length > 0;

  const handleSubmit = (stage: boolean) => {
    if (!isValid || !availableStation || isDuplicate) return;
    sendNewConfig(availableStation, ssid, passphrase, stage);
    onSelectRobot(ssid); // Auto-select the newly added robot
    onDone();
  };

  const handleTakeover = (targetStation: StationName, stage: boolean) => {
    if (!isValid || isDuplicate) return;
    sendNewConfig(targetStation, '', '', true);
    sendNewConfig(targetStation, ssid, passphrase, stage);
    onSelectRobot(ssid); // Auto-select the newly added robot
    onDone();
  };

  const handleSaveForLater = () => {
    if (!isValid || isDuplicate) return;
    sendSaveTeam(ssid, passphrase);
    onSelectRobot(ssid);
    onDone();
  };

  return (
    <Card variant="outlined" sx={{ mb: 2, p: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        New Robot
      </Typography>
      <Typography variant="body2" color={isDuplicate ? 'error' : 'text.secondary'} sx={{ mb: 1 }}>
        SSID: <strong>{ssid}</strong>
        {isDuplicate && ' — already active'}
      </Typography>
      <TextField
        label="Suffix (optional)"
        value={suffix}
        onChange={e => setSuffix(e.target.value.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 10))}
        fullWidth
        size="small"
        sx={{ mb: 1 }}
        InputProps={
          suffix
            ? {
                startAdornment: (
                  <InputAdornment position="start">
                    <Typography sx={{ fontFamily: 'monospace' }}>{teamNumber}-</Typography>
                  </InputAdornment>
                ),
              }
            : undefined
        }
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
        {availableStation ? (
          <>
            <Button
              variant="outlined"
              size="small"
              disabled={!isValid || isDuplicate}
              onClick={() => handleSubmit(true)}
            >
              Stage
            </Button>
            <Button
              variant="contained"
              size="small"
              disabled={!isValid || isDuplicate}
              onClick={() => handleSubmit(false)}
            >
              Apply Now
            </Button>
          </>
        ) : canTakeover ? (
          <Button
            variant="outlined"
            size="small"
            color="warning"
            disabled={!isValid || isDuplicate}
            onClick={() => setShowTakeover(!showTakeover)}
          >
            Take Over Slot
          </Button>
        ) : (
          <Tooltip title="All slots in use and connected">
            <span>
              <Button variant="contained" size="small" disabled>
                No Slots Available
              </Button>
            </span>
          </Tooltip>
        )}
        <Button variant="outlined" size="small" disabled={!isValid || isDuplicate} onClick={handleSaveForLater}>
          Save for Later
        </Button>
        <Button size="small" onClick={onDone}>
          Cancel
        </Button>
      </Box>

      {showTakeover && (
        <Box sx={{ mt: 2 }}>
          <TakeoverPicker
            disconnectedStations={disconnectedStations}
            onSelect={(station, stage) => handleTakeover(station, stage)}
            onCancel={() => setShowTakeover(false)}
          />
        </Box>
      )}
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
 * Debounce the "multiple DS" warning so it doesn't flicker when DS TCP flaps (~6s cycle).
 * Holds the warning for `holdMs` after blockedDsIps clears, then releases.
 */
type DebouncedDsInfo = { acceptedIp: string; blockedIps: string[] } | null;

function useDebouncedMultipleDsWarning(station: StationName, holdMs = 10_000): DebouncedDsInfo {
  const matchState = useMatchState();
  const dsInfo = matchState?.connectedStations[station];
  const liveBlockedIps = dsInfo?.blockedDsIps;
  const liveAcceptedIp = dsInfo?.ip;
  const hasBlocked = liveBlockedIps && liveBlockedIps.length > 0;

  const [displayed, setDisplayed] = useState<DebouncedDsInfo>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastNonEmptyRef = useRef<DebouncedDsInfo>(null);

  useEffect(() => {
    if (hasBlocked && liveAcceptedIp) {
      // Blocked IPs present — show immediately and cancel any pending clear
      if (holdTimerRef.current) {
        clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const info: DebouncedDsInfo = { acceptedIp: liveAcceptedIp, blockedIps: [...liveBlockedIps] };
      lastNonEmptyRef.current = info;
      setDisplayed(info);
    } else if (lastNonEmptyRef.current) {
      // Blocked IPs just cleared — hold the previous value for holdMs
      if (!holdTimerRef.current) {
        holdTimerRef.current = setTimeout(() => {
          setDisplayed(null);
          lastNonEmptyRef.current = null;
          holdTimerRef.current = null;
        }, holdMs);
      }
    }
  }, [hasBlocked, liveAcceptedIp, liveBlockedIps, holdMs]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    };
  }, []);

  return displayed;
}

/**
 * Full station experience shown once a robot is configured on a physical station.
 * Shows radio status, telemetry, charts, network diagnostics, etc.
 *
 * When showCharts is false, the chart toggle and chart view are hidden entirely
 * (used for non-selected robots in multi-robot teams).
 */
function StationExperience({ station, showCharts = true }: { station: StationName; showCharts?: boolean }) {
  const [chartMode, setChartMode] = useState(true);
  const [internetAccess, setInternetAccess] = useState(false);
  const latest = useLatest();
  const matchState = useMatchState();
  const telemetry = useLatestTelemetry(station);
  const networkStats = useNetworkStats();
  const subnetScan = useSubnetScan();
  const mdnsActivity = useMdnsActivity();
  const multipleDsWarning = useDebouncedMultipleDsWarning(station);
  const routeState = useRoutePreferenceState();
  const yourIp = routeState?.yourIp;

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

      {/* DS connection alerts — shows all DS IPs (accepted + blocked) with debounced hold */}
      {multipleDsWarning && (
        <Alert
          severity="error"
          sx={{ mb: 1, fontWeight: 700, fontSize: '1.1rem', '& .MuiAlert-icon': { fontSize: '1.5rem' } }}
        >
          MULTIPLE DRIVER STATIONS DETECTED
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5, fontSize: '0.9rem', fontWeight: 400 }}>
            <li>
              <strong>{multipleDsWarning.acceptedIp}</strong>
              {multipleDsWarning.acceptedIp === yourIp && (
                <Chip label="YOU" size="small" color="info" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />
              )}
              {' — active'}
            </li>
            {multipleDsWarning.blockedIps.map(ip => (
              <li key={ip}>
                <strong>{ip}</strong>
                {ip === yourIp && (
                  <Chip label="YOU" size="small" color="error" sx={{ ml: 0.5, height: 18, fontSize: '0.65rem' }} />
                )}
                {' — blocked'}
              </li>
            ))}
          </Box>
          <Typography variant="body2" sx={{ mt: 0.5, fontWeight: 400 }}>
            Close the extra Driver Station{multipleDsWarning.blockedIps.length > 1 ? 's' : ''}.
          </Typography>
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
              {/* Chart/table toggle — only shown when charts are enabled */}
              {showCharts && (
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
              )}
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

          {showCharts && chartMode && stationSsid ? (
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
        hideStationLabel
        yourIp={yourIp}
      />
    </>
  );
}

/**
 * Port selector — lets a team bridge a physical Ethernet port to their station.
 * Only rendered when FIELD_PORTS is configured on the server.
 */
function PortSelector({ station }: { station: StationName }) {
  const portState = usePortBridgeState();

  // Don't render if port bridging is not configured
  if (!portState || portState.ports.length === 0) return null;

  // Find which port (if any) is currently bridged to this station
  const currentPortVlanId = Object.entries(portState.activeBridges).find(([, s]) => s === station)?.[0];
  const currentPort = currentPortVlanId ? portState.ports.find(p => p.vlanId === Number(currentPortVlanId)) : null;

  // Build list of available ports (not bridged to another station)
  const usedVlanIds = new Set(
    Object.entries(portState.activeBridges)
      .filter(([, s]) => s !== station)
      .map(([vlanId]) => Number(vlanId)),
  );
  const availablePorts = portState.ports.filter(p => !usedVlanIds.has(p.vlanId));

  const handleChange = (value: string) => {
    if (value === '') {
      // Disconnect
      sendPortBridge(station, null);
    } else {
      sendPortBridge(station, Number(value));
    }
  };

  return (
    <Card sx={{ mb: 1 }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <EthernetIcon sx={{ color: currentPort ? 'success.main' : 'text.secondary', fontSize: 20 }} />
          <FormControl size="small" sx={{ minWidth: 200, flex: 1 }}>
            <InputLabel id={`port-select-${station}`}>Ethernet Port</InputLabel>
            <Select
              labelId={`port-select-${station}`}
              label="Ethernet Port"
              value={currentPortVlanId ?? ''}
              onChange={e => handleChange(e.target.value as string)}
            >
              <MenuItem value="">
                <em>None</em>
              </MenuItem>
              {availablePorts.map(port => (
                <MenuItem key={port.vlanId} value={String(port.vlanId)}>
                  {port.name}
                </MenuItem>
              ))}
              {/* Show the currently selected port even if it's "used" (by this station) */}
              {currentPort && !availablePorts.find(p => p.vlanId === currentPort.vlanId) && (
                <MenuItem key={currentPort.vlanId} value={String(currentPort.vlanId)}>
                  {currentPort.name}
                </MenuItem>
              )}
            </Select>
          </FormControl>
          {currentPort && (
            <Chip
              label={`Connected to ${currentPort.name}`}
              color="success"
              size="small"
              sx={{ fontSize: '0.75rem' }}
            />
          )}
        </Box>
      </CardContent>
    </Card>
  );
}
