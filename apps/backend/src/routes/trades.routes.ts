/**
 * Trade journal endpoints — matched round-trips, not raw fills.
 *
 *   GET /api/trades/summary?from=&to=   per-day aggregates for the calendar
 *   GET /api/trades/day/:date           the individual trades closed that day
 *   GET /api/trades/stats?from=&to=     analytics for the stats tab
 *
 * All date parameters and all returned day keys are ET calendar dates, and a
 * trade is booked on the date it CLOSED (where its realized P&L lands, matching
 * IBKR's own statements). The matching itself lives in lib/tradeMatcher.ts and
 * knows nothing about HTTP.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  MatchedTrade,
  TradeStatsResponse,
  TradesDayResponse,
  TradesSummaryResponse,
} from '@ibkr-chart/types';
import { TradesService } from '../services/trades.service.js';
import { FlexService } from '../services/flex.service.js';
import { IBKRService } from '../services/ibkr.service.js';
import { summarizeByDay, maxConsecutiveDays } from '../lib/tradeMatcher.js';
import { etDay, etDayOfWeek, etHour } from '../lib/etTime.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const RangeSchema = z.object({
  from: z.string().regex(DATE).optional(),
  to: z.string().regex(DATE).optional(),
});

const DateParamSchema = z.object({
  date: z.string().regex(DATE),
});

/** Default window: the trailing year, which is also Flex's practical limit. */
function defaultRange(): { from: string; to: string } {
  const today = etDay();
  const from = etDay(Math.floor(Date.now() / 1000) - 365 * 86_400);
  return { from, to: today };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Build the stats payload from a set of matched trades. */
export function buildStats(trades: MatchedTrade[], from: string, to: string): TradeStatsResponse {
  const days = summarizeByDay(trades);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);

  // ─ Day of week (0 = Sunday), bucketed on the CLOSE date ─
  const dow = Array.from({ length: 7 }, (_, day) => ({ day, pnl: 0, trades: 0, wins: 0 }));
  for (const t of trades) {
    const b = dow[etDayOfWeek(t.date)];
    b.pnl += t.pnl;
    b.trades++;
    if (t.pnl > 0) b.wins++;
  }

  // ─ Hour of day, bucketed on the ENTRY time (when the decision was made) ─
  const hours = new Map<number, { hour: number; pnl: number; trades: number; wins: number }>();
  for (const t of trades) {
    const h = etHour(t.entryTime);
    const b = hours.get(h) ?? { hour: h, pnl: 0, trades: 0, wins: 0 };
    b.pnl += t.pnl;
    b.trades++;
    if (t.pnl > 0) b.wins++;
    hours.set(h, b);
  }

  // ─ Symbol / underlying ─
  const symbols = new Map<string, { symbol: string; pnl: number; trades: number; wins: number; volume: number }>();
  for (const t of trades) {
    const b = symbols.get(t.symbol) ?? { symbol: t.symbol, pnl: 0, trades: 0, wins: 0, volume: 0 };
    b.pnl += t.pnl;
    b.trades++;
    b.volume += t.quantity;
    if (t.pnl > 0) b.wins++;
    symbols.set(t.symbol, b);
  }

  const ranked = [...days].sort((a, b) => b.pnl - a.pnl);

  return {
    from,
    to,
    totals: {
      pnl: round2(pnl),
      trades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? round2((wins.length / trades.length) * 100) : null,
      avgWin: wins.length ? round2(grossWin / wins.length) : null,
      avgLoss: losses.length ? round2(grossLoss / losses.length) : null,
      profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : null,
      expectancy: trades.length ? round2(pnl / trades.length) : null,
      commissions: round2(trades.reduce((a, t) => a + t.commission, 0)),
    },
    byDayOfWeek: dow.map((b) => ({ ...b, pnl: round2(b.pnl) })),
    byHour: [...hours.values()].sort((a, b) => a.hour - b.hour).map((b) => ({ ...b, pnl: round2(b.pnl) })),
    bySymbol: [...symbols.values()].sort((a, b) => b.pnl - a.pnl).map((b) => ({ ...b, pnl: round2(b.pnl) })),
    maxConsecutiveLosingDays: maxConsecutiveDays(days, 'loss'),
    maxConsecutiveWinningDays: maxConsecutiveDays(days, 'win'),
    bestDay: ranked.length ? { date: ranked[0].date, pnl: ranked[0].pnl } : null,
    worstDay: ranked.length ? { date: ranked[ranked.length - 1].date, pnl: ranked[ranked.length - 1].pnl } : null,
  };
}

export async function registerTradesRoutes(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const trades = TradesService.getInstance(ibkr, app.log as any);
  const flex = FlexService.getInstance(app.log as any);

  // ─── Per-day aggregates (the calendar) ───────────────────────────────────────
  app.get('/api/trades/summary', async (request, reply) => {
    const parsed = RangeSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'from/to must be YYYY-MM-DD' });
    }
    const { from, to } = { ...defaultRange(), ...stripUndefined(parsed.data) };
    if (from > to) return reply.status(400).send({ error: '"from" is after "to"' });

    const [{ days, detailAvailable }, cfg, cache] = await Promise.all([
      trades.getAll(),
      flex.getConfig(),
      flex.getTrades(),
    ]);

    return {
      days: days.filter((d) => d.date >= from && d.date <= to),
      from,
      to,
      syncedAt: cache.syncedAt,
      flexConfigured: cfg.configured,
      detailAvailable,
    } satisfies TradesSummaryResponse;
  });

  // ─── One day's matched trades (the drill-down) ───────────────────────────────
  app.get('/api/trades/day/:date', async (request, reply) => {
    const parsed = DateParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    }
    const { date } = parsed.data;
    const dayTrades = await trades.getTradesForDay(date);
    const [summary] = summarizeByDay(dayTrades);

    return { date, trades: dayTrades, summary: summary ?? null } satisfies TradesDayResponse;
  });

  // ─── Analytics (the stats tab) ───────────────────────────────────────────────
  app.get('/api/trades/stats', async (request, reply) => {
    const parsed = RangeSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'from/to must be YYYY-MM-DD' });
    }
    const { from, to } = { ...defaultRange(), ...stripUndefined(parsed.data) };
    if (from > to) return reply.status(400).send({ error: '"from" is after "to"' });

    return buildStats(await trades.getTradesInRange(from, to), from, to);
  });
}

/** Zod leaves absent optionals as explicit `undefined`, which would clobber the
 * defaults when spread. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
