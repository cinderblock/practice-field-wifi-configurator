import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import { Alliance } from '../../../src/types';
import { capitalizeFirstLetter } from '../../../src/utils';
import StationStatus from './StationStatus';

export function AllianceStatus({ alliance, reverse }: { alliance: Alliance; reverse?: boolean }) {
  return (
    <Grid size={{ xs: 12, md: 6 }}>
      <Typography variant="h4" gutterBottom>
        {capitalizeFirstLetter(alliance)} Alliance Stations
      </Typography>
      <StationStatus station={reverse ? `${alliance}3` : `${alliance}1`} />
      <StationStatus station={`${alliance}2`} />
      <StationStatus station={reverse ? `${alliance}1` : `${alliance}3`} />
    </Grid>
  );
}
