import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import { StationNameList, StationName } from '../../../src/types';
import StationStatus from './StationStatus';

/** Render a group of station slots (first half or second half). */
export function SlotGroup({ slots }: { slots: readonly StationName[] }) {
  return (
    <Grid size={{ xs: 12, md: 6 }}>
      {slots.map(station => (
        <StationStatus key={station} station={station} />
      ))}
    </Grid>
  );
}

/** @deprecated Replaced by SlotGroup — alliance is now a match concept, not a station concept. */
export function AllianceStatus({ alliance }: { alliance: 'red' | 'blue'; reverse?: boolean }) {
  const slots = alliance === 'red' ? StationNameList.slice(0, 3) : StationNameList.slice(3);
  return (
    <Grid size={{ xs: 12, md: 6 }}>
      <Typography variant="h4" gutterBottom>
        Slots {alliance === 'red' ? '1–3' : '4–6'}
      </Typography>
      {slots.map(station => (
        <StationStatus key={station} station={station} />
      ))}
    </Grid>
  );
}
