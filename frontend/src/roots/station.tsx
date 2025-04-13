import React from 'react';
import ReactDOM from 'react-dom/client';
import { StationPage } from '../components/StationPage';
import { StationName, StationNameRegex } from '../../../src/types';
import ErrorBoundary from '../components/ErrorBoundary';

// Get station ID from URL path (e.g., /red1 -> red1)
const station = window.location.pathname.slice(1) as StationName;

if (!StationNameRegex.test(station)) {
  throw new Error('Invalid station ID');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StationPage station={station} />
    </ErrorBoundary>
  </React.StrictMode>,
);
