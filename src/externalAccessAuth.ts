import { IncomingMessage, ServerResponse } from 'http';
import type { ExternalAccessStore } from './externalAccessStore.js';

const COOKIE_NAME = 'pfms_access';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60; // 365 days in seconds

/** Parse a named cookie value from a Cookie header string. */
function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const pair of cookieHeader.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function buildCookie(token: string): string {
  return [`${COOKIE_NAME}=${token}`, 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`, 'HttpOnly', 'Secure', 'SameSite=Lax'].join(
    '; ',
  );
}

/**
 * HTTP handler for external access authentication.
 *
 * Two endpoints:
 *
 * GET /admin/auth/<token>
 *   Validates the URL token against the ExternalAccessStore, sets an HttpOnly
 *   cookie (365 days), and redirects to /. Share this URL with trusted users
 *   to grant them access from outside the local network.
 *
 * GET /api/auth/check
 *   Validates the pfms_access cookie. Returns 200 + Set-Cookie (refreshed
 *   expiry) if valid, 401 if not. Used by Caddy's forward_auth to gate
 *   external access.
 */
export function handleExternalAccessAuth(
  req: IncomingMessage,
  res: ServerResponse,
  store: ExternalAccessStore,
): boolean {
  const url = req.url;
  if (!url) return false;

  // ── Token auth endpoint: validate token and set cookie ───────────────
  if (url.startsWith('/admin/auth/')) {
    const providedToken = decodeURIComponent(url.slice('/admin/auth/'.length).split('?')[0]);

    if (!store.validateToken(providedToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }

    res.writeHead(302, {
      'Set-Cookie': buildCookie(providedToken),
      Location: '/',
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  // ── Cookie validation endpoint (Caddy forward_auth) ──────────────────
  if (url === '/api/auth/check' || url.startsWith('/api/auth/check?')) {
    const cookieValue = getCookieValue(req.headers.cookie, COOKIE_NAME);

    if (cookieValue && store.validateToken(cookieValue)) {
      // Refresh the cookie — Caddy relays this Set-Cookie to the client via
      // handle_response, so the 365-day expiration rolls forward on every page load.
      res.writeHead(200, { 'Set-Cookie': buildCookie(cookieValue), 'Cache-Control': 'no-store' });
    } else {
      res.writeHead(401, { 'Cache-Control': 'no-store' });
    }
    res.end();
    return true;
  }

  return false;
}
