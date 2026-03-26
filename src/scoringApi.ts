import { IncomingMessage, ServerResponse } from 'http';
import { URL } from 'url';
import CIDRMatcher from 'cidr-matcher';
import { ScoringEngine } from './scoringEngine.js';
import { ApiKeyStore } from './apiKeyStore.js';
import { isScoreEvent, ScoringElementConfig, ScoringMode } from './types.js';
import { getRealClientIp, normalizeIp } from './utils.js';

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
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

function json(res: ServerResponse, status: number, body: unknown): void {
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
function extractKey(req: IncomingMessage): string | undefined {
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
 * Check authentication for a scoring API request.
 * Returns true if the request is authorized.
 * On failure, records the device as pending for admin approval.
 */
function checkAuth(req: IncomingMessage, apiKeyStore: ApiKeyStore, trustedProxyMatcher?: CIDRMatcher): boolean {
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

/**
 * Handle scoring HTTP API requests.
 * Returns true if the request was handled, false if the URL doesn't match a scoring route.
 */
export function handleScoringRequest(
  req: IncomingMessage,
  res: ServerResponse,
  engine: ScoringEngine,
  apiKeyStore: ApiKeyStore,
  trustedProxyMatcher?: CIDRMatcher,
): boolean {
  const url = req.url?.split('?')[0]; // Strip query params for routing
  const method = req.method ?? 'GET';

  // CORS preflight for all /api/score routes
  if (method === 'OPTIONS' && url?.startsWith('/api/score')) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  // ── POST /api/score ── Submit score event(s) ──────────────────────
  if (method === 'POST' && url === '/api/score') {
    if (!checkAuth(req, apiKeyStore, trustedProxyMatcher)) {
      json(res, 401, {
        error: 'Unauthorized',
        message:
          'Valid API key required via X-API-Key header or ?key= parameter. ' +
          'If this is a new device, an admin can approve it from the admin panel.',
      });
      return true;
    }

    readBody(req)
      .then(body => {
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'Invalid JSON' });
          return;
        }

        // Support both single event and array of events
        const events = Array.isArray(data) ? data : [data];
        const results: { accepted: number; rejected: number; deduplicated: number; errors: string[] } = {
          accepted: 0,
          rejected: 0,
          deduplicated: 0,
          errors: [],
        };

        engine.batch(() => {
          for (const event of events) {
            if (!isScoreEvent(event)) {
              results.rejected++;
              results.errors.push(`Invalid event: ${JSON.stringify(event)}`);
              continue;
            }
            const result = engine.submitEvent(event);
            if (result === 'unknown_element') {
              results.rejected++;
              results.errors.push(`Unknown element "${event.element}" (configure it via PUT /api/score/config first)`);
            } else if (result === 'deduplicated') {
              results.deduplicated++;
            } else {
              results.accepted++;
            }
          }
        });

        json(res, results.rejected > 0 ? 207 : 200, results);
      })
      .catch(err => {
        json(res, 400, { error: err.message });
      });

    return true;
  }

  // ── GET /api/score ── Get current score state ─────────────────────
  if (method === 'GET' && url === '/api/score') {
    json(res, 200, engine.getState());
    return true;
  }

  // ── POST /api/score/reset ── Reset scores ─────────────────────────
  if (method === 'POST' && url === '/api/score/reset') {
    if (!checkAuth(req, apiKeyStore, trustedProxyMatcher)) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }
    engine.reset();
    json(res, 200, { ok: true });
    return true;
  }

  // ── GET /api/score/config ── Get element configuration ────────────
  if (method === 'GET' && url === '/api/score/config') {
    json(res, 200, { elements: engine.getElements() });
    return true;
  }

  // ── PUT /api/score/config ── Set element configuration ────────────
  if (method === 'PUT' && url === '/api/score/config') {
    if (!checkAuth(req, apiKeyStore, trustedProxyMatcher)) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }

    readBody(req)
      .then(body => {
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'Invalid JSON' });
          return;
        }

        if (!data || typeof data !== 'object') {
          json(res, 400, { error: 'Expected object with "elements" array' });
          return;
        }

        const { elements } = data as { elements?: unknown };
        if (!Array.isArray(elements)) {
          json(res, 400, { error: 'Expected "elements" array' });
          return;
        }

        const validated: ScoringElementConfig[] = [];
        const errors: string[] = [];

        for (const el of elements) {
          if (!el || typeof el !== 'object') {
            errors.push('Element must be an object');
            continue;
          }
          const { id, name, pointValue } = el as ScoringElementConfig;
          if (typeof id !== 'string' || !id) {
            errors.push('Element missing "id"');
            continue;
          }
          if (typeof name !== 'string' || !name) {
            errors.push(`Element "${id}" missing "name"`);
            continue;
          }
          if (typeof pointValue !== 'number') {
            errors.push(`Element "${id}" missing numeric "pointValue"`);
            continue;
          }
          validated.push(el as ScoringElementConfig);
        }

        if (errors.length > 0) {
          json(res, 400, { error: 'Validation errors', errors });
          return;
        }

        engine.setElements(validated);
        json(res, 200, { ok: true, elements: validated });
      })
      .catch(err => {
        json(res, 400, { error: err.message });
      });

    return true;
  }

  // ── PUT /api/score/mode ── Set scoring mode ───────────────────────
  if (method === 'PUT' && url === '/api/score/mode') {
    if (!checkAuth(req, apiKeyStore, trustedProxyMatcher)) {
      json(res, 401, { error: 'Unauthorized' });
      return true;
    }

    readBody(req)
      .then(body => {
        let data: unknown;
        try {
          data = JSON.parse(body);
        } catch {
          json(res, 400, { error: 'Invalid JSON' });
          return;
        }

        const { mode, windowSeconds, autoRegisterLimit, phaseGraceSeconds, batchTimeoutSeconds } = (data ?? {}) as {
          mode?: ScoringMode;
          windowSeconds?: number;
          autoRegisterLimit?: number;
          phaseGraceSeconds?: number;
          batchTimeoutSeconds?: number;
        };

        if (mode !== undefined) {
          if (mode !== 'freePlay' && mode !== 'match') {
            json(res, 400, { error: 'mode must be "freePlay" or "match"' });
            return;
          }
          engine.setMode(mode);
        }

        if (windowSeconds !== undefined) {
          if (typeof windowSeconds !== 'number' || windowSeconds < 1 || windowSeconds > 300) {
            json(res, 400, { error: 'windowSeconds must be a number between 1 and 300' });
            return;
          }
          engine.setWindowSeconds(windowSeconds);
        }

        if (autoRegisterLimit !== undefined) {
          if (typeof autoRegisterLimit !== 'number' || autoRegisterLimit < 0) {
            json(res, 400, { error: 'autoRegisterLimit must be a non-negative number' });
            return;
          }
          engine.setAutoRegisterLimit(autoRegisterLimit);
        }

        if (phaseGraceSeconds !== undefined) {
          if (typeof phaseGraceSeconds !== 'number' || phaseGraceSeconds < 0 || phaseGraceSeconds > 30) {
            json(res, 400, { error: 'phaseGraceSeconds must be a number between 0 and 30' });
            return;
          }
          engine.setPhaseGraceSeconds(phaseGraceSeconds);
        }

        if (batchTimeoutSeconds !== undefined) {
          if (typeof batchTimeoutSeconds !== 'number' || batchTimeoutSeconds < 1 || batchTimeoutSeconds > 600) {
            json(res, 400, { error: 'batchTimeoutSeconds must be a number between 1 and 600' });
            return;
          }
          engine.setBatchTimeoutSeconds(batchTimeoutSeconds);
        }

        json(res, 200, { ok: true, state: engine.getState() });
      })
      .catch(err => {
        json(res, 400, { error: err.message });
      });

    return true;
  }

  // ── GET /api/score/sources ── List scoring sources ────────────────
  if (method === 'GET' && url === '/api/score/sources') {
    const state = engine.getState();
    json(res, 200, { sources: state.sources });
    return true;
  }

  // ── GET /api/score/schema ── API schema documentation ─────────────
  if (method === 'GET' && url === '/api/score/schema') {
    json(res, 200, API_SCHEMA);
    return true;
  }

  return false; // Not a scoring route
}

