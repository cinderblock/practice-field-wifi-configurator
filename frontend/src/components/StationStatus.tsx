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
import { StationName } from '../../../src/types';
import { useLatest, sendNewConfig } from '../hooks/useBackend';
import { prettyStationName } from '../utils';
import { Grid } from '@mui/material';

export function StationStatus({ station, full }: { station: StationName; full?: boolean }) {
  const [open, setOpen] = useState(false);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const ssidInputRef = useRef<HTMLInputElement | null>(null);

  const latest = useLatest();

  if (!latest) {
    return <Typography>Loading...</Typography>;
  }

  const {
    ssid: stationSsid,
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
  } = latest.radioUpdate.stationStatuses[station] || {};

  const handleOpen = () => {
    setSsid(stationSsid || '');
    setPassphrase('');
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
  };

  const handleSave = () => {
    sendNewConfig(station, ssid, passphrase);
    setOpen(false);
  };

  const ssidRegex = /^[a-zA-Z0-9-]{0,14}$/;
  const ssidFormatRegex = /^\d{1,6}(?:-.*)?$/; // FIRST SSID format
  const passphraseRegex = /^[a-zA-Z0-9]{8,16}$/;

  const isSaveDisabled: boolean =
    !passphraseRegex.test(passphrase) || !ssidRegex.test(ssid) || !ssidFormatRegex.test(ssid);
  const isSSIDEmpty = ssid === '';

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
        <Typography variant="h6" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {pretty}
          <IconButton onClick={handleOpen} size="small">
            <SettingsIcon />
          </IconButton>
        </Typography>
        {stationSsid ? (
          <Grid container style={{ marginTop: '1rem' }}>
            <DataUnit name="SSID" value={stationSsid} />
            <DataUnit name="Passphrase" value={passphrase ? '********' : 'not set'} />
            {/* TODO: ability to test if user knows wpakey */}
            {isLinked ? (
              <>
                <DataUnit name="MAC Address" value={macAddress!} />
                <DataUnit name="Data Age" value={dataAgeMs!} unit="ms" />
                <DataUnit name="Signal" value={signalDbm!} unit="dBm" cols={3} />
                <DataUnit name="Noise" value={noiseDbm!} unit="dBm" cols={3} />
                <DataUnit name="SNR" value={signalNoiseRatio!} unit="dB" cols={3} />
                <DataUnit name="RX Rate" value={rxRateMbps!} unit="Mbps" />
                <DataUnit name="TX Rate" value={txRateMbps!} unit="Mbps" />
                <DataUnit name="RX" value={rxPackets!} unit="Packets" />
                <DataUnit name="TX" value={txPackets!} unit="Packets" />
                <DataUnit name="RX" value={rxBytes!} unit="Bytes" />
                <DataUnit name="TX" value={txBytes!} unit="Bytes" />
                <DataUnit name="Bandwidth Used" value={bandwidthUsedMbps!} unit="Mbps" />
                <DataUnit name="Connection Quality" value={connectionQuality!} />
              </>
            ) : (
              <Grid size={{ xs: 12, md: 6 }}>
                <Typography noWrap style={{ fontStyle: 'italic' }}>
                  not linked
                </Typography>
              </Grid>
            )}
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
            if (!isSaveDisabled) handleSave();
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
          </DialogContent>
          <DialogActions>
            <Button onClick={handleClose} color="secondary">
              Cancel
            </Button>
            <Button type="submit" color="primary" disabled={isSaveDisabled}>
              {isSSIDEmpty ? 'Clear' : 'Save'}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </Card>
  );
}

export default StationStatus;

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
