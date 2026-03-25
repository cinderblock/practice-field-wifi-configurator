import { createRoot } from 'react-dom/client';
import { ControlPage } from '../components/ControlPage';
import { WrapAll } from './wrap';

// Extract the SSID from the URL path: /control/<ssid>
const pathParts = window.location.pathname.split('/');
const ssid = decodeURIComponent(pathParts[2] ?? '');

if (!ssid) {
  // No SSID in the URL — redirect to home
  window.location.href = '/';
} else {
  createRoot(document.getElementById('root')!).render(
    <WrapAll>
      <ControlPage ssid={ssid} />
    </WrapAll>,
  );
}
