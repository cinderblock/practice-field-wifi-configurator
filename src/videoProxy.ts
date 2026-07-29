import { IncomingMessage, ServerResponse } from 'http';

/**
 * Same-origin proxy for WHEP (WebRTC) signaling, used by the scoreboard's
 * video view. The scoreboard page is served over HTTPS, so it cannot talk to
 * the field's plain-HTTP MediaMTX server directly (mixed content); instead the
 * browser signals via /api/video-proxy/... on its own origin and this forwards
 * to the server named by VIDEO_PROXY_TARGET (e.g. http://10.255.0.20:8889).
 *
 * Only signaling passes through here — the WebRTC media itself flows directly
 * between the browser and the stream server over UDP (DTLS-encrypted), so the
 * proxy carries a few small SDP exchanges per viewer, not video.
 *
 * The target comes from configuration, never from the request, so this is not
 * an open proxy — and the setup UI only accepts private/loopback addresses for
 * it. Externally, Caddy's forward_auth already gates /api/* paths to
 * cookie-authenticated clients.
 */

const PREFIX = '/api/video-proxy/';

/**
 * Resolves the stream server. Injected by index.ts so a target saved in the
 * setup UI wins over the environment — without this the wizard accepted a
 * value, showed the check pass, and the proxy still answered 503.
 */
export type VideoProxyTargetResolver = () => string | undefined;

let resolveTarget: VideoProxyTargetResolver = () => process.env.VIDEO_PROXY_TARGET;

export function setVideoProxyTargetResolver(resolver: VideoProxyTargetResolver): void {
  resolveTarget = resolver;
}

export function handleVideoProxy(req: IncomingMessage, res: ServerResponse): boolean {
  if (!req.url?.startsWith(PREFIX)) return false;

  const target = resolveTarget();
  if (!target) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'VIDEO_PROXY_TARGET is not configured on the server' }));
    return true;
  }

  void proxyRequest(req, res, `${target.replace(/\/+$/, '')}/${req.url.slice(PREFIX.length)}`);
  return true;
}

async function proxyRequest(req: IncomingMessage, res: ServerResponse, targetUrl: string) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);

    const headers: Record<string, string> = {};
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (req.headers['if-match']) headers['If-Match'] = String(req.headers['if-match']);

    const method = req.method ?? 'GET';
    const upstream = await fetch(targetUrl, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : Buffer.concat(chunks),
    });

    const out: Record<string, string> = {};
    for (const name of ['Content-Type', 'ETag', 'Link', 'Accept-Patch']) {
      const value = upstream.headers.get(name);
      if (value) out[name] = value;
    }
    // The WHEP session resource (for PATCH/DELETE) must stay under the proxy
    const location = upstream.headers.get('Location');
    if (location) out['Location'] = location.startsWith('/') ? `/api/video-proxy${location}` : location;

    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, out);
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `video proxy: ${(err as Error).message}` }));
  }
}
