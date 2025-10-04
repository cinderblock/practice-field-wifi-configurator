import { useState, useRef } from 'react';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import TextField from '@mui/material/TextField';
import DialogActions from '@mui/material/DialogActions';
import Button from '@mui/material/Button';
import SettingsIcon from '@mui/icons-material/Settings';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import { StationName, SavedWiFiSetting } from '../../../src/types';
import { useLatest, sendNewConfig } from '../hooks/useBackend';
import { useSavedWiFiSettings } from '../hooks/useSavedWiFiSettings';
import { useStagedChanges } from '../hooks/useStagedChanges';
import { TimeDisplay } from './TimeDisplay';
import { prettyStationName } from '../../../src/utils';
import { Grid, Box, Tooltip } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import ClearIcon from '@mui/icons-material/Clear';

export function StationStatus({ station, full }: { station: StationName; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrases, setShowPassphrases] = useState(false);
  const ssidInputRef = useRef<HTMLInputElement | null>(null);

  // Feature flag for staging functionality
  const enableStaging = process.env.REACT_APP_ENABLE_STAGING === 'true';

  const latest = useLatest();
  const { recentSettings, saveSetting, clearSettings, removeSetting } = useSavedWiFiSettings();
  const { stagedChanges, hasStagedChange, stageChange, applyStagedChange } = useStagedChanges();

  if (!latest) {
    return <Typography>Loading...</Typography>;
  }

  const {
    ssid: stationSsid,
    hashedWpaKey,
    isLinked,
    macAddress,
    dataAgeMs,
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
  } = latest.radioUpdate?.stationStatuses[station] || {};

  const handleOpen = () => {
    setSsid(stationSsid || '');
    setPassphrase('');
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleSave = (stage: boolean) => {
    if (enableStaging && stage) {
      // Staging mode: stage the change
      sendNewConfig(station, ssid, passphrase, true);

      // Track staged change
      if (ssid.trim() && passphrase.trim()) {
        stageChange(station, ssid, passphrase);
      }
    } else {
      // Direct apply mode: apply immediately
      sendNewConfig(station, ssid, passphrase, false);

      if (enableStaging) {
        // Clear any staged change when applying
        applyStagedChange(station);
      }

      // Auto-save the setting if it's valid and not empty
      if (ssid.trim() && passphrase.trim()) {
        saveSetting(ssid, passphrase);
      }
    }

    setOpen(false);
  };

  const handleApplySetting = (setting: SavedWiFiSetting) => {
    setSsid(setting.ssid);
    setPassphrase(setting.wpaKey);
  };

  const handleRemoveSetting = (e: React.MouseEvent, setting: SavedWiFiSetting) => {
    e.stopPropagation(); // Prevent row click
    removeSetting(setting.ssid, setting.wpaKey);
  };

  const handleApplyAllStagedChanges = () => {
    // Apply all staged changes across all stations
    // Only stations with staged changes (stagedChange !== null) will be processed
    Object.entries(stagedChanges).forEach(([stationName, stagedChange]) => {
      if (stagedChange) {
        // Apply the staged change
        sendNewConfig(stationName as StationName, stagedChange.ssid, stagedChange.wpaKey, false);

        // Auto-save the setting
        saveSetting(stagedChange.ssid, stagedChange.wpaKey);

        // Clear the staged change
        applyStagedChange(stationName as StationName);
      }
      // Stations without staged changes (stagedChange === null) are skipped
    });
  };

  const handleClearStation = () => {
    console.log('Clearing station:', station, 'Current SSID:', stationSsid);

    // Only clear if the station is actually configured
    if (stationSsid || (enableStaging && hasStagedChange(station))) {
      // Send empty strings like the dialog does
      sendNewConfig(station, '', '', false);

      // Clear any staged changes for this station
      if (enableStaging) {
        applyStagedChange(station);
      }
    } else {
      console.log('Station is already cleared, no action needed');
    }
  };

  const ssidRegex = /^[a-zA-Z0-9-]{0,14}$/;
  const ssidFormatRegex = /^\d{1,6}(?:-.*)?$/; // FIRST SSID format
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;

  const isSSIDEmpty = ssid === '';
  const isSaveEnabled: boolean =
    isSSIDEmpty || (passphraseRegex.test(passphrase) && ssidRegex.test(ssid) && ssidFormatRegex.test(ssid));

  const pretty = prettyStationName(station);

  const borderStyle = {
    borderLeft: `0.5em solid ${station.startsWith('red') ? 'red' : 'blue'}`,
  };

  const modalStyle = {
    minHeight: '5em',
    minWidth: '30em',
  };

  return (
    <Card
      style={{
        marginBottom: full ? undefined : '1rem',
        height: full ? '100vh' : '20em',
        ...borderStyle,
      }}
    >
      <CardContent>
        <Typography variant="h5" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            {pretty}
            <SSIDDisplay ssid={stationSsid} hashedWpaKey={hashedWpaKey} />
            {enableStaging && hasStagedChange(station) && (
              <>
                <span style={{ userSelect: 'none' }}> → </span>
                <SSIDDisplay ssid={stagedChanges[station]?.ssid} hashedWpaKey={stagedChanges[station]?.wpaKey} />
              </>
            )}
          </Box>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            {/** APPLY ALL STAGED CHANGES BUTTON */}
            {enableStaging && Object.values(stagedChanges).some(change => change !== null) && (
              <Tooltip
                title={`Apply all staged changes (${
                  Object.values(stagedChanges).filter(change => change !== null).length
                } stations)`}
              >
                <IconButton
                  onClick={handleApplyAllStagedChanges}
                  size="small"
                  sx={{
                    color: '#e65100',
                    backgroundColor: '#fff3e0',
                    '&:hover': {
                      backgroundColor: '#ffb74d',
                      color: '#bf360c',
                    },
                  }}
                >
                  <PlayArrowIcon />
                </IconButton>
              </Tooltip>
            )}
            {/** CLEAR BUTTON */}
            {(stationSsid || (enableStaging && hasStagedChange(station))) && (
              <Tooltip title="Clear station configuration">
                <IconButton
                  onClick={handleClearStation}
                  size="small"
                  sx={{
                    color: 'text.secondary',
                    '&:hover': {
                      color: 'error.main',
                      backgroundColor: 'error.light',
                    },
                  }}
                >
                  <ClearIcon />
                </IconButton>
              </Tooltip>
            )}
            {/** SETTINGS BUTTON */}
            <IconButton onClick={handleOpen} size="small">
              <SettingsIcon />
            </IconButton>
          </Box>
        </Typography>

        {stationSsid || (enableStaging && hasStagedChange(station)) ? (
          <Grid container>
            {/* SSID and Passphrase with current/staged values */}
            <Grid size={{ xs: 12 }}>
              {/* Connection Details */}
              {stationSsid && isLinked ? (
                <>
                  <DataUnit name="MAC Address" value={macAddress!} />
                  <DataUnit name="Data Age" value={dataAgeMs!} unit="ms" />
                  <DataUnit name="Signal" value={signalDbm!} unit="dBm" cols={3} />
                  <DataUnit name="Noise" value={noiseDbm!} unit="dBm" cols={3} />
                  <DataUnit name="SNR" value={signalNoiseRatio!} unit="dB" cols={3} />
                  <DataUnit name="RX Rate" value={rxRateMbps!} unit="Mbps" />
                  <DataUnit name="TX Rate" value={txRateMbps!} unit="Mbps" />
                  <DataUnit name="RX Packets" value={rxPackets!} />
                  <DataUnit name="TX Packets" value={txPackets!} />
                  <DataUnit name="RX Bytes" value={rxBytes!} />
                  <DataUnit name="TX Bytes" value={txBytes!} />
                  <DataUnit name="Bandwidth Used" value={bandwidthUsedMbps!} unit="Mbps" />
                  <DataUnit name="Connection Quality" value={connectionQuality!} />
                </>
              ) : stationSsid ? (
                <Grid size={{ xs: 12, md: 6 }}>
                  <Typography noWrap style={{ fontStyle: 'italic' }}>
                    not linked
                  </Typography>
                </Grid>
              ) : null}
            </Grid>
          </Grid>
        ) : (
          <Typography noWrap style={{ fontStyle: 'italic' }}>
            not configured
          </Typography>
        )}
      </CardContent>

      <Dialog
        open={open}
        onClose={handleClose}
        slotProps={{
          transition: {
            onEntered: () => {
              ssidInputRef.current?.focus();
              ssidInputRef.current?.select();
            },
          },
        }}
      >
        <form
          style={borderStyle}
          onSubmit={e => {
            e.preventDefault();
            if (isSaveEnabled) handleSave(false); // Save or Clear on submit
          }}
          onKeyDown={e => {
            if (enableStaging && e.key === 'Enter' && e.shiftKey) {
              // Shift+Enter: Stage
              if (isSaveEnabled) handleSave(true);
              e.preventDefault(); // Prevent form submit
            }
          }}
        >
          <DialogTitle>Configure {pretty} Wi-Fi</DialogTitle>
          <DialogContent>
            <TextField
              label="SSID"
              value={ssid}
              onChange={e => setSsid(e.target.value)}
              fullWidth
              style={modalStyle}
              margin="normal"
              inputRef={ssidInputRef} // Attach the ref here
              helperText={
                isSSIDEmpty
                  ? 'Empty SSID will clear the configuration.'
                  : !ssidRegex.test(ssid)
                    ? 'SSID must be alphanumeric and up to 14 characters.'
                    : !ssidFormatRegex.test(ssid)
                      ? 'SSID must start with 1-6 digits and optionally include a hyphen and more characters.'
                      : ''
              }
              error={!isSSIDEmpty && (!ssidRegex.test(ssid) || !ssidFormatRegex.test(ssid))}
            />
            <TextField
              label="Passphrase"
              value={passphrase}
              onChange={e => setPassphrase(e.target.value)}
              fullWidth
              style={modalStyle}
              disabled={isSSIDEmpty}
              margin="normal"
              helperText={
                !isSSIDEmpty && !passphraseRegex.test(passphrase)
                  ? 'Passphrase must be alphanumeric and between 8-16 characters.'
                  : ''
              }
              error={!isSSIDEmpty && !passphraseRegex.test(passphrase)}
            />

            {recentSettings.length > 0 && (
              <Box
                sx={{
                  marginTop: 2,
                  padding: 2,
                  backgroundColor: 'background.paper',
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                }}
              >
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 1 }}>
                  <Typography variant="subtitle2" sx={{ color: 'text.secondary' }}>
                    Recent Configurations
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <Tooltip title={showPassphrases ? 'Hide passphrases' : 'Show passphrases'}>
                      <IconButton
                        size="small"
                        onClick={() => setShowPassphrases(!showPassphrases)}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': {
                            color: 'text.primary',
                          },
                        }}
                      >
                        {showPassphrases ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                      </IconButton>
                    </Tooltip>
                    <Tooltip title="Clear all recent configurations">
                      <IconButton
                        size="small"
                        onClick={clearSettings}
                        sx={{
                          color: 'text.secondary',
                          '&:hover': {
                            color: 'error.main',
                          },
                        }}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </Box>
                <Table size="small" sx={{ tableLayout: 'fixed' }}>
                  <TableBody>
                    {recentSettings.map(setting => (
                      <TableRow
                        key={`${setting.ssid}-${setting.createdAt}`}
                        hover
                        onClick={() => handleApplySetting(setting)}
                        sx={{
                          cursor: 'pointer',
                          position: 'relative',
                          '&:hover': {
                            backgroundColor: 'action.hover',
                            '& .delete-button': {
                              opacity: 1,
                            },
                          },
                        }}
                      >
                        <TableCell
                          sx={{
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            padding: '4px 8px',
                            width: '25%',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {setting.ssid}
                        </TableCell>
                        <TableCell
                          sx={{
                            fontFamily: 'monospace',
                            fontSize: '0.75rem',
                            padding: '4px 8px',
                            width: '25%',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {showPassphrases ? setting.wpaKey : '••••••••'}
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: '0.75rem',
                            padding: '4px 8px',
                            width: '25%',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <TimeDisplay timestamp={setting.lastUsedAt} />
                        </TableCell>
                        <TableCell
                          sx={{
                            fontSize: '0.75rem',
                            padding: '4px 8px',
                            width: '25%',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <TimeDisplay timestamp={setting.createdAt} />
                        </TableCell>
                        {/* Floating delete button */}
                        <IconButton
                          className="delete-button"
                          size="small"
                          onClick={e => handleRemoveSetting(e, setting)}
                          sx={{
                            position: 'absolute',
                            right: 4,
                            top: '50%',
                            transform: 'translateY(-50%)',
                            opacity: 0,
                            transition: 'opacity 0.2s',
                            backgroundColor: 'background.paper',
                            boxShadow: 1,
                            zIndex: 1,
                            '&:hover': {
                              backgroundColor: 'error.light',
                              color: 'error.contrastText',
                            },
                          }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} color="secondary">
              Cancel
            </Button>
            {enableStaging && (
              <Button onClick={() => isSaveEnabled && handleSave(true)} color="secondary" disabled={!isSaveEnabled}>
                Stage
              </Button>
            )}
            <Button type="submit" color="primary" disabled={!isSaveEnabled}>
              {isSSIDEmpty ? 'Clear' : 'Save'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Card>
  );
}

export default StationStatus;

function SSIDDisplay({ ssid, hashedWpaKey }: { ssid?: string; hashedWpaKey?: string }) {
  if (!ssid) {
    return null;
  }

  return (
    <>
      {ssid && <SecureStatus secure={!!hashedWpaKey} />}
      <Tooltip title="SSID">
        <Typography variant="h6" sx={{ color: 'text.secondary', fontFamily: 'monospace' }}>
          {ssid}
        </Typography>
      </Tooltip>
    </>
  );
}

function SecureStatus({ secure }: { secure: boolean }) {
  return (
    <Tooltip title={secure ? 'passphrase set' : 'no passphrase'}>
      <span style={{ userSelect: 'none', fontSize: '0.75em' }}>
        <>{secure ? '🔒' : '🔓'}</>
      </span>
    </Tooltip>
  );
}

function DataUnit({
  name,
  value,
  unit,
  cols = 2,
}: {
  name: string;
  value: number | string;
  unit?: string;
  cols?: number;
}) {
  return (
    <Grid size={{ xs: 12, md: 12 / cols }}>
      <Typography noWrap>
        {name}: {value}
        {unit ? ` ${unit}` : ''}
      </Typography>
    </Grid>
  );
}
