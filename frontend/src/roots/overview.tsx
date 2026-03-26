import { createRoot } from 'react-dom/client';
import { AllianceStatus } from '../components/AllianceStatus';
import { WrapAll } from './wrap';
import Grid from '@mui/material/Grid';
import Container from '@mui/material/Container';

createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <Container maxWidth="xl" sx={{ py: 2 }}>
      <Grid container spacing={2}>
        <AllianceStatus alliance="red" />
        <AllianceStatus alliance="blue" reverse />
      </Grid>
    </Container>
  </WrapAll>,
);
