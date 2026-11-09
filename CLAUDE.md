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
npm run test --workspace=apps/backend          # node:test via tsx — trade matcher + Flex parser
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
- **Tests exist only for the backend's pure logic** (`apps/backend/src/lib/*.test.ts`, Node's
  built-in runner via `tsx --test`; no framework dependency). Node 20's runner does **not**
  discover `.ts` by directory or expand globs under cmd, so new test files must be added to the
  `test` script's explicit path list. There is no lint tooling and no frontend test runner.
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
  - `services/quote-stream.service.ts` — real-time watchlist prices. The client sends its full
    symbol set as a `watch` message; the gateway diffs it and the service keeps **one ref-counted
    `reqMktData` line per distinct symbol** (many windows watching SPY = one line), emitting
    throttled `quote` messages (last + prevClose). Price-only by design — volume/RVOL still come
    from `/api/quotes` since they need daily bars. Lines are re-issued after an IBKR reconnect;
    the gateway caps one client at 30 symbols (market-data lines are finite).
  - `services/flex.service.ts` + `routes/pnl.routes.ts` — the P&L calendar's data. **The TWS API
    only returns the CURRENT day's executions** (a 90-day `ExecutionFilter` returns nothing), so
    history comes from IBKR's **Flex Web Service** (user-supplied token + query id, stored in
    `<DATA_DIR>/store/flex.json`; statements cached to `trades.json`). Two-step fetch:
    `SendRequest` → ReferenceCode → `GetStatement` (retries while IBKR generates it).
    `/api/pnl/calendar` merges Flex history with locally-collected fills for today (Flex wins per
    date); a "trade" is a round-trip grouped per (day, symbol).
  - **Trade journal** — `lib/tradeMatcher.ts` is the core: a **pure**, unit-tested FIFO matcher
    (no IBKR/Fastify/fs) that folds a fill stream into round-trips. Lots are consumed FIFO but a
    *trade* is one **position episode** (flat → non-flat → flat), so scale-ins/scale-outs collapse
    into one trade with quantity-weighted entry/exit while every fill survives on
    `entryLegs`/`exitLegs` for charting; a fill carrying the position through flat is split into two
    episodes. P&L uses IBKR's own realized figure when every closing fill reports one
    (`pnlSource:'ibkr'`), else FIFO price math. **IBKR's realized P&L is ALREADY NET of
    commissions** — both `commissionReport.realizedPNL` and Flex's `fifoPnlRealized` (verified:
    NVDA 225C bought 1.53 / sold 1.71 is 18.00 gross, fees 2.087413, IBKR reports 15.912587; and
    Flex matches the TWS figures exactly on every overlapping day). So `pnl` takes it as-is and
    derives `grossPnl` by adding fees back; only the computed path subtracts them. Deducting them
    from IBKR's number understated every trade by its own fees. `services/trades.service.ts` merges Flex history +
    local executions into that stream (**Flex wins for every date it can MATCH** — i.e. where its
    rows carry execution-level detail — so a fill in both isn't double-counted, while a date whose
    Flex rows are day-level only falls back to local fills instead of vanishing), then caches
    matched trades + day rollups to `<DATA_DIR>/store/trade-aggregates.json` keyed by an input
    fingerprint that includes a `CALC_VERSION` — bump it whenever the P&L maths changes or a stale
    cache is served. `routes/trades.routes.ts`
    serves `/api/trades/summary|day/:date|stats`. Trades are booked on the ET date they **closed**.
  - `services/executions.service.ts` — polls `reqExecutions` every 10s (manual TWS fills don't
    push to non-zero client ids); normalizes fills to `TradeExecution` (options carry the
    UNDERLYING symbol), persists ~5 days to `<DATA_DIR>/store/executions.json`, broadcasts new
    ones over WS (`executions` message) and serves `GET /api/executions`.
  - Routes: `routes/api.routes.ts` (`/api/status`, `/api/bars`, `/api/search`, `/api/quotes` —
    batch watchlist quotes: last/change/%/today-volume from 2-day 1-min bars, per-symbol errors
    inline), `routes/summary.routes.ts` (`/api/summary` — SPY/QQQ quotes via IBKR + ForexFactory
    econ calendar + CNBC RSS, each independently cached), `routes/store.routes.ts`
    (`GET/PUT /api/store/:key` — file-backed persistence for client stores, whitelisted keys;
    files in `DATA_DIR` = exe userData / dev `apps/backend/.data`), `routes/scanner.routes.ts`
    (`/api/scanner/rvol` — IBKR HOT_BY_VOLUME scan over STK.US.MAJOR, `marketCapAbove` is in
    **$ millions**, then exact session-adjusted RVOL from `fetchRecentDailyBars` — today's partial
    daily bar carries cumulative volume; results cached 60s), `routes/ws.routes.ts` (`/ws`).
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
  - Trade execution arrows: `lib/executionStore.ts` (fills keyed by underlying, hydrated from
    `/api/executions` + WS pushes) → `rebuildMarkers` in `ChartPanel` (snap fill time to the
    nearest bar ≤ it) → `ChartHandle.setMarkers` (native lightweight-charts series markers,
    re-applied after every full `setData`/`correctBars`). Buys green ↑ below bar, sells red ↓ above.
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
  - `lib/drawings.ts` — drawing geometry/hit-testing + pixel↔time helpers (`timeToX`,
    `xToTimeAnchored`, `fromPixel`, `timeToUnix`, `plotRight`). Time↔pixel goes through the
    chart's bar index — see the gotcha; it is the reason drawings line up across timeframes.
  - **Callout (text bubble)** — `type:'callout'` holds TWO logical points: `anchor` (the spot the
    tail points at) and `bubble` (where the box sits), so it tracks its candle across pan/zoom and
    every timeframe. Box size comes from the text via `calloutBox()`, which measures on a shared
    offscreen 2D context — **rendering and hit-testing both call it**, so they can't disagree.
    Creating one commits on pointer-up (a plain click uses a default bubble offset scaled to bar
    spacing + recent range) and immediately opens the settings card, whose textarea autofocuses.
    **Dragging the body moves the bubble ONLY — the tail tip stays pinned** to what it points at
    (that's the point of a callout); re-aim the tip by dragging its own handle.
    Empty text renders a dim `Text…` placeholder so a fresh bubble is still visible and clickable.
  - **Drawings list + master hide** (`components/Drawings/DrawingsList.tsx`) — a rail drawer that
    lists every drawing on one symbol so it can be deleted without hunting for it on the chart
    (a shape parked months back, or stacked under three others, is effectively unclickable). It
    reads `drawingStore` DIRECTLY rather than a panel's props, because drawings belong to the
    SYMBOL: `getDrawingSymbols()` feeds a switcher so a ticker that isn't loaded in any panel can
    still be cleaned out. Deletes go through the normal setter, so they reach every panel, persist,
    and are undoable. Shares the drawer slot with the watchlist and scanner.
    The rail's **hide-all** toggle (`ibkr_show_drawings`, same pattern as `ibkr_show_trades`) feeds
    `showDrawings` to every `ChartPanel`, which renders `visibleDrawings` — everything, or alerts
    only. Two things that are easy to get wrong:
      - **Price alerts are exempt.** They live in the drawing store but still quack and pop a toast
        when they fire, and `checkAlertsRef` reads the store, not what's drawn — a hidden alert
        going off would be mystery noise.
      - **`handleDrawingsChange` must merge while hidden.** The chart only ever received the
        alerts, so writing its list straight back would delete every hidden shape; it splices the
        visible set over the unseen ones instead. Picking a drawing tool also un-hides, so you
        can't paint something invisible.
  - **Drawing undo (Ctrl+Z)** — `lib/drawingStore.ts` keeps a per-symbol stack of previous drawing
    lists (in-memory, capped 60, not persisted). `setDrawings(symbol, next, { undoable: false })`
    opts out — the alert-triggered write uses it, since that's not a user edit and would otherwise
    bury real edits. `useSymbolDrawings` returns `[drawings, setDrawings, { undo, canUndo }]`;
    ChartPanel binds Ctrl/⌘+Z on the focused panel (ignored while typing in an input/textarea) and
    the toolbar's undo button disables itself when the stack is empty.
  - `lib/sessions.ts` + `lib/sessionShadingPrimitive.ts` — ET session math (opening range,
    prev-day H/L, pre-market H/L) and the pre/post-market background tint primitive.
    `currentSession()` reports the session the wall clock is in (weekends → `closed`).
  - **Pre/post price on the daily chart** — a daily candle closes at the 16:00 RTH close, so
    outside regular hours the live price is nowhere on a daily chart. `buildExtendedPriceLine`
    (ChartPanel) emits it as a dotted price line via the existing `setSessionLevels` channel —
    orange `Pre`, blue `Post`, nothing during RTH or when closed. Daily/weekly only; intraday
    already plots extended-hours candles. **Ticks are dropped for daily bars** (they must not drag
    an RTH candle) so `applyTick` captures `tick.last` into `extPriceRef` *before* that early
    return, throttled to 400ms; a 30s interval also re-runs it because session boundaries pass on
    the clock with no print. Toggled by `sessionOverlays.extendedPrice`, which is **optional and
    treated as ON when absent** so panels saved before it existed don't read as switched off.
  - `lib/chartTime.ts` — formats the time axis/crosshair in **Exchange time (America/New_York)**.
  - `components/Grid/ResizableGrid.tsx` + `lib/layout.ts` — CSS-grid layout presets with draggable
    splitters; per-window layout is keyed `ibkr_chart_layout_v3:win<id>` (from a `?win=` param).
  - `components/MarketSummary/` — the "morning summary" popup (SPY/QQQ, econ calendar, news).
  - **Trading journal (charts + notes)** — separate from the P&L calendar: same month grid, but a
    day holds ONE chart capture and ONE note. `lib/chartCapture.ts` composites every `<canvas>`
    inside each `#chart-panel-*` onto one output canvas positioned on the panels' real screen
    geometry, so a 2×2 grid captures as a 2×2 grid. Done this way (rather than Electron
    `capturePage`) it works identically in the browser and the exe with no IPC bridge — the preload
    is deliberately a stub — and it picks up drawings/indicators/markers for free since those are
    painted into the chart canvases. DOM chrome (panel toolbars, price readouts) can NOT be
    composited, so each panel gets a drawn `SYMBOL · TF` header. `routes/journal.routes.ts` stores
    notes in `<DATA_DIR>/store/journal.json` and images as real PNGs under `<DATA_DIR>/journal/`
    (`:date` is a filename — it's regex-validated against traversal); the image route raises
    Fastify's 1MB `bodyLimit`, which a base64 grid shot would otherwise exceed. Capture button is
    in the top toolbar (`App.tsx`), the calendar is a rail modal (`components/Journal/`).
  - **Theming** — `lib/theme.ts` + `lib/themeStore.ts`. A theme is the **same nine fields
    chartthemes.com publishes, in that order** (bearish body/wick/border, bullish body/wick/border,
    background, foreground, text) plus an optional `accent`, so a theme from that site transfers
    field-for-field; `parseThemeColors()` pulls the nine colours out of pasted text in any shape.
    Nine values can't name every surface, so `deriveCssVars()` **derives** panels/borders/secondary
    text by mixing `background` toward `foreground` — which inverts automatically for a light
    background. The UI recolours purely through the CSS custom properties it already used, so
    components need no changes; **lightweight-charts can't read CSS vars**, so `ChartContainer`
    subscribes via `subscribeTheme` and re-applies chart/candle options. Volume bars bake their
    colour into each point, so `volDirRef` keeps each bar's direction for recolouring. Persisted
    like drawings: localStorage warm cache + durable `/api/store/theme`. `initTheme()` runs in
    `main.tsx` before render so a saved theme never flashes the default palette. Edited from the
    rail's **Settings** modal (`components/Settings/`), which is sectioned for future settings.
  - **`lib/chartSettingsStore.ts`** — behavioural (not colour) chart settings, same persistence
    pattern as the theme (`/api/store/chartSettings`, `initChartSettings()` in `main.tsx`). Holds
    `candleUpdates: 'exact' | 'smooth'` — see the gotcha on IBKR's ~6s bar-report delay. Edited
    from the Settings modal's **Charts** section.
  - `components/SideRail/` — persistent right-edge tool rail (icon buttons via a `RailItem[]`);
    extend the `railItems` array in `App.tsx` as more quick tools land. Tools: watchlist,
    RVOL scanner (`components/Scanner/`, shares the drawer slot with the watchlist — opening one
    closes the other), the P&L calendar / trade journal (`components/PnlCalendar/` — a modal, not a
    drawer), and the trade-arrows toggle (persisted as `ibkr_show_trades`).
  - **Trade journal UI** — `components/PnlCalendar/` has two tabs. The calendar colours each day by
    net P&L (intensity scaled to the month's largest day) and **clicking a day opens `DayTrades`**,
    the matched round-trips for it; clicking a trade calls `onOpenTradeOnChart`, which parks it in
    `lib/journalStore.ts` and points the focused panel at the underlying's 1m chart for that
    session. `TradeStats` is the second tab (win rate vs avg win/loss, P&L by weekday / ET hour /
    symbol, day streaks), scoped to the displayed month.
  - **Journal review mode:** `PanelConfig.sessionEnd` (unix seconds) makes a panel load fixed
    history via `GET /api/bars?...&end=` instead of subscribing — `keepUpToDate` can only stream the
    LIVE window, so a session months back is unreachable otherwise. While it's set the panel does
    not stream and the ~60s re-sync is skipped; an orange "Reviewing &lt;date&gt;" chip in the toolbar
    clears it. `lib/tradeMarkers.ts` maps the trade's legs to markers (snapped to real bar times,
    blue entries / orange exits) and is kept pure so the mapping is checkable on its own.
  - Drawings carry an optional `label` (trendline / hline / rectangle), edited in the settings card
    and drawn by `drawLabelChip` as a chip at the drawing's right edge (hline: the price readout
    shifts left to make room).
  - `components/Watchlist/` + `hooks/useWatchlist.ts` + `lib/watchlistStore.ts` — a single global
    watchlist (localStorage `ibkr_watchlist_v1`) docked left of the rail. Clicking a row loads that
    symbol (STK/SMART/USD) into the **focused** panel. Its data lives in **`lib/quoteStore.ts`**
    (module-level, started once from `App.tsx`), NOT in the panel — the drawer unmounts when closed,
    so panel-local state was thrown away on every close. The store merges two sources: `/api/quotes`
    every 60s (prevClose, today's volume, RVOL — one serialized historical request per symbol) and
    the WS `quote` stream (last price, live; change/% are recomputed from it). Recomputation is lazy
    and listener notifications are throttled/skipped when the drawer is closed, so a hidden watchlist
    costs only the poll + the market-data lines.
  - Timeframe hotkey (in `ChartPanel`, `parseTimeframe`): on the focused chart, typing a digit opens
    a TradingView-style box (`1`→1m, `30`→30m, `1d`→daily, `60`/`1h`, `240`/`4h`, `1w`); Enter or a
    ~1.1s pause applies, Esc cancels. Guards the Delete/Backspace drawing handler while mid-entry.
  - `lib/indicators.ts` — SMA/EMA/Bollinger computation. **Bollinger Bands are one
    `IndicatorConfig` (`type:'BB'`, `stdDev`, `basisColor`) that expands into THREE line series**
    keyed `BB-20:upper|:basis|:lower`; `baseIndicatorKey()` strips the `:suffix` so double-clicking
    any edge opens the one config. The deviation is the **population** form (÷N, matching Pine's
    `ta.stdev` default) — the sample form (÷N−1) would visibly widen every band vs TradingView.
    Chart-source only: `computeDailyIndicators` filters BB out, since a stepped daily band
    projected onto 1m isn't meaningful. The shaded channel between the edges is
    `lib/bollingerFillPrimitive.ts` (v4 has no band series), paired up in `setIndicators` via each
    series' `bandFill.group`.
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

- **Day bucketing is ET, via `apps/backend/src/lib/etTime.ts` — never the server's timezone.**
  IBKR reports execution times as a bare wall clock in the TWS operator's zone with no offset, and
  Flex `dateTime` likewise. Both are resolved against `America/New_York` (DST-aware), so a 16:05
  fill stays on its own trading day instead of rolling past UTC midnight. Reading them as
  machine-local was only correct while this machine sat in ET.
- **Bar time is numeric UTC epoch everywhere; daily/weekly render as business days.** The backend
  emits all bar times as numeric unix seconds (`formatDate=2`). The frontend `toChartTime()`
  (`ChartContainer.tsx`) and `lib/indicators.ts` convert numbers to `"YYYY-MM-DD"` for daily/weekly.
  Because daily charts use business-day times, `coordinateToTime` returns a `{year,month,day}`
  object — drawing code must run it through `timeToUnix()` (never `Number()`, which yields `NaN`).
  Historical and streaming bars must share the same numeric representation or the
  `findIndex(b.time === bar.time)` merge breaks and you hit "data must be asc ordered by time".
- **Drawings map time→pixel through the chart's BAR INDEX, never `timeToCoordinate`.**
  `timeScale().timeToCoordinate()` only answers for a time that is EXACTLY a bar time in the
  series, which a drawing viewed on another timeframe almost never is (a 14:43 corner is not a
  30m bar; a daily drawing's midnight is not an intraday bar). Those lookups used to fall through
  to clamping — both corners onto the left or right edge, so a rectangle became a full-width band
  or a zero-width sliver — or to an interpolation that computed `Number("2026-11-05")` → **NaN**
  on every daily/weekly chart and rendered nothing. `lib/drawings.ts` now maps time → fractional
  bar index against `series.data()`'s own times, then index → pixel: the index→pixel transform is
  exactly affine (`logicalToCoordinate` is linear with slope = bar spacing — but it returns **0**
  for a *fractional* index, so take two integer probes and interpolate yourself), it is defined
  outside the loaded data, and it behaves the same on numeric and business-day charts. Verified to
  agree with `timeToCoordinate` to <1e-6 on every real bar, so it is a strict superset.
- **A day-level drawing time is a DATE, not an instant — align it before mapping.** A drawing made
  on a daily chart stores exactly UTC midnight, and UTC midnight of day D is **19:00 ET on D−1**:
  read as an instant it lands a whole session early. `alignToSeries` converts a day-level time to
  00:00 ET of that date when the target chart is intraday (DST-safe — the offset is derived per
  date via `etParts`, not hardcoded), and buckets an intraday time by its **ET** date when the
  target is daily (reading it as a UTC date puts anything after 19:00 ET on the following day).
  `unixToDayString` stays UTC on purpose: it mirrors `toChartTime()` and is what `tradeMarkers.ts`
  uses to key markers onto daily bars.
- **A shape whose span is sub-pixel on a coarse timeframe still has to be visible.** A 20-minute
  position is 0.014 of a daily bar; `renderPosition` used to `return` on `w < 1` and the drawing
  simply looked lost. Widths now have a `MIN_SHAPE_W` floor so it still reads as a marker and
  stays selectable.
- **Time axis is Exchange time (ET), not UTC.** Bars stay UTC epoch; only the display is converted
  via `lib/chartTime.ts` formatters wired into `CHART_OPTIONS`. Keep session logic (`lib/sessions.ts`)
  and the axis on the same ET basis.
- **Anything derived from bars must read `seriesBars()`, never `barsRef` directly.**
  `barsRef` holds CLOSED bars only, and right after a snapshot its last element is a *copy* of the
  candle still forming — ticks mutate `formingRef`, never that copy. Reading `barsRef` therefore
  feeds a FROZEN value for the newest candle, and once the clock rolls leaves it a whole bar behind
  the chart. `seriesBars()` merges the live forming bar over the stale copy (or appends it when
  newer); indicators and session levels both go through it. Indicators also have to be recomputed
  on `bar_update` and at the local rollover — a full recompute is ~0.04ms, so there's no reason to
  skip it — otherwise the MAs only move at `bar_close`.
- **IBKR reports a finished 1m bar ~6s AFTER the boundary** (measured: +6.01s, +6.02s, +5.60s on
  consecutive AAPL bars; the local clock was verified accurate to <1s). Nothing can remove that
  delay, so `lib/chartSettingsStore.ts` exposes the choice as **`candleUpdates`**:
  - `'exact'` (default) — ticks never touch bar OHLC and there is no local rollover, so the chart
    shows only what IBKR has actually sent and a closed bar never shifts afterwards. This is the
    `edce4c0` behaviour that "matches TWS by construction".
  - `'smooth'` — tick-painted forming candle + candle opens on the minute. Responsive, but
    everything between the boundary and IBKR's first report is provisional.
  Ticks still arrive in BOTH modes — `checkAlertsRef`, the daily pre/post price line and the
  watchlist depend on them; the mode gate sits *after* the alert call in `applyTick` and only
  stops bar mutation. The mode is read live (`getChartSettings()` per tick), so toggling applies
  without a reload; switching to `'exact'` also re-anchors immediately from `authFormingRef`
  rather than leaving a placeholder on screen for ~6s.
- **A `bar_update` for a minute older than `formingRef` is a CORRECTION, not the forming bar.**
  `barUpdateRef` used to adopt any update as forming. After a local rollover the chart's newest
  point is the fabricated bar, so `ChartContainer.updateBar` dropped the older time (`lastTimeRef`
  guard) *while* `formingRef` had already regressed to it — which made `steps >= 2`, disabled the
  rollover, and got every later tick repaint dropped too. The candle sat as a flat `volume: 0`
  doji until the next `bar_close` or the 3-minute resync. Older updates now route through the
  closed-bar path (`correctBars`) and never regress `formingRef`.
- **Tick-derived OHLC must never enter `barsRef`.** Ticks mutate `formingRef` in place and their
  price can be a bid/ask midpoint rather than a trade, with stale volume. `authFormingRef` keeps
  an untouched copy of the last authoritative value for the forming minute, and the local rollover
  writes *that* into the closed-bar history (indicators, session levels and markers consume it as
  real history until `bar_close` lands).
- **The clock-driven rollover pre-empts exactly ONE bar.** `applyTick` opens the next candle
  locally when the boundary passes so it appears on time; it used to jump `steps` bars ahead when
  several boundaries had passed, silently skipping every bar in between and leaving a hole until
  the resync (which is **180–210s**, not the ~60s older comments claimed). It now fabricates only
  when `steps === 1` and otherwise waits for the feed.
- **`correctRecent` is throttled per `reqId` and is RTH-only on purpose.** The throttle used to be
  keyed `symbol|timeframe`, so two panels on the same symbol+timeframe (a supported setup since
  subscriptions went per-panel) suppressed each other's correction for 15s; the entry is also
  cleared in `unsubscribe()`. Do **not** drop the RTH guard: it fetches TRADES only with no
  BID_ASK leg, so re-emitting a pre/post bar would undo `sanitizeExtendedBars` and put the stale
  away-from-market prints back — and adding the clamp means a second historical request per
  rollover, which at four 1m panels (~40 per 10 min already) trips IBKR's ~60/10min pacing.
  Extended-hours closes are corrected by the frontend's `/api/bars` re-sync, which does clamp.
- **Live candles come from IBKR `keepUpToDate`, not aggregation.** The old 5-sec `BarAggregator`
  (+ flat-fill, reconcile, continuity, deep-resync) is gone. `keepUpToDate` keeps the *forming* bar
  correct (incl. today's daily bar — no more "aggregate today's intraday" hack) but does **not**
  retroactively fix a *closed* bar when IBKR folds in a late-reported print minutes later (common in
  pre-market). The frontend's jittered **180–210s** `/api/bars` re-sync corrects closed bars (so
  PMH/PML stay right) while keeping the live forming bar.
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
  pane width, so it passes that as the right edge (don't subtract the axis twice). A
  `timeScale.rightOffset` leaves room to draw past the last bar; dragging a rectangle's far corner
  to the edge auto-sets `extendRight`. **The offset is per timeframe** (`rightOffsetFor` in
  `ChartContainer`): 20 bars on 1m, 6 elsewhere. Only the 1m chart re-pins to the live edge on
  every resize (`scrollToRealTime()`, which leaves exactly `rightOffset`), so without the larger
  buffer its candles sit flush against the price axis whenever the layout shifts — opening the
  watchlist, dragging a splitter, maximizing a panel. It's applied at mount, on timeframe change
  (the panel keeps its chart instance across switches), and in the 1m initial visible range.
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
- **The macOS .dmg is built in CI, not here** — electron-builder can't produce a mac target
  from Windows (`hdiutil`/`codesign` are macOS-only). `.github/workflows/build-mac.yml` runs
  `npm run desktop:dist` on a `macos-14` runner; trigger it by hand, or push a `v*` tag to also
  publish a GitHub Release. The same command builds it on a real Mac. The Windows exe is still
  built by hand from `main` as above — the workflow does not touch it.
- **A macOS build MUST be ad-hoc signed or it will not launch on Apple Silicon.** The mac
  config sets `identity: null`, which makes electron-builder skip signing entirely; macOS then
  kills the arm64 slice on launch (it surfaces as "the application is damaged"), because
  repackaging invalidates the signature Electron's own binaries ship with. `afterPack` →
  `apps/desktop/scripts/adhoc-sign.cjs` applies `codesign --sign -` and verifies it. It no-ops
  off-darwin, so it can't affect the Windows build. The CI job re-checks both the signature and
  `lipo -archs` and fails rather than shipping a .dmg that can't open.
- **`scripts/make-icon.mjs` emits BOTH icons from `icon.svg`** — `build/icon.ico` for Windows and
  a 1024px `build/icon.png` that electron-builder converts to `.icns`. Don't reach for
  `iconutil`: it's macOS-only and would break the Windows build.

## Running / previewing

`.claude/launch.json` defines preview server configs ("Frontend (Vite)", "Backend", "All").
Because the backend holds an exclusive IBKR client-id connection, only run one backend instance at
a time — stop a terminal `npm run dev` before launching a preview that also starts the backend.
