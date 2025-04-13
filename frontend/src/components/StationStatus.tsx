import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import { StationName } from '../../../src/types';
import { useLatest } from '../hooks/useBackend';
import { prettyStationName } from '../utils';

export function StationStatus({ station }: { station: StationName }) {
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

  const { ssid, isLinked } = stationDetails;

  return (
    <Card style={{ marginBottom: '1rem' }}>
      <CardContent>
        <Typography variant="h6">{prettyStationName(station)}</Typography>
        <Typography>Status: {isLinked}</Typography>
        <Typography>SSID: {ssid}</Typography>
      </CardContent>
    </Card>
  );
}

export default StationStatus;
