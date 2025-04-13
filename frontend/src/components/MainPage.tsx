import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import { AllianceStatus } from './AllianceStatus';
import { SystemInfo } from './SystemInfo';

export function MainPage() {
  return (
    <Container>
      <Typography variant="h2" gutterBottom>
        Practice Field WiFi Status
      </Typography>
      <Grid container spacing={2}>
        <AllianceStatus alliance="red" />
        <AllianceStatus alliance="blue" />
        <Grid size={{ xs: 12 }}>
          <SystemInfo />
        </Grid>
      </Grid>
    </Container>
  );
}
