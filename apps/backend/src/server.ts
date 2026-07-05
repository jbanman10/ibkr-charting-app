import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { config } from './config.js';
import { IBKRService } from './services/ibkr.service.js';
import { MarketDataService } from './services/market-data.service.js';
import { WebSocketGateway } from './services/ws.gateway.js';
import { registerRoutes } from './routes/api.routes.js';
import { registerSummaryRoutes } from './routes/summary.routes.js';
import { registerWsRoute } from './routes/ws.routes.js';

// ─── Logger setup — pino-pretty only if it's available, plain JSON otherwise ─

let loggerOptions: object = { level: process.env.LOG_LEVEL ?? 'info' };

if (process.env.NODE_ENV !== 'production') {
  try {
    // Try to use pino-pretty for readable dev output
    loggerOptions = {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    };
  } catch {
    // Fall back to plain JSON if pino-pretty isn't available
  }
}

const app = Fastify({ logger: loggerOptions });

async function bootstrap(): Promise<void> {
  // ─── Plugins ────────────────────────────────────────────────────────────────
  await app.register(cors, {
    origin: config.server.corsOrigin,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  await app.register(websocket);

  // ─── Services ────────────────────────────────────────────────────────────────
  const ibkr = IBKRService.getInstance(app.log as any);
  const marketData = MarketDataService.getInstance(ibkr, app.log as any);
  WebSocketGateway.getInstance(ibkr, marketData, app.log as any);

  // ─── Routes ──────────────────────────────────────────────────────────────────
  await registerRoutes(app);
  await registerSummaryRoutes(app);
  await registerWsRoute(app);

  // ─── Static frontend (Electron / production) ──────────────────────────────────
  // When SERVE_STATIC is set, this one Fastify process also serves the built
  // frontend so the desktop windows load http://127.0.0.1:<port> and every
  // relative /api URL + the ws://<host>/ws URL keeps working unchanged.
  // API/WS routes are registered above, so they are never shadowed by static.
  if (process.env.SERVE_STATIC) {
    const frontendDist = process.env.FRONTEND_DIST ?? join(process.cwd(), 'frontend-dist');
    await app.register(fastifyStatic, { root: frontendDist });
    // SPA fallback: any non-API GET that didn't match a file returns index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
    app.log.info(`Serving static frontend from ${frontendDist}`);
  }

  // ─── Start ───────────────────────────────────────────────────────────────────
  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info(`Backend running on http://${config.server.host}:${config.server.port}`);

  // Connect to IBKR after server is up so health checks work immediately
  await ibkr.connect();
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down...');
  IBKRService.getInstance().disconnect();
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
