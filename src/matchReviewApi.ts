import { IncomingMessage, ServerResponse } from 'http';
import CIDRMatcher from 'cidr-matcher';
import { MatchHistoryStore } from './matchHistoryStore.js';
import { ApiKeyStore } from './apiKeyStore.js';
import { isMatchRecordingRegistration, isMatchReviewSubmission } from './types.js';
import { readBody, json, checkAuth } from './httpApiUtils.js';

/**
 * Handle match-review HTTP API requests — the report-back half of the video
 * review integration. An external recording system (balls-counter) registers
 * the review page URL for a recorded match, and human reviewers' final scores
 * come back here to be attached to match history.
 *
 * Returns true if the request was handled, false if the URL doesn't match a review route.
 */
export function handleMatchReviewRequest(
  req: IncomingMessage,
  res: ServerResponse,
  historyStore: MatchHistoryStore,
  apiKeyStore: ApiKeyStore,
  trustedProxyMatcher?: CIDRMatcher,
): boolean {
  const url = req.url?.split('?')[0]; // Strip query params for routing
  const method = req.method ?? 'GET';

  if (!url?.startsWith('/api/match-review')) return false;

  // CORS preflight for all /api/match-review routes
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return true;
  }

  // ── POST /api/match-review ── Submit a reviewed score for one alliance ──
  if (method === 'POST' && url === '/api/match-review') {
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

        if (!isMatchReviewSubmission(data)) {
          json(res, 400, {
            error: 'Invalid review submission',
            expected: '{ matchId, alliance: "red"|"blue", score, autoScore?, reviewer }',
          });
          return;
        }

        const applied = historyStore.applyReview(data.matchId, data.alliance, {
          score: data.score,
          autoScore: data.autoScore,
          reviewer: data.reviewer,
          reviewedAt: Date.now(),
        });

        if (!applied) {
          json(res, 404, { error: `No match with id ${data.matchId} in history` });
          return;
        }

        console.log(
          `Match review: ${data.alliance} = ${data.score}` +
            (data.autoScore !== undefined ? ` (auto ${data.autoScore})` : '') +
            ` by ${data.reviewer} for match ${data.matchId}`,
        );
        json(res, 200, { ok: true });
      })
      .catch(err => {
        json(res, 400, { error: err.message });
      });

    return true;
  }

  // ── POST /api/match-review/recording ── Register the review page for a match ──
  if (method === 'POST' && url === '/api/match-review/recording') {
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

        if (!isMatchRecordingRegistration(data)) {
          json(res, 400, { error: 'Invalid recording registration', expected: '{ matchId, url }' });
          return;
        }

        if (!historyStore.setReviewUrl(data.matchId, data.url)) {
          json(res, 404, { error: `No match with id ${data.matchId} in history` });
          return;
        }

        console.log(`Match recording registered for ${data.matchId}: ${data.url}`);
        json(res, 200, { ok: true });
      })
      .catch(err => {
        json(res, 400, { error: err.message });
      });

    return true;
  }

  // ── GET /api/match-review/matches ── Recent matches + review status ──
  // Lets the recording system reconcile after downtime (which matches still need
  // a recording URL or review). Read-only, no auth (same as GET /api/score).
  if (method === 'GET' && url === '/api/match-review/matches') {
    const { matches } = historyStore.getState();
    json(res, 200, {
      matches: matches.map(m => ({
        matchId: m.matchId,
        matchNumber: m.matchNumber,
        startedAt: m.startedAt,
        endedAt: m.endedAt,
        endReason: m.endReason,
        teams: m.teams,
        redScore: m.redScore,
        blueScore: m.blueScore,
        review: m.review,
        reviewUrl: m.reviewUrl,
      })),
    });
    return true;
  }

  json(res, 404, { error: 'Unknown match-review route' });
  return true;
}
