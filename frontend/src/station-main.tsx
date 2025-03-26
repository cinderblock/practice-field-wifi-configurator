import React from 'react';
import ReactDOM from 'react-dom/client';
import StationPage from './StationStatus';
import './App.css';

// Get station ID from URL path (e.g., /red1 -> red1)
const stationId = window.location.pathname.slice(1);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StationPage stationId={stationId} />
  </React.StrictMode>,
);