/**
 * OpenAPI 3.1.0 spec served at GET /api/score/schema.
 * Designed for implementers building scoring clients — from Swagger UI to ESP32s.
 */
const API_SCHEMA = {
  openapi: '3.1.0',
  info: {
    title: 'Practice Field Scoring API',
    version: '1.0.0',
    description:
      'Submit score events from external goal-watching sensors, cameras, or referee tablets. ' +
      'The server handles deduplication, point calculation, timing, and broadcasts live scores ' +
      'to the scoreboard via WebSocket.\n\n' +
      '## Key Concepts\n\n' +
      '- **Scoring detection is the responsibility of the devices.** They send events; the server translates them into points.\n' +
      '- **Multiple sensors** can watch the same scoring element. Use `deduplicationWindowMs` to prevent double-counting.\n' +
      '- The server **automatically switches** to match mode when a match starts and back to freePlay when it ends.\n' +
      '- **freePlay mode**: scores use a sliding window — old events age out and the count drops.\n' +
      '- **match mode**: scores accumulate from zero with a per-phase breakdown.\n' +
      '- **Fouls**: configure an element with `awardToOpponent: true`. Send the event with the offending alliance — points go to the other side.\n\n' +
      '## Tiny Device Example (ESP32, Arduino)\n\n' +
      '```\n' +
      'POST /api/score?key=YOUR_KEY HTTP/1.1\r\n' +
      'Host: pfms.local:3000\r\n' +
      'Content-Type: application/json\r\n' +
      'Content-Length: 58\r\n' +
      '\r\n' +
      '{"source":"goal-1","alliance":"red","element":"speaker"}\n' +
      '```\n\n' +
      '## WebSocket\n\n' +
      'Score state is also broadcast to all WebSocket clients as JSON messages with `type: "scoreState"`. ' +
      'Connect to the same WebSocket used for match state and radio status to receive live score updates.',
  },
  servers: [{ url: '/', description: 'This server (relative)' }],
  components: {
    securitySchemes: {
      ApiKeyHeader: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description:
          'API key passed in the X-API-Key header. Keys are managed via the admin panel at /admin. ' +
          'Authentication is only required when at least one key has been created.',
      },
      ApiKeyQuery: {
        type: 'apiKey',
        in: 'query',
        name: 'key',
        description:
          'API key passed as a ?key= query parameter. Convenient for tiny devices that cannot set custom headers. ' +
          'Keys are managed via the admin panel. Unrecognized devices appear as pending for admin approval.',
      },
    },
    schemas: {
      ScoreEvent: {
        type: 'object',
        required: ['source', 'alliance', 'element'],
        properties: {
          source: { type: 'string', minLength: 1, description: 'Device/sensor identifier (e.g. "speaker-sensor-1").' },
          alliance: {
            type: 'string',
            enum: ['red', 'blue'],
            description: 'Alliance that triggered the scoring action.',
          },
          element: {
            type: 'string',
            minLength: 1,
            description: 'Scoring element ID. Must match a configured element (e.g. "speaker", "amp").',
          },
          count: {
            type: 'integer',
            default: 1,
            description: 'Number of scores. Default 1. Use negative values for corrections.',
          },
          timestamp: {
            type: 'number',
            description:
              'Device-side timestamp (ms since epoch). Optional — the server always records its own receive time. ' +
              'Useful when the device buffers events or has network latency. Used for display/ordering; ' +
              'deduplication uses server receive time.',
          },
        },
      },
      SubmitResult: {
        type: 'object',
        properties: {
          accepted: { type: 'integer', description: 'Number of events that were counted.' },
          rejected: { type: 'integer', description: 'Number of events that failed validation.' },
          deduplicated: {
            type: 'integer',
            description: 'Number of events merged into a previous event (dedup window) or ignored (inactive phase).',
          },
          errors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Human-readable error messages for rejected events.',
          },
        },
      },
      ElementScore: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: 'Total count of this element.' },
          points: { type: 'integer', description: 'Total points from this element.' },
          lastEventTime: { type: 'number', description: 'Timestamp (ms) of the most recent event.' },
        },
      },
      AllianceScore: {
        type: 'object',
        properties: {
          total: { type: 'integer', description: 'Total points for this alliance.' },
          elements: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/ElementScore' },
            description: 'Per-element score breakdown. Keys are element IDs.',
          },
        },
      },
      ScoringSourceStatus: {
        type: 'object',
        properties: {
          lastSeen: { type: 'number', description: 'Timestamp (ms) of the last event from this source.' },
          eventCount: { type: 'integer', description: 'Total events received from this source.' },
          lastElement: { type: 'string', description: 'Element ID of the last event.' },
          lastAlliance: { type: 'string', enum: ['red', 'blue'], description: 'Alliance of the last event.' },
        },
      },
      ScoringElementConfig: {
        type: 'object',
        required: ['id', 'name', 'pointValue'],
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description: 'Unique element identifier (e.g. "speaker", "amp", "coral_l1").',
          },
          name: { type: 'string', minLength: 1, description: 'Human-readable display name.' },
          pointValue: { type: 'number', description: 'Points awarded per count.' },
          awardToOpponent: {
            type: 'boolean',
            default: false,
            description: 'If true, points are awarded to the OPPOSING alliance (for fouls/penalties).',
          },
          activePhases: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['idle', 'countdown', 'auto', 'autoPause', 'paused', 'teleop', 'endgame', 'postMatch'],
            },
            description: 'Match phases during which this element scores. Omit or empty array = always active.',
          },
          deduplicationWindowMs: {
            type: 'integer',
            default: 0,
            description:
              'Events for the same element+alliance within this window (ms) are merged into one. 0 = no dedup.',
          },
          autoRegistered: {
            type: 'boolean',
            description:
              'True if this element was auto-registered from an incoming event rather than explicitly configured. ' +
              'Auto-registered elements default to pointValue: 1 with no dedup or phase restrictions.',
          },
        },
      },
      ScoreState: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'scoreState' },
          mode: { type: 'string', enum: ['freePlay', 'match'], description: 'Current scoring mode.' },
          windowSeconds: { type: 'integer', description: 'Sliding window size in seconds (freePlay mode).' },
          autoRegisterLimit: {
            type: 'integer',
            description:
              'Max elements that can be auto-registered from incoming events. Default: 1. Set to 0 to disable.',
          },
          red: { $ref: '#/components/schemas/AllianceScore' },
          blue: { $ref: '#/components/schemas/AllianceScore' },
          matchPhase: {
            type: 'string',
            enum: ['idle', 'countdown', 'auto', 'autoPause', 'paused', 'teleop', 'endgame', 'postMatch'],
            description: 'Current match phase (match mode only).',
          },
          phaseBreakdown: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                red: { $ref: '#/components/schemas/AllianceScore' },
                blue: { $ref: '#/components/schemas/AllianceScore' },
              },
            },
            description: 'Per-phase score breakdown (match mode only). Keys are phase names.',
          },
          sources: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/ScoringSourceStatus' },
            description: 'Status of all known scoring sources. Keys are source IDs.',
          },
          elements: {
            type: 'object',
            additionalProperties: { $ref: '#/components/schemas/ScoringElementConfig' },
            description: 'Configured scoring elements. Keys are element IDs.',
          },
        },
      },
      ModeUpdate: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['freePlay', 'match'], description: 'Scoring mode to set.' },
          windowSeconds: {
            type: 'integer',
            minimum: 1,
            maximum: 300,
            description: 'Sliding window size for freePlay mode.',
          },
          autoRegisterLimit: {
            type: 'integer',
            minimum: 0,
            description:
              'Max elements that can be auto-registered from incoming events. ' +
              'When a device sends an unknown element and the limit has not been reached, ' +
              'the element is created with pointValue: 1. Set to 0 to require explicit configuration. Default: 1.',
          },
        },
      },
    },
  },
  paths: {
    '/api/score': {
      post: {
        operationId: 'submitScoreEvents',
        summary: 'Submit score event(s)',
        description:
          'Submit one or more score events. This is the primary endpoint for scoring devices. ' +
          'Accepts a single ScoreEvent object or an array of ScoreEvent objects.',
        security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  { $ref: '#/components/schemas/ScoreEvent' },
                  { type: 'array', items: { $ref: '#/components/schemas/ScoreEvent' } },
                ],
              },
              examples: {
                minimal: {
                  summary: 'Minimal — single score event',
                  value: { source: 'sensor-1', alliance: 'red', element: 'speaker' },
                },
                batch: {
                  summary: 'Batch — multiple events in one request',
                  value: [
                    { source: 'sensor-1', alliance: 'red', element: 'speaker' },
                    { source: 'sensor-2', alliance: 'blue', element: 'amp', count: 2 },
                  ],
                },
                correction: {
                  summary: 'Correction — subtract a miscounted score',
                  value: { source: 'ref-tablet', alliance: 'red', element: 'speaker', count: -1 },
                },
                foul: {
                  summary: 'Foul — element with awardToOpponent gives points to blue',
                  value: { source: 'ref-tablet', alliance: 'red', element: 'foul' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'All events accepted.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubmitResult' },
                example: { accepted: 1, rejected: 0, deduplicated: 0, errors: [] },
              },
            },
          },
          207: {
            description: 'Some events were rejected (partial success).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubmitResult' },
                example: {
                  accepted: 1,
                  rejected: 1,
                  deduplicated: 0,
                  errors: ['Unknown element "foo" (configure it via PUT /api/score/config first)'],
                },
              },
            },
          },
          401: { description: 'API key missing or invalid.' },
        },
      },
      get: {
        operationId: 'getScoreState',
        summary: 'Get current score state',
        description:
          'Returns current totals, per-element breakdowns, source statuses, and element configuration. No authentication required.',
        responses: {
          200: {
            description: 'Current score state.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ScoreState' } } },
          },
        },
      },
    },
    '/api/score/reset': {
      post: {
        operationId: 'resetScores',
        summary: 'Reset all scores',
        description:
          'Clears all score events and resets totals to zero. Element configuration and source registry are preserved.',
        security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
        responses: {
          200: {
            description: 'Scores reset successfully.',
            content: { 'application/json': { example: { ok: true } } },
          },
          401: { description: 'API key missing or invalid.' },
        },
      },
    },
    '/api/score/config': {
      get: {
        operationId: 'getElementConfig',
        summary: 'Get element configuration',
        description: 'Returns all configured scoring elements.',
        responses: {
          200: {
            description: 'Current element configuration.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    elements: { type: 'array', items: { $ref: '#/components/schemas/ScoringElementConfig' } },
                  },
                },
              },
            },
          },
        },
      },
      put: {
        operationId: 'setElementConfig',
        summary: 'Replace element configuration',
        description: 'Replaces all scoring element configurations at once. Existing events are not affected.',
        security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['elements'],
                properties: {
                  elements: { type: 'array', items: { $ref: '#/components/schemas/ScoringElementConfig' } },
                },
              },
              example: {
                elements: [
                  { id: 'speaker', name: 'Speaker', pointValue: 5, deduplicationWindowMs: 2000 },
                  { id: 'amp', name: 'Amp', pointValue: 1 },
                  { id: 'foul', name: 'Foul', pointValue: 2, awardToOpponent: true },
                  { id: 'auto_bonus', name: 'Auto Mobility', pointValue: 3, activePhases: ['auto'] },
                ],
              },
            },
          },
        },
        responses: {
          200: { description: 'Configuration updated.' },
          400: { description: 'Validation errors in element definitions.' },
          401: { description: 'API key missing or invalid.' },
        },
      },
    },
    '/api/score/mode': {
      put: {
        operationId: 'setMode',
        summary: 'Set scoring mode',
        description: 'Set the scoring mode (freePlay or match) and/or the sliding window size for freePlay mode.',
        security: [{ ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ModeUpdate' } } },
        },
        responses: {
          200: {
            description: 'Mode updated. Returns current score state.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ScoreState' } } },
          },
          400: { description: 'Invalid mode or windowSeconds value.' },
          401: { description: 'API key missing or invalid.' },
        },
      },
    },
    '/api/score/sources': {
      get: {
        operationId: 'getSources',
        summary: 'List scoring sources',
        description: 'Returns all known scoring sources and their status (last seen, event count, etc.).',
        responses: {
          200: {
            description: 'Source registry.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sources: {
                      type: 'object',
                      additionalProperties: { $ref: '#/components/schemas/ScoringSourceStatus' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/score/schema': {
      get: {
        operationId: 'getSchema',
        summary: 'API schema (this document)',
        description: 'Returns this OpenAPI 3.1.0 specification as JSON.',
        responses: {
          200: { description: 'OpenAPI specification.' },
        },
      },
    },
  },
};
