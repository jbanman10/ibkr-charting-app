# IBKR Chart

A production-grade TradingView-like charting application powered by Interactive Brokers, built with React + Vite, Fastify, and lightweight-charts.

---

## Architecture

```
ibkr-chart/
├── packages/
│   └── types/                  # Shared TypeScript types (Bar, Tick, Contract, WS msgs)
└── apps/
    ├── backend/                # Fastify + @stoqey/ib
    │   └── src/
    │       ├── server.ts       # Entry point, graceful shutdown
    │       ├── config.ts       # All env-driven config
    │       └── services/
    │           ├── ibkr.service.ts        # TWS connection, exponential reconnect
    │           ├── market-data.service.ts # Historical bars, RT streaming, symbol search
    │           └── ws.gateway.ts          # Per-client WebSocket session management
    └── frontend/               # React + Vite + lightweight-charts
        └── src/
            ├── App.tsx
            ├── hooks/
            │   ├── useMarketStream.ts     # WebSocket hook with auto-reconnect
            │   ├── useHistoricalBars.ts   # REST fetch with AbortController
            │   └── useSymbolSearch.ts     # Debounced IBKR symbol search
            ├── components/
            │   ├── Chart/
            │   │   ├── ChartContainer.tsx # lightweight-charts init, ResizeObserver
            │   │   ├── IndicatorPanel.tsx # SMA/EMA toggle UI
            │   │   └── PriceDisplay.tsx   # OHLCV overlay
            │   ├── Toolbar/
            │   │   ├── SymbolSearch.tsx   # Keyboard-navigable symbol picker
            │   │   └── TimeframeSelector.tsx
            │   └── StatusBar.tsx          # Bid/ask, IBKR connection status
            └── lib/
                ├── chartTheme.ts          # lightweight-charts dark theme
                └── indicators.ts          # SMA, EMA, EMA append for live updates
```

**Data flow:**
```
IBKR TWS/Gateway (TCP)
  → @stoqey/ib (Node.js socket client)
    → IBKRService (singleton, reconnects)
      → MarketDataService
        ├─ REST: GET /api/bars → historical candlestick data
        ├─ REST: GET /api/search → symbol search
        └─ WebSocket /ws
             → BarAggregator (5-sec RT bars → any timeframe)
               → WebSocketGateway → browser
                 → useMarketStream hook
                   → ChartContainer (lightweight-charts)
```

**Key technical decisions:**

- **`@stoqey/ib`** — pure Node.js TWS API wrapper, no Python bridge required
- **5-second RT bars + BarAggregator** — more reliable across equities, futures, and forex than raw tick subscriptions; aggregated server-side to any timeframe
- **Singleton services** — single IBKR connection shared across all services and WebSocket clients
- **Per-client WebSocket sessions** — each browser tab manages its own subscription independently
- **Vite proxy** — in development, `/api` and `/ws` proxy to `:3001`, no CORS config needed
- **Shared types package** — `Bar`, `Tick`, `WsServerMsg` etc. are the single source of truth for both ends of the wire

---

## Prerequisites

- Node.js 20+
- Interactive Brokers account (paper or live)
- TWS (Trader Workstation) or IB Gateway running locally

---

## TWS / IB Gateway Setup

**This is required before the backend can connect.**

### In TWS:
1. Open TWS → **Edit** → **Global Configuration** → **API** → **Settings**
2. Check **"Enable ActiveX and Socket Clients"**
3. Set **Socket port**: `7497` (paper) or `7496` (live)
4. Check **"Allow connections from localhost (127.0.0.1)"**
5. Uncheck **"Read-Only API"** if you want order capabilities later
6. Click **OK** and restart TWS if prompted

### In IB Gateway:
1. Launch IB Gateway, log in
2. **Configure** → **API** → **Settings**
3. Socket port: `4002` (paper) or `4001` (live)
4. Allow connections from localhost
5. Click **OK**

### Firewall / permissions note
TWS pops an **"Accept incoming connection?"** dialog the first time this backend connects. You must click **Accept** (or enable auto-accept in TWS settings).

---

## Desktop app (pre-built)

