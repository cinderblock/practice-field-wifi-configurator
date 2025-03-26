import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';

const app = new Koa();
const router = new Router();

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://10.0.100.2';
const LOG_FRONTEND_REQUESTS = false;
const CACHE_TTL = 500; // Cache lifetime in milliseconds

// Cache implementation
interface CacheEntry {
  data: any;
  timestamp: number;
}

const cache: { [key: string]: CacheEntry } = {};

function getCachedData(key: string): any | null {
  const entry = cache[key];
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL) {
    delete cache[key];
    return null;
  }

  return entry.data;
}

function setCachedData(key: string, data: any): void {
  cache[key] = {
    data,
    timestamp: Date.now(),
  };
}

// Frontend request logging middleware
if (LOG_FRONTEND_REQUESTS) {
  app.use(async (ctx, next) => {
    console.log(`[${new Date().toISOString()}] ${ctx.method} ${ctx.url} <- ${ctx.ip}`);
    await next();
  });
}

// Helper function to log backend requests
async function loggedFetch(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  console.log(
    `[${new Date().toISOString()}] ${options?.method || 'GET'} ${url} -> ${response.status}${
      options?.body ? ' [' + options.body + ']' : ''
    }`,
  );
  return response;
}

// Middleware
app.use(bodyParser());

// API proxy routes
router.get('/api/status', async ctx => {
  const cacheKey = 'status';
  const cachedData = getCachedData(cacheKey);

  if (cachedData) {
    ctx.body = cachedData;
    return;
  }

  const response = await loggedFetch(`${API_BASE_URL}/status`);
  const data = await response.json();
  setCachedData(cacheKey, data);
  ctx.body = data;
});

router.get('/api/station/:id', async ctx => {
  const stationId = ctx.params.id;
  const cacheKey = `station:${stationId}`;
  const cachedData = getCachedData(cacheKey);

  if (cachedData) {
    ctx.body = cachedData;
    return;
  }

  const response = await loggedFetch(`${API_BASE_URL}/status`);
  const data = await response.json();
  const stationData = data.stationStatuses[stationId];
  setCachedData(cacheKey, stationData);
  ctx.body = stationData;
});

router.post('/api/station/:id/configure', async ctx => {
  const stationId = ctx.params.id;
  const body = ctx.request.body as { ssid: string; wpaKey?: string };

  // Construct the configuration payload
  const config = {
    stationConfigurations: {
      [stationId]: {
        ssid: body.ssid,
        wpaKey: body.wpaKey,
      },
    },
  };

  const response = await loggedFetch(`${API_BASE_URL}/configuration`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });

  // Clear cache after configuration changes
  Object.keys(cache).forEach(key => delete cache[key]);

  ctx.body = await response.text();
});

app.use(router.routes()).use(router.allowedMethods());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Server running on port ${PORT}`);
});
