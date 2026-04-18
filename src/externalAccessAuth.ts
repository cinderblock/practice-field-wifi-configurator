import { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';

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

/** Timing-safe string comparison that handles different lengths. */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
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
 *   Validates the URL token against EXTERNAL_ACCESS_TOKEN, sets an HttpOnly
 *   cookie (365 days), and redirects to /. Share this URL with trusted users
 *   to grant them access from outside the local network.
 *
 * GET /api/auth/check
 *   Validates the pfms_access cookie. Returns 200 if valid, 401 if not.
 *   Used by Caddy's forward_auth directive to gate external access — Caddy
 *   sends a subrequest here before deciding whether to serve the internal UI
 *   or the public-only page.
 */
export function handleExternalAccessAuth(req: IncomingMessage, res: ServerResponse, accessToken: string): boolean {
  const url = req.url;
  if (!url) return false;

  // ── Token auth endpoint: validate token and set cookie ───────────────
  if (url.startsWith('/admin/auth/')) {
    const providedToken = decodeURIComponent(url.slice('/admin/auth/'.length).split('?')[0]);

    if (!safeCompare(providedToken, accessToken)) {
      res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end('Forbidden');
      return true;
    }

    res.writeHead(302, {
      'Set-Cookie': buildCookie(accessToken),
      Location: '/',
      'Cache-Control': 'no-store',
    });
    res.end();
    return true;
  }

  // ── Cookie validation endpoint (Caddy forward_auth) ──────────────────
  if (url === '/api/auth/check' || url.startsWith('/api/auth/check?')) {
    const cookieValue = getCookieValue(req.headers.cookie, COOKIE_NAME);

    if (cookieValue && safeCompare(cookieValue, accessToken)) {
      // Refresh the cookie — Caddy relays this Set-Cookie to the client via
      // handle_response, so the 365-day expiration rolls forward on every page load.
      res.writeHead(200, { 'Set-Cookie': buildCookie(accessToken), 'Cache-Control': 'no-store' });
    } else {
      res.writeHead(401, { 'Cache-Control': 'no-store' });
    }
    res.end();
    return true;
  }

  return false;
}
