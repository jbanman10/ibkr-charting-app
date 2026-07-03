# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TradingView-like charting app powered by Interactive Brokers: React + Vite frontend,
Fastify backend talking to TWS/IB Gateway via `@stoqey/ib`, rendered with
lightweight-charts v4. npm-workspaces monorepo.

## Commands

```bash
npm install                                   # install all workspaces (run at root)
npm run dev                                    # backend + frontend together (concurrently)
npm run dev --workspace=apps/backend           # backend only (tsx watch, port 3001)
npm run dev --workspace=apps/frontend          # frontend only (Vite, port 5173)
npm run build                                  # types → backend → frontend (in order)
npm run build --workspace=packages/types       # build shared types first if path/type errors appear
npm run typecheck                              # tsc --build (see caveat below)
```

- **Backend requires `apps/backend/.env`** — `cp apps/backend/.env.example apps/backend/.env`.
  Key vars: `BACKEND_PORT` (default 3001), `IBKR_PORT` (7497 paper / 7496 live / 4002 / 4001),
  `IBKR_CLIENT_ID` (must be unique per running backend).
- **No test or lint tooling is configured** — there are no test/lint scripts and no test files.
- TWS or IB Gateway must be running with the API enabled before the backend can connect
  (see README "TWS / IB Gateway Setup"; TWS shows an "Accept incoming connection?" dialog
  on first connect).

## Architecture (big picture)

Three workspaces:
- `packages/types` — shared wire types (`Bar`, `Tick`, `Timeframe`, `TIMEFRAMES`, WS messages).
  Composite TS project referenced by both apps; build it first if you hit type-resolution errors.
- `apps/backend` — Fastify 5, ESM, run via `tsx watch`. Two singletons:
  - `IBKRService` (`services/ibkr.service.ts`) — the single TWS socket connection with
    exponential-backoff reconnect; exposes the raw `@stoqey/ib` `IBApi` as `.api`.
  - `MarketDataService` (`services/market-data.service.ts`) — historical bars, real-time
    streaming, symbol search over that one connection. Request IDs are partitioned by range in
    `config.ts` (`reqId.historicalBase` 1000 / `streamBase` 2000 / `searchBase` 3000).
  - `services/ws.gateway.ts` — per-browser-client WebSocket session/subscription management.
  - Routes: `routes/api.routes.ts` (`/api/status`, `/api/bars`, `/api/search`), `routes/ws.routes.ts` (`/ws`).
