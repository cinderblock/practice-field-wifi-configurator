import { StrictMode } from 'react';
import ErrorBoundary from '../components/ErrorBoundary.js';
import { createTheme, CssBaseline, ThemeProvider } from '@mui/material';

export function WrapAll({ children }: { children: React.ReactNode }) {
  // Enable dark mode for the entire app (system default)
  const theme = createTheme({ colorSchemes: { dark: true } });

  return (
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          {children}
        </ThemeProvider>
      </ErrorBoundary>
    </StrictMode>
  );
}
