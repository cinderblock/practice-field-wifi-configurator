import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import CIDRMatcher from 'cidr-matcher';
import { ApiKeyStore } from './apiKeyStore.js';
import { getRealClientIp, normalizeIp } from './utils.js';

/** Read the full request body as a string. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 64 * 1024; // 64 KB limit

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  });
  res.end(data);
}

/** Extract the API key from the request (header or query param). */
export function extractKey(req: IncomingMessage): string | undefined {
  // Check X-API-Key header
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey) return headerKey;

  // Check ?key= query parameter (convenient for tiny devices like ESP32/Arduino)
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const queryKey = url.searchParams.get('key');
    if (queryKey) return queryKey;
  } catch {
    // Malformed URL — no key
  }

  return undefined;
}

/**
 * Check authentication for an API request.
 * Returns true if the request is authorized.
 * On failure, records the device as pending for admin approval.
 */
export function checkAuth(req: IncomingMessage, apiKeyStore: ApiKeyStore, trustedProxyMatcher?: CIDRMatcher): boolean {
  // No active keys = open access (same as before when no env var was set)
  if (!apiKeyStore.hasAnyActiveKeys()) return true;

  const presentedKey = extractKey(req);
  if (presentedKey) {
    const sourceIp = normalizeIp(getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher));
    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    const entry = apiKeyStore.validateKey(presentedKey, sourceIp, userAgent);
    if (entry) return true;
  }

  // Auth failed — record as pending device for auto-discovery
  const sourceIp = normalizeIp(getRealClientIp(req.socket.remoteAddress, req.headers, trustedProxyMatcher));
  const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  apiKeyStore.recordPendingDevice(sourceIp, userAgent, presentedKey, req.url);

  return false;
}
