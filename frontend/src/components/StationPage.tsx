import React, { useState } from 'react';
import { Container, Typography, Button, TextField } from '@mui/material';
import { useLatest, sendNewConfig } from '../hooks/useBackend';
import { StationName } from '../../../src/types';

interface StationPageProps {
  stationId: StationName;
}

export const StationPage: React.FC<StationPageProps> = ({ stationId }) => {
  const latest = useLatest();
  const [ssid, setSsid] = useState('');
  const [wpaKey, setWpaKey] = useState('');

  const handleSubmit = () => {
    sendNewConfig(stationId, ssid, wpaKey);
  };

  return (
    <Container>
      <Typography variant="h2" gutterBottom>
        Station: {stationId}
      </Typography>
      <Typography variant="body1" gutterBottom>
        Latest Update:
      </Typography>
      <Typography variant="body2">{latest ? JSON.stringify(latest) : 'No updates available'}</Typography>
      <TextField label="SSID" value={ssid} onChange={e => setSsid(e.target.value)} fullWidth margin="normal" />
      <TextField
        label="WPA Key"
        value={wpaKey}
        onChange={e => setWpaKey(e.target.value)}
        fullWidth
        margin="normal"
        type="password"
      />
      <Button variant="contained" color="primary" onClick={handleSubmit}>
        Update Configuration
      </Button>
    </Container>
  );
};
