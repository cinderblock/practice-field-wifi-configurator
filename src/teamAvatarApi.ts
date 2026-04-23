import { IncomingMessage, ServerResponse } from 'http';
import { getTeamAvatar } from './teamAvatarCache.js';

function json(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

/**
 * HTTP handler for team avatar images:
 * - GET /api/team-avatar/:teamNumber → PNG image (or 404)
 */
export function handleTeamAvatarRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const prefix = '/api/team-avatar/';
  const url = req.url?.split('?')[0];
  if (!url?.startsWith(prefix)) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const teamStr = url.slice(prefix.length);
  const teamNumber = parseInt(teamStr, 10);

  if (isNaN(teamNumber) || teamNumber <= 0 || teamNumber > 99999) {
    json(res, 400, { error: 'Invalid team number' });
    return true;
  }

  getTeamAvatar(teamNumber)
    .then(avatar => {
      if (!avatar) {
        json(res, 404, { error: 'Avatar not found' }, { 'Cache-Control': 'public, max-age=3600' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': avatar.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(avatar);
    })
    .catch(err => {
      json(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
    });

  return true;
}