You don't need to build anything to just *use* the app — grab an installer from
the [Releases page](https://github.com/jbanman10/ibkr-charting-app/releases).
TWS or IB Gateway must already be running with the API enabled (see above)
before you launch it.

### macOS

Open the `.dmg` and drag **IBKR Chart** to Applications. One universal build
runs natively on both Apple Silicon and Intel.

The app is **not signed with an Apple Developer ID**, so macOS blocks it on
first open. Either right-click the app and choose **Open** (then confirm in the
dialog), or clear the download quarantine flag once:

```bash
xattr -dr com.apple.quarantine "/Applications/IBKR Chart.app"
```

Defaults are paper trading on port 7497. To point it somewhere else, edit:

```
~/Library/Application Support/@ibkr-chart/desktop/config.json
```

| `IBKR_PORT` | |
|---|---|
| `7497` | TWS paper *(default)* |
| `7496` | TWS live |
| `4002` | IB Gateway paper |
| `4001` | IB Gateway live |

`IBKR_HOST` and `IBKR_CLIENT_ID` live in the same file. Give each machine its
own client id if more than one connects to the same TWS.

### Windows

Run the NSIS installer. The equivalent config file is at
`%APPDATA%\@ibkr-chart\desktop\config.json`, and the backend logs next to it in
`backend.log`.

---

## Installation & Running (from source)

```bash
# 1. Clone and install all packages
git clone https://github.com/jbanman10/ibkr-charting-app.git
cd ibkr-charting-app
npm install

# 2. Configure backend
cp apps/backend/.env.example apps/backend/.env
# Edit .env — set IBKR_PORT to match your TWS/Gateway setting

# 3. Start everything (backend + frontend concurrently)
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001
- WebSocket: ws://localhost:3001/ws
- Status check: http://localhost:3001/api/status

---

## REST API Reference

### `GET /api/status`
Returns IBKR connection state and server uptime.
```json
{ "ibkr": "connected", "uptime": 42.3, "timestamp": 1718000000000 }
```

### `GET /api/bars`
Fetches historical candlestick data.

| Param | Default | Example |
|---|---|---|
| `symbol` | required | `AAPL`, `TSLA`, `ESM4` |
| `secType` | `STK` | `STK`, `FUT`, `CASH`, `IND` |
| `exchange` | `SMART` | `SMART`, `NYSE`, `CME` |
| `currency` | `USD` | `USD`, `EUR` |
| `timeframe` | `1d` | `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d`, `1w` |

```bash
curl "http://localhost:3001/api/bars?symbol=AAPL&timeframe=1h"
```

### `GET /api/search`
Searches IBKR for matching contracts.
```bash
curl "http://localhost:3001/api/search?q=TSLA"
```

---

## WebSocket Protocol

Connect to `ws://localhost:3001/ws`.

### Subscribe (client → server)
```json
{
  "type": "subscribe",
  "symbol": "AAPL",
  "secType": "STK",
  "exchange": "SMART",
  "currency": "USD",
  "timeframe": "5m"
}
```

### Unsubscribe
```json
{ "type": "unsubscribe", "symbol": "AAPL" }
```

### Server → client messages
| `type` | When |
|---|---|
| `status` | IBKR connects/disconnects |
| `bar_update` | Every 5 seconds (live bar still forming) |
| `bar_close` | When a bar's time window closes |
| `tick` | Bid/ask/last tick |
| `error` | IBKR API errors |

---

## Supported Instruments

| Type | Example symbols |
|---|---|
| US Stocks | `AAPL`, `TSLA`, `MSFT`, `NVDA` |
| Futures | `ES` (S&P 500), `NQ` (Nasdaq), `CL` (Crude Oil), `GC` (Gold) |
| Forex | `EUR` (EURUSD), `GBP`, `JPY` — secType=CASH, exchange=IDEALPRO |
| Indices | `SPX`, `NDX` — secType=IND, exchange=CBOE |

**For futures**, set `secType=FUT` and `exchange=CME` (or appropriate exchange). IBKR will select the front-month contract automatically via `exchange=SMART` in most cases.

---

## UI Keyboard Shortcuts

| Key | Action |
|---|---|
| `/` or `Cmd+K` | Open symbol search |
| `↑` / `↓` | Navigate search results |
| `Enter` | Select symbol |
| `Escape` | Close search |
| Mouse wheel | Zoom chart |
| Click + drag | Pan chart |
| Double-click price scale | Fit content |

---

## Adding Indicators

Indicators are toggled in the sidebar panel (click the indicator button in the toolbar).

Available presets: SMA 20, SMA 50, SMA 200, EMA 20, EMA 50.

To add a custom indicator programmatically, extend `PRESETS` in `IndicatorPanel.tsx` and add a color mapping in `chartTheme.ts → indicatorColors`.

---

## Troubleshooting

**"IBKR not connected" in status bar**
- Check TWS/Gateway is running and API is enabled
- Verify `IBKR_PORT` in `.env` matches TWS socket port
- Check TWS didn't block the connection (look for the "Accept connection" popup)

**Historical data returns empty / times out**
- Market may be closed — try symbol `AAPL` on a weekday
- Some data requires market data subscriptions in IBKR
- Check TWS logs: **Help** → **Log API messages**

**"Max reconnect attempts reached"**
- Restart the backend: `npm run dev --workspace=apps/backend`
- Check TWS hasn't restarted on a different port

**Real-time bars not appearing**
- 5-second RT bars require an active market data subscription in TWS
- During extended hours, useRTH=true filters to regular session only. Set to `false` in `market-data.service.ts` line ~102 if needed.

**TypeScript path errors**
```bash
npm run build --workspace=packages/types
```
Build the types package first — the monorepo references it as a composite project.

---

## Production Deployment

```bash
# Build all packages
npm run build

# Start backend
cd apps/backend && node dist/server.js

# Serve frontend (after build, serve apps/frontend/dist as static files)
# e.g. with nginx, or:
npx serve apps/frontend/dist -p 8080
```

Set `NODE_ENV=production` in the backend `.env` to disable pino-pretty and enable structured JSON logging.

---

## License

MIT
