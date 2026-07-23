// Central config — all values read from env with safe defaults.
// Copy .env.example to .env and edit before running.

export const config = {
  server: {
    host: process.env.HOST ?? '0.0.0.0',
    // Dedicated var so generic PORT injection (preview/dev tooling, PaaS) can't
    // hijack the backend onto the frontend's port. Vite proxy targets 3001.
    port: parseInt(process.env.BACKEND_PORT ?? '3001', 10),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  },
  ibkr: {
    // TWS paper trading default: 7497 | TWS live: 7496
    // IB Gateway paper: 4002  | IB Gateway live: 4001
    host: process.env.IBKR_HOST ?? '127.0.0.1',
    port: parseInt(process.env.IBKR_PORT ?? '7497', 10),
    clientId: parseInt(process.env.IBKR_CLIENT_ID ?? '1', 10),
    reconnectDelay: parseInt(process.env.IBKR_RECONNECT_DELAY ?? '5000', 10),
    maxReconnectAttempts: parseInt(process.env.IBKR_MAX_RECONNECTS ?? '10', 10),
  },
  // How many req IDs to reserve for historical data requests
  reqId: {
    historicalBase: 1000,
    streamBase: 2000,
    searchBase: 3000,
    execBase: 4000,
    scanBase: 5000,
  },
} as const;
