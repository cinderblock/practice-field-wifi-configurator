import { StrictMode } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid, Box } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useHistory, useLatest } from '../hooks/useBackend.js';
import GithubCorner from '../components/GithubCorner';

const EstimatedReconfigurationTime = 32; // seconds

export function WrapAll({ children }: { children: React.ReactNode }) {
  const latest = useLatest();
  const lastActive =
    useHistory()
      .reverse()
      .find(h => h.radioUpdate?.status === 'ACTIVE')?.timestamp || null;

  const isLoading = latest === undefined || latest.radioUpdate === undefined;
  const { status } = latest?.radioUpdate || {};
  const isConfiguring = status === 'CONFIGURING';
  const isConnected = latest?.radioUpdate !== undefined;

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
                {isLoading ? 'Loading' : isConnected ? 'Reconfiguration in progress' : 'Radio connecting'}...
              </Typography>
              <CircularProgress style={{ width: '25vw', height: '25vw' }} />
              <Typography style={{ marginTop: '1rem', userSelect: 'none' }}>
                {!latest
                  ? 'Connecting to backend...'
                  : !isLoading &&
                    isConnected &&
                    lastActive &&
                    `Estimated time remaining:
                  ${(EstimatedReconfigurationTime - (latest.timestamp - lastActive) / 1000).toFixed(1)} seconds`}
              </Typography>
            </Grid>
          </Backdrop>
          <Box sx={{ my: 1 }} />
          {children}
          <GithubCorner href="https://github.com/cinderblock/practice-field-wifi-configurator" />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
