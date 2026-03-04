import { StrictMode, useEffect, useRef, useState } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid, Box } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { useHistory, useLatest, serverToBrowserTime } from '../hooks/useBackend.js';
import GithubCorner from '../components/GithubCorner';
import { StatusBar } from '../components/StatusBar';

const EstimatedReconfigurationTime = 35; // seconds

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
  const isNetworkFault = latest !== undefined && !isConnected; // Backend is up, radio not responding

  // Track elapsed seconds since configuration started, using a stable browser-local
  // anchor so the countdown doesn't jitter as the server time offset shifts.
  // The ref ensures we compute startBrowserTime exactly once per reconfiguration
  // cycle — surviving brief status flickers (radio momentarily reporting ACTIVE
  // mid-reconfig) and timeOffset drift between effect re-runs.
  const [elapsedSec, setElapsedSec] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  // Only clear the anchor when the radio is definitively done configuring
  // (connected with a non-CONFIGURING status), not on transient flickers.
  const isDefinitelyDone = isConnected && !isConfiguring;
  useEffect(() => {
    if (isDefinitelyDone) {
      startTimeRef.current = null;
      setElapsedSec(0);
    }
  }, [isDefinitelyDone]);

  useEffect(() => {
    if (!isConfiguring || !lastActive) return;

    // Compute the browser-local anchor only once per reconfiguration cycle
    if (startTimeRef.current === null) {
      startTimeRef.current = serverToBrowserTime(lastActive);
    }

    const startBrowserTime = startTimeRef.current;
    const update = () => setElapsedSec((Date.now() - startBrowserTime) / 1000);
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isConfiguring, lastActive]);

  // Enable dark mode for the entire app (system default)
  const theme = createTheme({ colorSchemes: { dark: true } });

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <StatusBar />
          <Backdrop open={isConfiguring || !isConnected} style={{ zIndex: 9999 }}>
            <Grid container direction="column" justifyContent="center" alignItems="center" style={{ height: '100%' }}>
              <Typography variant="h2" style={{ marginBottom: '1rem', userSelect: 'none' }}>
                {isLoading
                  ? 'Loading'
                  : isNetworkFault
                    ? 'Network Fault. Field Radio Unreachable'
                    : isConnected
                      ? 'Reconfiguration in progress'
                      : 'Radio connecting'}
                ...
              </Typography>
              <CircularProgress style={{ width: '25vw', height: '25vw' }} />
              <Typography style={{ marginTop: '1rem', userSelect: 'none' }}>
                {!latest
                  ? 'Connecting to backend...'
                  : isNetworkFault
                    ? 'The field radio is not responding. Check power, cabling, and IP configuration.'
                    : !isLoading &&
                      isConnected &&
                      lastActive &&
                      (elapsedSec < EstimatedReconfigurationTime
                        ? `Estimated time remaining: ${(EstimatedReconfigurationTime - elapsedSec).toFixed(1)} seconds`
                        : 'Reconfiguration taking longer than expected...')}
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
