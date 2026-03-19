import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { ScoreboardPage, initCastSender } from '../components/ScoreboardPage';

// Initialize Cast SDK before React renders — the SDK calls __onGCastApiAvailable
// synchronously after its script loads, which happens before useEffect runs.
initCastSender();

const theme = createTheme({
  colorSchemes: { dark: true },
  palette: { mode: 'dark' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        <ScoreboardPage />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
