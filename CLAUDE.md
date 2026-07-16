# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A TradingView-like charting app powered by Interactive Brokers: React + Vite frontend,
Fastify backend talking to TWS/IB Gateway via `@stoqey/ib`, rendered with
lightweight-charts v4. Ships both as a dev web app and a standalone Electron desktop
app. npm-workspaces monorepo.

## Commands

```bash
npm install                                   # install all workspaces (run at root)
npm run dev                                    # backend + frontend together (concurrently)
npm run dev --workspace=apps/backend           # backend only (tsx watch, port 3001)
npm run dev --workspace=apps/frontend          # frontend only (Vite, port 5173)
npm run build --workspace=packages/types       # build shared types (do this if you hit type-resolution errors)
```

Desktop app (Electron, `apps/desktop`):

```bash
npm run build:app --workspace=apps/frontend    # Vite-only frontend build (NO tsc — see gotcha)
npm run bundle:backend --workspace=apps/desktop # esbuild the backend TS into build/backend/backend.cjs
npm run dist --workspace=apps/desktop           # build:icon + electron-builder → apps/desktop/release/*.exe
```

- **Backend requires `apps/backend/.env`** — `cp apps/backend/.env.example apps/backend/.env`.
  Key vars: `BACKEND_PORT` (default 3001), `IBKR_PORT` (7497 paper / 7496 live / 4002 / 4001),
  `IBKR_CLIENT_ID` (must be unique per running backend).
- **No test or lint tooling is configured** — there are no test/lint scripts and no test files.
- TWS or IB Gateway must be running with the API enabled before the backend can connect
  (see README "TWS / IB Gateway Setup"; TWS shows an "Accept incoming connection?" dialog
  on first connect).

## Architecture (big picture)

Four workspaces:
- `packages/types` — shared wire types (`Bar`, `Tick`, `Timeframe`, `TIMEFRAMES`, WS messages
  incl. `WsSnapshotMsg`). Composite TS project referenced by the apps; build it first if you hit
  type-resolution errors.
