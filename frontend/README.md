# pFMS Frontend

React + TypeScript + Vite **multi-page app**: each page is its own HTML
entry (`index.html`, `admin.html`, `scores.html`, …) built separately, so
the production reverse proxy serves clean URLs with
`try_files {path} {path}.html` and rewrites team-number URLs (`/1234`) to
`control.html`. See the [pages table](../README.md#pages) and
[reverse proxy setup](../docs/setup.md#reverse-proxy).

## Layout

- `src/roots/` — one entry module per page, referenced by the matching
  HTML file at the repo's `frontend/` root. `wrap.tsx` is the shared
  app wrapper (theme, status bar, support widget), not a page.
- `src/components/` — page components and shared UI
- `src/hooks/` — `useBackend.ts` holds the WebSocket connection and the
  per-message-type state hooks; also `useConnectivity`, `useMatchAudio`
  (must stay in sync with the server's countdown-variant selection),
  `useSavedWiFiSettings`
- `src/utils/` — shared helpers
- `src/public.html` — the standalone public-only page served to
  unauthenticated external visitors (copied by `update.sh`, not part of
  the Vite build)

## Development

From the repo root:

```bash
bun run dev                    # backend on :3000
cd frontend && bun run dev     # Vite dev server on :5173
```

The dev server proxies `/ws`, `/health`, `/api/team-avatar`, and
`/api/video-proxy` to the backend on `localhost:3000`, and mirrors the
production URL rewrites (team numbers → `control.html`, clean page URLs,
legacy redirects) — see `vite.config.ts`.

Adding a page means: an HTML file in `frontend/`, a root module in
`src/roots/`, a build input in `vite.config.ts`, and a dev rewrite in the
same file's `stationRoutes` list.
