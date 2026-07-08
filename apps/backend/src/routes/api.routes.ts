import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Timeframe, SecType, Quote } from '@ibkr-chart/types';
import { TIMEFRAMES } from '@ibkr-chart/types';
import { MarketDataService } from '../services/market-data.service.js';
import { IBKRService } from '../services/ibkr.service.js';

const timeframeValues = Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]];

// ─── Watchlist quote helpers (ET session math, mirrors summary.routes) ─────────

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ET_MIN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
});
const etDate = (unixSec: number) => ET_DATE.format(new Date(unixSec * 1000));
const etMinuteOfDay = (unixSec: number) => {
  const [h, m] = ET_MIN.format(new Date(unixSec * 1000)).split(':').map(Number);
  return h * 60 + m;
};
const RTH_CLOSE_MIN = 16 * 60;

// Last print, change vs previous RTH close, and today's cumulative volume —
// derived from 2 days of extended-hours 1-min bars (same source as the summary
// quotes). Serialized internally by the historical-request queue, so a batch of
// symbols never bursts against IBKR pacing.
async function fetchQuote(marketData: MarketDataService, symbol: string): Promise<Quote> {
  const contract = MarketDataService.toIBContract(symbol, 'STK', 'SMART', 'USD');
  const bars = await marketData.fetchHistoricalBars(contract, '1m', 0);
  if (!bars.length) throw new Error(`no bars for ${symbol}`);

  const lastBar = bars[bars.length - 1];
  const last = lastBar.close;
  const lastDate = etDate(Number(lastBar.time));

  // Walk backwards: sum today's volume, then the first pre-16:00 bar on an
  // earlier session is the previous close.
  let prevClose: number | null = null;
  let volume = 0;
  for (let i = bars.length - 1; i >= 0; i--) {
    const t = Number(bars[i].time);
    if (etDate(t) === lastDate) { volume += bars[i].volume || 0; continue; }
    if (etMinuteOfDay(t) < RTH_CLOSE_MIN) { prevClose = bars[i].close; break; }
  }
  if (prevClose == null) throw new Error(`no previous session found for ${symbol}`);

  const change = last - prevClose;
  return { symbol, last, prevClose, change, changePct: (change / prevClose) * 100, volume };
}

const QuotesQuerySchema = z.object({
  symbols: z.string().min(1).max(400), // comma-separated tickers
});

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

  // ─── Watchlist quotes (batch) ──────────────────────────────────────────────────
  app.get('/api/quotes', async (request, reply) => {
    const parsed = QuotesQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Query parameter "symbols" is required' });
    }
    if (!ibkr.isConnected) {
      return reply.status(503).send({ error: 'IBKR not connected' });
    }

    const symbols = [...new Set(
      parsed.data.symbols.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    )].slice(0, 50);

    const quotes = [];
    for (const sym of symbols) {
      try {
        quotes.push(await fetchQuote(marketData, sym));
      } catch (err) {
        quotes.push({ symbol: sym, error: err instanceof Error ? err.message : 'failed' });
      }
    }
    return { quotes };
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
