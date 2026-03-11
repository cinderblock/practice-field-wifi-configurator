import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import { useLatest } from '../hooks/useBackend';

export function SystemInfo() {
  const latest = useLatest();

  const radioUpdate = latest?.radioUpdate;

  return (
    <>
      <Typography variant="h4" gutterBottom>
        System Information
      </Typography>
      {radioUpdate ? (
        <Card style={{ marginBottom: '1rem', borderLeft: '0.5em solid green' }}>
          <CardContent>
            <Typography>Status: {radioUpdate.status}</Typography>
            <Typography>Version: {radioUpdate.version}</Typography>
            <Typography>
              Channel: {radioUpdate.channel} ({radioUpdate.channelBandwidth})
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <Card style={{ marginBottom: '1rem', borderLeft: '0.5em solid orange' }}>
          <CardContent>
            <Typography color="warning.main">Unable to read radio — waiting for connection</Typography>
          </CardContent>
        </Card>
      )}
    </>
  );
}
