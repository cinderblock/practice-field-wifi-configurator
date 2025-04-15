import { StrictMode } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useHistory, useLatest } from '../hooks/useBackend.js';

export function WrapAll({ children }: { children: React.ReactNode }) {
  const latest = useLatest();
  const lastActive =
    useHistory()
      .reverse()
      .find(h => h.radioUpdate?.status === 'ACTIVE')?.timestamp || null;

  const estimatedReconfigurationTime = 31; // seconds

  if (!latest) {
    return <Typography>Loading...</Typography>;
  }

  const { status } = latest.radioUpdate || {};
  const isConfiguring = status === 'CONFIGURING';
  const isConnected = latest.radioUpdate !== undefined;

  // Enable dark mode for the entire app (system default)
  const theme = createTheme({ colorSchemes: { dark: true } });

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <Backdrop open={isConfiguring || !isConnected} style={{ zIndex: 9999 }}>
            <Grid container direction="column" justifyContent="center" alignItems="center" style={{ height: '100%' }}>
              <Typography variant="h2" style={{ marginBottom: '1rem', userSelect: 'none' }}>
                {isConnected ? 'Reconfiguration in progress' : 'Radio connecting'}...
              </Typography>
              <CircularProgress style={{ width: '25vw', height: '25vw' }} />
              {isConnected && lastActive && (
                <Typography variant="h3" style={{ marginTop: '1rem', userSelect: 'none' }}>
                  Estimated time remaining:{' '}
                  {(estimatedReconfigurationTime - (latest.timestamp - lastActive) / 1000).toFixed(1)} seconds
                </Typography>
              )}
            </Grid>
          </Backdrop>
          {children}
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
