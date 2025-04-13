import ReactDOM from 'react-dom/client';
import { StationPage } from '../components/StationPage';
import { StationName, StationNameRegex } from '../../../src/types';
import { WrapAll } from './wrap';

// Get station ID from URL path (e.g., /red1 -> red1)
const station = window.location.pathname.slice(1) as StationName;

if (!StationNameRegex.test(station)) {
  throw new Error('Invalid station ID');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <WrapAll>
    <StationPage station={station} />
  </WrapAll>,
);
