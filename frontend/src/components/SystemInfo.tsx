import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Box from '@mui/material/Box';
import { useLatest, useRadioMessages } from '../hooks/useBackend';

export function SystemInfo() {
  const latest = useLatest();

  const { status, version, channel, channelBandwidth } = latest?.radioUpdate || {};

  return (
    <>
      <Typography variant="h4" gutterBottom>
        System Information
      </Typography>
      <Card style={{ marginBottom: '1rem', borderLeft: '0.5em solid green' }}>
        <CardContent>
          <Typography>Status: {status}</Typography>
          <Typography>Version: {version}</Typography>
          <Typography>
            Channel: {channel} ({channelBandwidth})
          </Typography>
          <Box sx={{ fontFamily: 'Monospace' }}>
            {useRadioMessages().map(msg => (
              <Typography key={msg.date.valueOf()} variant="body2">
                {msg.message}
              </Typography>
            ))}
          </Box>
        </CardContent>
      </Card>
    </>
  );
}
