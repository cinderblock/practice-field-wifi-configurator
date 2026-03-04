import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import { useLatest } from '../hooks/useBackend';

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
        </CardContent>
      </Card>
    </>
  );
}
