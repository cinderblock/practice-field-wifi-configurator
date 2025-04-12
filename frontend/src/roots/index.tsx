import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles/index.css';
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material';
import { MainPage } from '../components/MainPage';

if (window.location.pathname !== '/') {
  window.location.replace('/');
}

const theme = createTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MainPage />
    </ThemeProvider>
  </StrictMode>,
);
