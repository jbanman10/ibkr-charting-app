/**
 * P&L calendar endpoints.
 *
 *   GET  /api/pnl/calendar  → per-day realized P&L, trade count and win count
 *   POST /api/pnl/sync      → pull a fresh Flex statement
 *   GET  /api/pnl/flex      → is Flex configured? (never returns the token)
 *   PUT  /api/pnl/flex      → save the Flex token + query id
 *
 * History comes from the Flex Web Service (the TWS API only serves the current
 * day). Today's trades come from the locally collected executions, so the
 * calendar is live during the session and Flex fills in the authoritative
 * numbers once IBKR publishes the statement — Flex wins for any date it covers.
 *
 * A "trade" is a round-trip grouped per (day, symbol): closing fills on the
 * same underlying on the same day count once, which matches how a trader reads
 * "I traded AAPL today", and is what the win rate is computed over.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DailyPnl } from '@ibkr-chart/types';
import { FlexService } from '../services/flex.service.js';
import { ExecutionsService } from '../services/executions.service.js';
import { IBKRService } from '../services/ibkr.service.js';

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const etDay = (unixSec: number) => ET_DATE.format(new Date(unixSec * 1000));

const FlexConfigSchema = z.object({
  token: z.string().min(4).max(120),
  queryId: z.string().min(1).max(40),
});

/** Fold rows into per-day totals, grouping round-trips by symbol. */
interface Bucket {
  pnl: number;
  commissions: number;
  bySymbol: Map<string, number>; // symbol → net realized P&L for the day
}

function emptyBucket(): Bucket {
  return { pnl: 0, commissions: 0, bySymbol: new Map() };
}

function toDaily(buckets: Map<string, Bucket>, source: DailyPnl['source']): DailyPnl[] {
  const out: DailyPnl[] = [];
  for (const [date, b] of buckets) {
    // Only symbols that actually realized something count as a round-trip;
    // opening-only activity isn't a completed trade.
    const closed = [...b.bySymbol.values()].filter((v) => v !== 0);
    // Days with no P&L and no completed trades carry no information (e.g. fills
    // recorded before commission reports were captured) — leave them out so the
    // calendar shows them as blank rather than a misleading "$0".
    if (!closed.length && Math.abs(b.pnl) < 0.005) continue;
    out.push({
      date,
      pnl: Number(b.pnl.toFixed(2)),
      trades: closed.length,
      wins: closed.filter((v) => v > 0).length,
      commissions: Number(b.commissions.toFixed(2)),
      grossWin: Number(closed.filter((v) => v > 0).reduce((a, v) => a + v, 0).toFixed(2)),
      grossLoss: Number(closed.filter((v) => v < 0).reduce((a, v) => a + v, 0).toFixed(2)),
      source,
    });
  }
  return out;
}

export async function registerPnlRoutes(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const flex = FlexService.getInstance(app.log as any);

  app.get('/api/pnl/flex', async () => flex.getConfig());

  app.put('/api/pnl/flex', async (request, reply) => {
    const parsed = FlexConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'token and queryId are required' });
    }
    await flex.setConfig(parsed.data);
    const result = await flex.sync(); // validate the credentials immediately
    return { saved: true, ...result };
  });

  app.post('/api/pnl/sync', async () => flex.sync());

  app.get('/api/pnl/calendar', async () => {
    const [{ trades, syncedAt }, cfg] = await Promise.all([flex.getTrades(), flex.getConfig()]);

    // ─ Flex history (authoritative) ─
    const flexDays = new Map<string, Bucket>();
    for (const t of trades) {
      const b = flexDays.get(t.date) ?? emptyBucket();
      const net = t.realizedPnl - t.commission;
      b.pnl += net;
      b.commissions += t.commission;
      if (t.realizedPnl !== 0) {
        b.bySymbol.set(t.symbol, (b.bySymbol.get(t.symbol) ?? 0) + net);
      }
      flexDays.set(t.date, b);
    }

    // ─ Locally collected fills (covers today / anything Flex hasn't published) ─
    const localDays = new Map<string, Bucket>();
    try {
      const execs = await ExecutionsService.getInstance(ibkr, app.log as any).getExecutions();
      for (const e of execs) {
        const date = etDay(e.time);
        const b = localDays.get(date) ?? emptyBucket();
        const commission = e.commission ?? 0;
        const realized = e.realizedPnl ?? 0;
        b.pnl += realized - commission;
        b.commissions += commission;
        if (realized !== 0) {
          b.bySymbol.set(e.symbol, (b.bySymbol.get(e.symbol) ?? 0) + (realized - commission));
        }
        localDays.set(date, b);
      }
    } catch (err) {
      app.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'local executions unavailable');
    }

    // Flex wins wherever it has the day; local fills the rest.
    const days = toDaily(flexDays, 'flex');
    const covered = new Set(days.map((d) => d.date));
    for (const d of toDaily(localDays, 'local')) {
      if (!covered.has(d.date)) days.push(d);
    }
    days.sort((a, b) => a.date.localeCompare(b.date));

    return { days, syncedAt, flexConfigured: cfg.configured };
  });
}
