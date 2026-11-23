import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Timeframe, SecType, Quote } from '@ibkr-chart/types';
import { TIMEFRAMES, RESYNC_DURATIONS } from '@ibkr-chart/types';
import { MarketDataService } from '../services/market-data.service.js';
import { ExecutionsService } from '../services/executions.service.js';
import { IBKRService } from '../services/ibkr.service.js';
import { rvolFor, etDay } from '../lib/rvol.js';

const timeframeValues = Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]];

// ─── Watchlist quotes ─────────────────────────────────────────────────────────

/** A daily bar's time is UTC MIDNIGHT of its trading date (`parseIBKRDate`), so
 *  its date has to be read in UTC — reading it in ET lands a whole day early. */
const utcDay = (unixSec: number) => new Date(unixSec * 1000).toISOString().slice(0, 10);

/**
 * Previous RTH close + today's cumulative volume for one symbol.
 *
 * DAILY bars, not two days of 1-minute bars. The watchlist takes the live
 * `last` from the WS quote stream and only needs prevClose and today's volume
 * from here — a daily series carries both in a handful of bars.
 *
 * The 1-minute version pulled ~1,600 bars per symbol AND, because it asked for
 * extended hours, a second BID_ASK leg for the NBBO clamp. On a 14-symbol
 * watchlist that was 28 small-bar requests per poll per window, against IBKR's
 * documented 60-per-10-minutes for small bars (BID_ASK counting twice). It
 * worked while IBKR's soft throttle tolerated it, and on a heavy day it buried
 * the shared historical queue instead — chart snapshots queued behind it and
 * took 20-40s, which is what "charts not loading" actually was. Daily bars are
 * one request of a few bars, need no BID_ASK leg, and are outside the small-bar
 * pacing rules entirely.
 */
async function fetchQuote(marketData: MarketDataService, symbol: string): Promise<Quote> {
  const contract = MarketDataService.toIBContract(symbol, 'STK', 'SMART', 'USD');
  const bars = await marketData.fetchRecentDailyBars(contract, 5);
  if (bars.length < 2) throw new Error(`no daily bars for ${symbol}`);

  const lastBar = bars[bars.length - 1];
  const hasTodayBar = utcDay(Number(lastBar.time)) === etDay();

  // Before the RTH open there is no bar for today yet: nothing has traded this
  // session, so today's volume is 0 and the newest bar IS the previous close.
  const prevClose = Number(hasTodayBar ? bars[bars.length - 2].close : lastBar.close);
  if (!(prevClose > 0)) throw new Error(`no previous close for ${symbol}`);

  // Before the open there is no RTH bar yet, and a daily bar carries RTH volume
  // only — so pre-market volume (and the RVOL built on it, which this app
  // deliberately supports pre-market) would read as a flat zero. Sum one short
  // intraday window instead. This costs an extra request, but ONLY outside
  // regular hours, which is exactly when nothing else is competing for the
  // queue. During RTH the daily bar already has the number.
  let volume = hasTodayBar ? Number(lastBar.volume) || 0 : 0;
  if (!hasTodayBar) {
    try {
      // One day of 5-minute bars (~190), not two days of 1-minute bars (~1,600).
      const intraday = await marketData.fetchHistoricalBars(contract, '5m', 0, undefined, '1 D');
      const today = etDay();
      volume = intraday
        .filter((b) => etDay(Number(b.time)) === today)
        .reduce((a, b) => a + (Number(b.volume) || 0), 0);
    } catch { /* leave at 0 — a missing pre-market tally must not fail the quote */ }
  }

  const last = Number(lastBar.close);
  const change = last - prevClose;
  return { symbol, last, prevClose, change, changePct: (change / prevClose) * 100, volume };
}

// Per-symbol cache. Several windows polling the same watchlist otherwise each
// pay for every symbol, doubling the load for no new information — these values
// move slowly and the frontend polls each window every 60s, so a short TTL is
// invisible. The live price does not come from here at all.
const QUOTE_TTL_MS = 30_000;
const quoteCache = new Map<string, { at: number; quote: Quote & { rvol?: number } }>();

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
  primaryExchange: z.string().optional(),
  // Unix seconds. Requests the window ENDING here instead of "now" — used by
  // the trade journal to load a past session's intraday chart.
  end:       z.coerce.number().int().positive().optional(),
  // 'recent' serves only the live edge (RESYNC_DURATIONS) instead of the
  // timeframe's full window. The chart's periodic re-sync uses it: it repairs
  // late prints near the right edge and has no reason to re-download months of
  // settled history every few minutes. Defaults to the full window so every
  // other caller is unchanged.
  scope:     z.enum(['full', 'recent']).default('full'),
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

    const { symbol, secType, exchange, currency, timeframe, useRTH, primaryExchange, end, scope } = parsed.data;

    if (!ibkr.isConnected) {
      return reply.status(503).send({ error: 'IBKR not connected' });
    }

    try {
      const contract = MarketDataService.toIBContract(symbol, secType as SecType, exchange, currency, primaryExchange);
      const duration = scope === 'recent' ? RESYNC_DURATIONS[timeframe] : undefined;
      const bars = await marketData.fetchHistoricalBars(contract, timeframe, useRTH as 0 | 1, end, duration);
      app.log.info({ symbol, timeframe, useRTH, end, scope, count: bars.length }, 'Bars served');
      return { symbol, timeframe, useRTH, bars };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      app.log.error({ err, symbol, timeframe }, 'Historical bars failed');
      return reply.status(500).send({ error: message });
    }
  });

  // ─── Account executions (fills — entry/exit chart arrows) ──────────────────────
  app.get('/api/executions', async () => {
    const executions = await ExecutionsService.getInstance(ibkr, app.log as any).getExecutions();
    return { executions };
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
      const hit = quoteCache.get(sym);
      if (hit && Date.now() - hit.at < QUOTE_TTL_MS) { quotes.push(hit.quote); continue; }
      try {
        const q = await fetchQuote(marketData, sym);
        // Session-adjusted RVOL (works pre-market too). 10-day averages are
        // day-cached, so this costs one extra request per symbol per day.
        const rvol = await rvolFor(marketData, sym, q.volume, app.log as any);
        const full = rvol != null ? { ...q, rvol } : q;
        quoteCache.set(sym, { at: Date.now(), quote: full });
        quotes.push(full);
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