- `apps/backend` — Fastify 5, ESM, run via `tsx watch`. Two singletons:
  - `IBKRService` (`services/ibkr.service.ts`) — the single TWS socket connection with
    exponential-backoff reconnect; exposes the raw `@stoqey/ib` `IBApi` as `.api`.
  - `MarketDataService` (`services/market-data.service.ts`) — **drives charts from IBKR's native
    `reqHistoricalData(keepUpToDate=true)` feed** (see Data flow), plus one-shot `fetchHistoricalBars`
    (used by the summary route and the frontend's ~60s re-sync) and symbol search. Request IDs are
    partitioned by range in `config.ts` (`reqId.historicalBase` 1000 / `streamBase` 2000 /
    `searchBase` 3000); the per-stream tick channel uses `reqId + 1_000_000`.
  - `services/ws.gateway.ts` — per-browser-client WebSocket session/subscription management.
  - Routes: `routes/api.routes.ts` (`/api/status`, `/api/bars`, `/api/search`, `/api/quotes` —
    batch watchlist quotes: last/change/%/today-volume from 2-day 1-min bars, per-symbol errors
    inline), `routes/summary.routes.ts` (`/api/summary` — SPY/QQQ quotes via IBKR + ForexFactory
    econ calendar + CNBC RSS, each independently cached), `routes/store.routes.ts`
    (`GET/PUT /api/store/:key` — file-backed persistence for client stores, whitelisted keys;
    files in `DATA_DIR` = exe userData / dev `apps/backend/.data`), `routes/ws.routes.ts` (`/ws`).
  - `server.ts` serves the built frontend statically when `SERVE_STATIC` is set (the Electron path).
- `apps/frontend` — React 18 + Vite 5 + lightweight-charts v4, CSS Modules.
  - `hooks/useMarketStream.ts` — `/ws` client with auto-reconnect; tracks all active subscriptions
    and re-subscribes **every** panel on reconnect. Routes `snapshot` / `bar_update` / `bar_close` /
    `tick` to per-panel DOM-attached handlers (`__snapshotHandler`, `__barUpdateHandler`, …).
    Subscriptions are keyed by a per-panel `subId` end-to-end (hook + `ws.gateway`) — never by
    symbol alone, or two panels showing the same symbol stomp/kill each other's stream.
  - `hooks/useHistoricalBars.ts` — legacy REST `GET /api/bars` hook; **no longer used by the chart**
    (the chart is snapshot-driven over WS) — the ~60s re-sync in `ChartPanel` calls `/api/bars` directly.
  - `hooks/useSymbolDrawings.ts` + `lib/drawingStore.ts` — drawings are stored **per symbol**,
    shared across every panel/timeframe of that symbol (not per-panel). localStorage is only the
    warm cache; the durable copy is a JSON file behind `PUT/GET /api/store/drawings` (hydrated at
    boot with a per-id union merge, saved debounced) so drawings survive updates/cache clears.
  - Price alerts (`type:'alert'` in the drawing store): **Alt+A** places one at the cursor price
    on the focused chart; live tick/bar crossings quack (`lib/quack.ts`, WebAudio-synthesized —
    no asset) and pop a bottom-right toast (`components/AlertToasts/`, mallard included). One-shot:
    dragging or editing re-arms; `shouldFire` de-dupes multi-panel triggers.
  - `components/Chart/ChartContainer.tsx` — owns the lightweight-charts instance and exposes an
    **imperative `ChartHandle`** (`setData`, `updateBar`/`addBar`, `correctBars`, `setIndicators`,
    `setSessionLevels`, `setSessionRegions`, `fitContent`, `scrollToEnd`) via
    `forwardRef`/`useImperativeHandle`. Sizing via `ResizeObserver`; readiness via `onReady`. Also
    hit-tests indicator lines / session-level lines on double-click for their settings dialogs.
  - `components/Chart/ChartPanel.tsx` — orchestrates one panel: on `snapshot` renders the full
    series (`setData`), keeps a live "forming bar" (`formingRef`) that `bar_update` re-anchors and
    ticks paint onto, `bar_close` finalizes bars, runs a jittered ~60s history re-sync, recomputes
    session overlays, and renders the toolbar. Holds a reactive `bars` state (mirror of `barsRef`)
    for drawing extent / OHLC display.
  - Settings dialogs (double-click a drawing / indicator line / session-level line):
    `DrawingSettings.tsx`, `IndicatorSettings.tsx`, `SessionLevelSettings.tsx` (color / width /
    style, share `DrawingSettings.module.css`). Alt+click a panel maximizes it to fill the grid.
  - `components/Chart/DrawingCanvas.tsx` — input layer + in-progress "ghost" only; committed
    drawings are rendered by a chart **primitive** (`lib/drawingsPrimitive.ts`) so they stay
    frame-synced during pan/zoom/price-scale drags. Selection uses `chart.subscribeClick`; a native
    DOM `dblclick` listener opens settings (not `chart.subscribeDblClick`, which synthetic/CDP
    events don't trigger).
  - `lib/drawings.ts` — drawing geometry/hit-testing + pixel↔time helpers (`timeToX`, `fromPixel`,
    `timeToUnix`, `plotRight`).
  - `lib/sessions.ts` + `lib/sessionShadingPrimitive.ts` — ET session math (opening range,
    prev-day H/L, pre-market H/L) and the pre/post-market background tint primitive.
  - `lib/chartTime.ts` — formats the time axis/crosshair in **Exchange time (America/New_York)**.
  - `components/Grid/ResizableGrid.tsx` + `lib/layout.ts` — CSS-grid layout presets with draggable
    splitters; per-window layout is keyed `ibkr_chart_layout_v3:win<id>` (from a `?win=` param).
  - `components/MarketSummary/` — the "morning summary" popup (SPY/QQQ, econ calendar, news).
  - `components/SideRail/` — persistent right-edge tool rail (icon buttons via a `RailItem[]`);
    extend the `railItems` array in `App.tsx` as more quick tools land. First tool: the watchlist.
  - `components/Watchlist/` + `hooks/useWatchlist.ts` + `lib/watchlistStore.ts` — a single global
    watchlist (localStorage `ibkr_watchlist_v1`) docked left of the rail; polls `/api/quotes` every
    30s while open. Clicking a row loads that symbol (STK/SMART/USD) into the **focused** panel.
  - Timeframe hotkey (in `ChartPanel`, `parseTimeframe`): on the focused chart, typing a digit opens
    a TradingView-style box (`1`→1m, `30`→30m, `1d`→daily, `60`/`1h`, `240`/`4h`, `1w`); Enter or a
    ~1.1s pause applies, Esc cancels. Guards the Delete/Backspace drawing handler while mid-entry.
  - `lib/indicators.ts` — SMA/EMA computation.
- `apps/desktop` — Electron shell. `main.js` spawns the esbuild-bundled backend (`backend.cjs`) via
  `ELECTRON_RUN_AS_NODE` with `SERVE_STATIC`/`FRONTEND_DIST` set, waits for `/api/status`, then loads
  the statically-served frontend. Ctrl+N opens a new window with its own `?win=` id (independent
  layout). electron-builder → NSIS installer; icon built by `scripts/make-icon.mjs`.

**Data flow:** TWS/Gateway → `@stoqey/ib` → `IBKRService` → `MarketDataService` → WS (`/ws`).
The chart is driven **entirely by one `reqHistoricalData(keepUpToDate=true)` per subscription** —
IBKR's native chart feed, so candles match TWS by construction. The initial batch is delivered as a
`snapshot` message; then `historicalDataUpdate` events are mapped to `bar_update` (forming bar) and
`bar_close` (rollover detected by time advancing; a past-time update = a late correction, re-emitted
as closed). A separate per-stream `reqMktData` last-price feed emits `tick` messages that paint the
forming candle sub-second between the slower keepUpToDate updates. Bar times use `formatDate=2`
(UTC epoch seconds). `/api/bars` (one-shot historical) still exists for the summary quotes and the
frontend's ~60s re-sync. There is **no** 5-sec-bar aggregation, flat-fill, or continuity transform —
that whole stack was removed in favor of the native feed.

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
- **Live candles come from IBKR `keepUpToDate`, not aggregation.** The old 5-sec `BarAggregator`
  (+ flat-fill, reconcile, continuity, deep-resync) is gone. `keepUpToDate` keeps the *forming* bar
  correct (incl. today's daily bar — no more "aggregate today's intraday" hack) but does **not**
  retroactively fix a *closed* bar when IBKR folds in a late-reported print minutes later (common in
  pre-market). The frontend's jittered ~60s `/api/bars` re-sync corrects closed bars (so PMH/PML
  stay right) while keeping the live forming bar.
- **Stock market data is always requested via `exchange=SMART` (consolidated tape).** A
  single-venue exchange (e.g. NASDAQ) returns that venue's prints only — penny-different
  highs/lows and gappier candles vs TWS/TV. The symbol search returns the LISTING exchange;
  it goes into `primaryExchange` (contract disambiguation only, `primaryExch` on the IB
  contract), never into `exchange`. `loadLayout` migrates old STK panels saved with a venue
  exchange.
- **Extended-hours snapshots are NBBO-clamped; RTH/live bars are raw.** `sanitizeExtendedBars`
  clamps pre/post-market snapshot bars to their minute's BID_ASK range (removing stale
  away-from-market prints that TWS also filters). It runs only on the initial snapshot and only for
  `useRTH=0` intraday — RTH bars and live updates are untouched. Candles are otherwise raw native
  bars (real opens, gaps and all — no continuity snap), matching TWS.
- **Drawings extend/clip to the plot area, not over the price axis.** `renderDrawings` clips to
  `plotRight` (canvas width − price-scale width). The drawings primitive's canvas is already the
  pane width, so it passes that as the right edge (don't subtract the axis twice). A small
  `timeScale.rightOffset` leaves room to draw past the last bar; dragging a rectangle's far corner
  to the edge auto-sets `extendRight`.
- **Backend port is `BACKEND_PORT`, not `PORT`.** Generic `PORT` gets hijacked by dev/preview
  tooling and would move the backend off 3001 (where the Vite proxy points). Keep it dedicated.
- **One IBKR connection per `IBKR_CLIENT_ID`.** TWS rejects a second socket using the same client
  id. Don't run two backends at once (a terminal `npm run dev` plus a preview/launch) without
  distinct client ids — symptom is "connects in one process, not the other". The packaged exe uses
  **port 3002 / client id 2** (dev uses 3001 / 1) so both stacks can run simultaneously; its
  backend logs to `%APPDATA%/@ibkr-chart/desktop/backend.log` (userData comes from the package
  name, not the product name — `config.json` lives there too) and old `config.json`s on 3001/1
  are auto-migrated.
- **Historical requests are serialized + pacing-aware.** `fetchHistoricalBars` and the
  `keepUpToDate` subscribe issuance queue through a promise chain (`histChain`) with a spacing gap.
  Concurrent direct requests otherwise get all-but-one rejected for pacing. Switching symbol/
  timeframe logs a benign "historical data query cancelled" error — just IBKR ack'ing the
  `cancelHistoricalData`.
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
- **Stale browser cache masquerades as a bug.** After heavy edits (or a render crash), a soft reload
  can serve stale Vite modules and leave the page running old code against fresh data — e.g. a
  session level that looks "stuck" at an old value. When frontend behavior contradicts what the
  backend/API return, do an **empty-cache hard reload** before debugging code. To confirm the split,
  run a `fetch('/api/bars?...')` in the browser console and compare to what the chart shows.

## Git / release workflow

- **Work on `dev`; `main` is releases.** Day-to-day commits go to `dev`. To ship: open a PR
  `dev → main` (`gh pr create`), merge it (`gh pr merge dev --merge`), then rebuild the exe **from
  `main`** (`build:app` → `bundle:backend` → `dist`). Stop the dev backend before `dist` and before
  launching the built exe (IBKR client-id collision). Return to `dev` after.
- Ask before anything that overwrites history or force-pushes.
- `apps/desktop/release/` is gitignored (large). electron-builder's version-stamp step
  occasionally hits a transient file lock and retries — the build still completes.

## Running / previewing

`.claude/launch.json` defines preview server configs ("Frontend (Vite)", "Backend", "All").
Because the backend holds an exclusive IBKR client-id connection, only run one backend instance at
a time — stop a terminal `npm run dev` before launching a preview that also starts the backend.
