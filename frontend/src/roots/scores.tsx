import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { ScoreboardPage } from '../components/ScoreboardPage';

const theme = createTheme({
  colorSchemes: { dark: true },
  palette: { mode: 'dark' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme} defaultMode="dark">
        <CssBaseline />
        {/* Match audio is mounted inside ScoreboardPage so per-display mute can gate it */}
        <ScoreboardPage />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
