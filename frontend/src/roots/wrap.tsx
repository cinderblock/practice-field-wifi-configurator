import { StrictMode, useEffect, useRef, useState } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider, Grid, Box } from '@mui/material';
import Backdrop from '@mui/material/Backdrop';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { useHistory, useLatest, serverToBrowserTime } from '../hooks/useBackend.js';
import GithubCorner from '../components/GithubCorner';
import { StatusBar } from '../components/StatusBar';

const EstimatedReconfigurationTime = 35; // seconds

export function WrapAll({ children }: { children: React.ReactNode }) {
  const latest = useLatest();
  // .slice() to avoid mutating the state array — .reverse() is in-place and
  // would cause lastActive to oscillate between the first and last ACTIVE
  // entries on alternating renders.
  const hist = useHistory();
  const lastActive =
    hist
      .slice()
      .reverse()
      .find(h => h.radioUpdate?.status === 'ACTIVE')?.timestamp || null;

  // When the page is refreshed mid-reconfiguration, the server's history window
  // (default 60 s) may have already pruned all ACTIVE entries.  Fall back to the
  // first CONFIGURING entry so the countdown still has an anchor point.
  const firstConfiguring = hist.find(h => h.radioUpdate?.status === 'CONFIGURING')?.timestamp || null;
  const reconfigStart = lastActive ?? firstConfiguring;

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
    if (!isConfiguring || !reconfigStart) return;

    // Compute the browser-local anchor only once per reconfiguration cycle
    if (startTimeRef.current === null) {
      startTimeRef.current = serverToBrowserTime(reconfigStart);
    }

    const startBrowserTime = startTimeRef.current;
    const update = () => setElapsedSec((Date.now() - startBrowserTime) / 1000);
    update();
    const interval = setInterval(update, 100);
    return () => clearInterval(interval);
  }, [isConfiguring, reconfigStart]);

  // Enable dark mode for the entire app (system default)
  const theme = createTheme({ colorSchemes: { dark: true } });

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
            <StatusBar />
            <Box sx={{ flex: 1, overflowY: 'auto' }}>
              {children}
            </Box>
          </Box>
          <Backdrop open={isConfiguring || !isConnected} sx={{ zIndex: 9999 }}>
            <Grid
              container
              direction="column"
              justifyContent="center"
              alignItems="center"
              sx={{ height: '100%', userSelect: 'none' }}
            >
              <Typography variant="h4" sx={{ mb: 2 }}>
                {isLoading
                  ? 'Loading...'
                  : isNetworkFault
                    ? 'Network Fault. Field Radio Unreachable...'
                    : isConnected
                      ? 'Reconfiguration in progress...'
                      : 'Radio connecting...'}
              </Typography>

              {/* Hero countdown or status message */}
              {!latest ? (
                <Typography variant="h5">Connecting to backend...</Typography>
              ) : isNetworkFault ? (
                <Typography variant="h6" sx={{ maxWidth: 500, textAlign: 'center' }}>
                  The field radio is not responding. Check power, cabling, and IP configuration.
                </Typography>
              ) : (
                isConnected &&
                reconfigStart && (
                  <>
                    <Typography
                      variant="h1"
                      sx={{ fontSize: '8rem', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
                    >
                      {Math.max(0, Math.ceil(EstimatedReconfigurationTime - elapsedSec))}
                    </Typography>
                    <Typography variant="h6" sx={{ mb: 3, minHeight: '2em' }}>
                      {elapsedSec < EstimatedReconfigurationTime
                        ? 'seconds remaining'
                        : 'Reconfiguration taking longer than expected...'}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={Math.min(100, (elapsedSec / EstimatedReconfigurationTime) * 100)}
                      sx={{ width: '100%', maxWidth: 500, height: 10, borderRadius: 5 }}
                    />
                  </>
                )
              )}
            </Grid>
          </Backdrop>
          <GithubCorner href="https://github.com/cinderblock/practice-field-wifi-configurator" />
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
