import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import { StationName } from '../../../src/types';
import StationStatus from './StationStatus';

export function StationPage({ station }: { station: StationName }) {
  return (
    <Container>
      <Typography variant="h2" gutterBottom>
        Station Status
      </Typography>
      <StationStatus station={station} />
    </Container>
  );
}
