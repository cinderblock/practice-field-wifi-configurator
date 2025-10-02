import { Typography } from '@mui/material';
import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';

export function StationPage({ station }: { station: StationName }) {
  return (
    <>
      <Typography variant="h4" gutterBottom>
        Driver Station Status
      </Typography>
      <StationStatus full station={station} />
    </>
  );
}
