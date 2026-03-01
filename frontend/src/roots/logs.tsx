import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { LogsPage } from '../components/LogsPage';

const theme = createTheme({ colorSchemes: { dark: true } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <LogsPage />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
