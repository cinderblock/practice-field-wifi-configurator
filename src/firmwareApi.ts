import { IncomingMessage, ServerResponse } from 'http';
import type { FirmwareStore } from './firmwareStore.js';

const MAX_FIRMWARE_SIZE = 100 * 1024 * 1024; // 100 MB

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBinaryBody(req: IncomingMessage, maxSize: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * HTTP handler for firmware management API:
 * - GET  /api/firmware          → list firmware entries and their status
 * - POST /api/firmware/upload   → upload a firmware file manually
 * - POST /api/firmware/download → trigger background download of known firmware
 */
export function handleFirmwareRequest(req: IncomingMessage, res: ServerResponse, store: FirmwareStore): boolean {
  const url = req.url;
  if (!url?.startsWith('/api/firmware')) return false;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (url === '/api/firmware' && req.method === 'GET') {
    json(res, 200, { entries: store.getEntries() });
    return true;
  }

  if (url === '/api/firmware/upload' && req.method === 'POST') {
    // Expect multipart or raw binary with query params for metadata
    // Simple approach: raw binary body with checksum/version/upgradeFrom in query string
    const parsed = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
    const checksum = parsed.searchParams.get('checksum');
    const version = parsed.searchParams.get('version');
    const upgradeFrom = parsed.searchParams.get('upgradeFrom') as 'from12x' | 'pre12x' | null;

    if (!checksum || !version || !upgradeFrom || !['from12x', 'pre12x'].includes(upgradeFrom)) {
      json(res, 400, { error: 'Missing required query params: checksum, version, upgradeFrom (from12x|pre12x)' });
      return true;
    }

    readBinaryBody(req, MAX_FIRMWARE_SIZE)
      .then(data => {
        const entry = store.addManualFirmware(data, checksum, version, upgradeFrom);
        json(res, 200, { message: 'Firmware uploaded', entry });
      })
      .catch(err => {
        json(res, 500, { error: err.message });
      });
    return true;
  }

  if (url === '/api/firmware/download' && req.method === 'POST') {
    store.startBackgroundDownloads();
    json(res, 202, { message: 'Background download started' });
    return true;
  }

  return false;
}
