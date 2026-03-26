import { createRoot } from 'react-dom/client';
import { ControlPage } from '../components/ControlPage';
import { WrapAll } from './wrap';
import { clearTeamNumberCookie } from '../utils/cookies';

// Extract the team number from the URL path: /control/<teamNumber>
const pathParts = window.location.pathname.split('/');
const raw = decodeURIComponent(pathParts[2] ?? '');

// Parse team number (digits only)
const teamNumber = parseInt(raw, 10);

if (!raw) {
  // Nothing in URL — redirect to home
  window.location.href = '/';
} else if (isNaN(teamNumber) || teamNumber <= 0) {
  // Old URL format like /control/1234-Comp — extract digits and redirect
  const digits = raw.match(/^(\d+)/);
  if (digits) {
    window.location.href = `/control/${digits[1]}`;
  } else {
    // Can't parse at all — clear the cookie to prevent redirect loops and go home
    clearTeamNumberCookie();
    window.location.href = '/';
  }
} else {
  createRoot(document.getElementById('root')!).render(
    <WrapAll>
      <ControlPage teamNumber={teamNumber} />
    </WrapAll>,
  );
}
