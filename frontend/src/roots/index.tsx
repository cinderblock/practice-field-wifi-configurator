import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { MainPage } from '../components/MainPage';
import ErrorBoundary from '../components/ErrorBoundary';

if (window.location.pathname !== '/') {
  window.location.replace('/');
}

const theme = createTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <MainPage />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
);
