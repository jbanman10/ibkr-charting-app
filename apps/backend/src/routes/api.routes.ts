import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Timeframe, SecType } from '@ibkr-chart/types';
import { TIMEFRAMES } from '@ibkr-chart/types';
import { MarketDataService } from '../services/market-data.service.js';
import { IBKRService } from '../services/ibkr.service.js';

const timeframeValues = Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]];

const BarsQuerySchema = z.object({
  symbol:    z.string().min(1).max(20).toUpperCase(),
  secType:   z.enum(['STK', 'FUT', 'OPT', 'CASH', 'IND']).default('STK'),
  exchange:  z.string().default('SMART'),
  currency:  z.string().default('USD'),
  timeframe: z.enum(timeframeValues).default('1d'),
  useRTH:    z.coerce.number().int().min(0).max(1).default(0),
});

const SearchQuerySchema = z.object({
  q: z.string().min(1).max(50),
});

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const marketData = MarketDataService.getInstance(ibkr, app.log as any);

  // ─── Status ──────────────────────────────────────────────────────────────────
  app.get('/api/status', async () => ({
    ibkr: ibkr.state,
    uptime: process.uptime(),
    timestamp: Date.now(),
  }));

  // ─── Historical bars ──────────────────────────────────────────────────────────
  app.get('/api/bars', async (request, reply) => {
    const parsed = BarsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid query', details: parsed.error.format() });
    }

    const { symbol, secType, exchange, currency, timeframe, useRTH } = parsed.data;

    if (!ibkr.isConnected) {
      return reply.status(503).send({ error: 'IBKR not connected' });
    }

    try {
      const contract = MarketDataService.toIBContract(symbol, secType as SecType, exchange, currency);
      const bars = await marketData.fetchHistoricalBars(contract, timeframe, useRTH as 0 | 1);
      app.log.info({ symbol, timeframe, useRTH, count: bars.length }, 'Bars served');
      return { symbol, timeframe, useRTH, bars };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err, symbol, timeframe }, 'Historical bars failed');
      return reply.status(500).send({ error: message });
    }
  });

  // ─── Symbol search ────────────────────────────────────────────────────────────
  app.get('/api/search', async (request, reply) => {
    const parsed = SearchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Query parameter "q" is required' });
    }

    if (!ibkr.isConnected) {
      return reply.status(503).send({ error: 'IBKR not connected' });
    }

    try {
      const results = await marketData.searchContracts(parsed.data.q);
      return { results };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed';
      return reply.status(500).send({ error: message });
    }
  });
}