- `apps/frontend` — React 18 + Vite 5 + lightweight-charts v4, CSS Modules.
  - `hooks/useHistoricalBars.ts` — REST `GET /api/bars`, AbortController, request-key dedupe.
  - `hooks/useMarketStream.ts` — `/ws` client with auto-reconnect.
  - `hooks/useSymbolDrawings.ts` + `lib/drawingStore.ts` — drawings are stored **per symbol**
    (localStorage), shared across every panel/timeframe of that symbol (not per-panel).
  - `components/Chart/ChartContainer.tsx` — owns the lightweight-charts instance and exposes an
    **imperative `ChartHandle`** (`setData`, `updateBar`/`addBar`, `setIndicators`,
    `setSessionLevels`, `setSessionRegions`, `fitContent`, `scrollToEnd`) via
    `forwardRef`/`useImperativeHandle`. Sizing via `ResizeObserver`; readiness via `onReady`.
  - `components/Chart/ChartPanel.tsx` — orchestrates one panel: fetches bars, loads them once the
    chart is ready, keeps a live "forming bar" (`currentBarRef`) that ticks paint onto, wires RT
    bar/tick handlers (attached to the panel's DOM element by id), recomputes session overlays,
    renders the toolbar.
  - `components/Chart/DrawingCanvas.tsx` — input layer + in-progress "ghost" only; committed
    drawings are rendered by a chart **primitive** (`lib/drawingsPrimitive.ts`) so they stay
    frame-synced during pan/zoom/price-scale drags. Selection uses `chart.subscribeClick`.
  - `lib/drawings.ts` — drawing geometry/hit-testing + pixel↔time helpers (`timeToX`, `fromPixel`,
    `timeToUnix`, `plotRight`).
  - `lib/sessions.ts` + `lib/sessionShadingPrimitive.ts` — ET session math (opening range,
    prev-day H/L, pre-market H/L) and the pre/post-market background tint primitive.
  - `lib/chartTime.ts` — formats the time axis/crosshair in **Exchange time (America/New_York)**.
  - `components/Grid/ResizableGrid.tsx` + `lib/layout.ts` — CSS-grid layout presets (single,
    side-by-side, quad, 2×3, primary-left/right) with draggable splitters (splitters only render
    for a single 2-track split per axis).
  - `lib/indicators.ts` — SMA/EMA computation.

**Data flow:** TWS/Gateway → `@stoqey/ib` → `IBKRService` → `MarketDataService` →
REST (`/api/bars`, `/api/search`) and WS (`/ws`). Historical bars are requested with IBKR
`formatDate=2` (UTC epoch seconds). Live data arrives as IBKR 5-second real-time bars, aggregated
server-side by `BarAggregator` into the requested timeframe and pushed as `bar_update` /
`bar_close`. Sub-second `tick` messages drive TradingView-style live candle movement on the frontend.

In dev, the Vite proxy forwards `/api` → `http://localhost:3001` and `/ws` → `ws://localhost:3001`;
HMR runs on its own port (5174) and the `/ws` proxy has an error handler so a backend WS reset
doesn't crash the dev server.

## Critical gotchas

- **Bar time is numeric UTC epoch everywhere; daily/weekly render as business days.** The backend
  emits all bar times as numeric unix seconds (`formatDate=2`). The frontend `toChartTime()`
  (`ChartContainer.tsx`) and `lib/indicators.ts` convert numbers to `"YYYY-MM-DD"` for daily/weekly.
  Because daily charts use business-day times, `coordinateToTime` returns a `{year,month,day}`
  object — drawing code must run it through `timeToUnix()` (never `Number()`, which yields `NaN`),
  and `timeToX` retries a numeric time as a `"YYYY-MM-DD"` day string so drawings line up across
  timeframes. Historical and streaming bars must share the same numeric representation or the
  `findIndex(b.time === bar.time)` merge breaks and you hit "data must be asc ordered by time".
- **Time axis is Exchange time (ET), not UTC.** Bars stay UTC epoch; only the display is converted
  via `lib/chartTime.ts` formatters wired into `CHART_OPTIONS`. Keep session logic (`lib/sessions.ts`)
  and the axis on the same ET basis.
- **IBKR daily history omits today's bar.** `MarketDataService` builds today's daily candle by
  aggregating today's intraday (a `30 mins`/`1 D` request) and appending/replacing it, so it isn't
  a tiny live-only stub. The frontend `bar_update` handler **merges** same-time updates into the
  forming bar (keep open, grow high/low, move close) rather than replacing — required so live
  updates don't shrink the daily candle back to the launch price.
- **Drawings extend/clip to the plot area, not over the price axis.** `renderDrawings` clips to
  `plotRight` (canvas width − price-scale width). The drawings primitive's canvas is already the
  pane width, so it passes that as the right edge (don't subtract the axis twice). A small
  `timeScale.rightOffset` leaves room to draw past the last bar; dragging a rectangle's far corner
  to the edge auto-sets `extendRight`.
- **Backend port is `BACKEND_PORT`, not `PORT`.** Generic `PORT` gets hijacked by dev/preview
  tooling and would move the backend off 3001 (where the Vite proxy points). Keep it dedicated.
- **One IBKR connection per `IBKR_CLIENT_ID`.** TWS rejects a second socket using the same client
  id. Don't run two backends at once (a terminal `npm run dev` plus a preview/launch) without
  distinct client ids — symptom is "connects in one process, not the other".
- **Historical requests are serialized + pacing-aware.** `MarketDataService.fetchHistoricalBars`
  queues each request through a promise chain (`histChain`) with a spacing gap and settles on the
  IBKR `error` event. Concurrent direct requests otherwise get all-but-one rejected for pacing.
- **`npm run typecheck` is not green.** `tsc --build` reports pre-existing errors (missing
  CSS-module declarations, `@stoqey/ib` arg-count skew, `import.meta.env` typing). The app runs via
  `tsx`/`vite` (transpile-only), so these don't block dev/build — don't treat it as a gate.
  **Do NOT run `tsc`/`npm run build` casually:** it emits compiled `.js` next to the `.tsx` in
  `apps/frontend/src`, and Vite then resolves imports to the stale `.js` instead of your `.tsx`,
  silently shadowing edits. If drawings/components behave like your changes aren't loading, check
  for and delete `apps/frontend/src/**/*.js`.
- **React.StrictMode is on** (`apps/frontend/src/main.tsx`): mount effects run twice in dev;
  `ChartContainer` creates/removes the chart (and its primitives) accordingly each cycle.
- **A nested duplicate copy of the project exists under `ibkr-chart/` inside the repo root.** The
  live code is the **top-level** `apps/` and `packages/`. Don't edit the nested `ibkr-chart/...` tree.

## Known rough edges
- Daily (`1D`) charts log two caught (non-crashing) errors during live updates: an indicator
  `setData` "asc ordered" duplicate (the indicator path doesn't de-dupe like the candle `setData`
  does) and a `updateBar` "Cannot update oldest data". Today's daily candle still renders full from
  the backend; live ticking on daily is flaky. Not yet fixed.

## Running / previewing

`.claude/launch.json` defines preview server configs ("Frontend (Vite)", "Backend", "All").
Because the backend holds an exclusive IBKR client-id connection, only run one backend instance at
a time — stop a terminal `npm run dev` before launching a preview that also starts the backend.
