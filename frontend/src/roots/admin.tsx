import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';
import ErrorBoundary from '../components/ErrorBoundary';
import { AdminPage } from '../components/AdminPage';
import { StatusBar } from '../components/StatusBar';

const theme = createTheme({ colorSchemes: { dark: true } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <StatusBar />
        <AdminPage />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
