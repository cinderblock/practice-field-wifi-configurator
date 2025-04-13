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

export function StationStatus({ station }: { station: StationName }) {
  const [open, setOpen] = useState(false);
  const [ssid, setSsid] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const ssidInputRef = useRef<HTMLInputElement | null>(null);

  const latest = useLatest();

  if (!latest) {
    return <Typography>Loading...</Typography>;
  }

  const { stationStatuses, status } = latest.radioUpdate;

  if (status !== 'ACTIVE') {
    return <Typography>System is not active</Typography>;
  }

  const stationDetails = stationStatuses[station];

  if (!stationDetails) {
    return <Typography>Station {station} is not available</Typography>;
  }

  const { ssid: stationSsid, isLinked } = stationDetails;

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

  const isSaveDisabled: boolean = !/^[a-zA-Z0-9]{8,16}$/.test(passphrase) || !/^[a-zA-Z0-9-]{0,14}$/.test(ssid);
  const isSSIDEmpty = ssid === '';

  return (
    <Card style={{ marginBottom: '1rem' }}>
      <CardContent>
        <Typography variant="h6" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {prettyStationName(station)}
          <IconButton onClick={handleOpen} size="small">
            <SettingsIcon />
          </IconButton>
        </Typography>
        <Typography>Status: {isLinked}</Typography>
        <Typography>SSID: {stationSsid}</Typography>
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
        <DialogTitle>Configure SSID and Passphrase</DialogTitle>
        <DialogContent>
          <TextField
            label="SSID"
            value={ssid}
            onChange={e => setSsid(e.target.value)}
            fullWidth
            margin="normal"
            inputRef={ssidInputRef} // Attach the ref here
          />
          <TextField
            label="Passphrase"
            value={passphrase}
            onChange={e => setPassphrase(e.target.value)}
            fullWidth
            disabled={isSSIDEmpty}
            margin="normal"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleClose} color="secondary">
            Cancel
          </Button>
          <Button onClick={handleSave} color="primary" disabled={isSaveDisabled && !isSSIDEmpty}>
            {isSSIDEmpty ? 'Clear' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}

export default StationStatus;
