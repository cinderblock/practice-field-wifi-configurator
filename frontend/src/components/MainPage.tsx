import Container from '@mui/material/Container';
import Grid from '@mui/material/Grid';
import { AllianceStatus } from './AllianceStatus';
import { SystemInfo } from './SystemInfo';

export function MainPage() {
  return (
    <Container>
      <Grid container spacing={2}>
        <AllianceStatus alliance="red" />
        <AllianceStatus alliance="blue" reverse />
        <Grid size={{ xs: 12 }}>
          <SystemInfo />
        </Grid>
      </Grid>
    </Container>
  );
}
