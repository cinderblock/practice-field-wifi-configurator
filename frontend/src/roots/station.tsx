import React from 'react';
import ReactDOM from 'react-dom/client';
import { StationPage } from '../components/StationPage';
import { StationName, StationNameRegex } from '../../../src/types';

// Get station ID from URL path (e.g., /red1 -> red1)
const stationId = window.location.pathname.slice(1) as StationName;

if (!StationNameRegex.test(stationId)) {
  throw new Error('Invalid station ID');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StationPage stationId={stationId} />
  </React.StrictMode>,
);
