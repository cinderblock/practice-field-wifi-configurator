import { Typography } from '@mui/material';
import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';
import { TeamChecksModal } from './TeamChecksModal';

export function StationPage({ station }: { station: StationName }) {
  return (
    <>
      <Typography variant="h4" gutterBottom>
        Driver Station Status
      </Typography>
      <TeamChecksModal station={station} />
      <StationStatus full station={station} />
    </>
  );
}
