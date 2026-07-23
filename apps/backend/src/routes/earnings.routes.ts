/**
 * Earnings endpoint.
 *
 * GET /api/earnings?symbol=AAPL → next earnings date + the last 4 reported
 * quarters (EPS vs consensus and the % surprise), for TradingView-style
 * earnings bubbles on the daily chart.
 *
 * IBKR's fundamentals (reqFundamentalData) require a Refinitiv subscription
 * this account doesn't have (error 10358), so this uses Nasdaq's free public
 * JSON — same approach as the morning summary's ForexFactory/CNBC feeds.
 * Cached for hours: earnings data changes at most once a quarter.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EarningsEvent, EarningsInfo } from '@ibkr-chart/types';

const CACHE_MS = 6 * 60 * 60_000; // 6h
const FETCH_TIMEOUT_MS = 12_000;
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ibkr-chart/1.0',
  accept: 'application/json',
};

const QuerySchema = z.object({ symbol: z.string().min(1).max(20).toUpperCase() });

const cache = new Map<string, { at: number; value: EarningsInfo }>();

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** "M/D/YYYY" → unix seconds at UTC midnight (matches daily bar times). */
function parseSlashDate(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** "Jul 30, 2026" → unix seconds at UTC midnight. */
function parseTextDate(s: string): number | null {
  const m = s.trim().match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo == null) return null;
  const ms = Date.UTC(Number(m[3]), mo, Number(m[2]));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchEarnings(symbol: string): Promise<EarningsInfo> {
  const [dateJson, surpriseJson] = await Promise.all([
    getJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(symbol)}/earnings-date`),
    getJson(`https://api.nasdaq.com/api/company/${encodeURIComponent(symbol)}/earnings-surprise`),
  ]);

  // ─ Next earnings date ─
  let next: EarningsInfo['next'] = null;
  const reportText: string = dateJson?.data?.reportText ?? '';
  const announcement: string = dateJson?.data?.announcement ?? '';
  const date =
    (reportText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/)?.[1] ? parseSlashDate(reportText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/)![1]) : null)
    ?? parseTextDate(announcement);
  if (date) {
    const timing = /after market close/i.test(reportText) ? 'after market close'
      : /before market open/i.test(reportText) ? 'before market open'
      : null;
    next = {
      date,
      timing,
      // Anchor the decimals so the sentence's trailing period isn't captured
      // ("$1.88." would parse as NaN).
      consensusEps: num(reportText.match(/consensus EPS forecast[^$\d-]*\$?\s*(-?\d+(?:\.\d+)?)/i)?.[1]),
      estimated: false,
    };
  }

  // ─ Last reported quarters ─
  const rows: any[] = surpriseJson?.data?.earningsSurpriseTable?.rows ?? [];
  const history: EarningsEvent[] = [];
  for (const r of rows) {
    const d = parseSlashDate(String(r?.dateReported ?? ''));
    if (!d) continue;
    history.push({
      date: d,
      fiscalQtr: String(r?.fiscalQtrEnd ?? ''),
      eps: num(r?.eps),
      consensus: num(r?.consensusForecast),
      surprisePct: num(r?.percentageSurprise),
    });
    if (history.length >= 4) break;
  }

  // The vendor often has no forward date for a quarter or two after a report
  // ("hasn't provided us with the upcoming earnings report date"). Project one
  // from the company's own reporting cadence so the chart still shows roughly
  // when the next print lands; it's replaced by the real date automatically as
  // soon as the vendor publishes it (estimated: false wins on the next fetch).
  if (!next && history.length >= 2) {
    const gaps: number[] = [];
    for (let i = 0; i < history.length - 1; i++) gaps.push(history[i].date - history[i + 1].date);
    gaps.sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    if (median > 45 * 86_400 && median < 200 * 86_400) {
      let projected = history[0].date + median;
      const today = Math.floor(Date.now() / 1000);
      // If we're already past the projection (a report we haven't seen yet),
      // roll forward a cadence at a time rather than showing a stale date.
      while (projected < today) projected += median;
      next = { date: projected, timing: null, consensusEps: null, estimated: true };
    }
  }

  return { symbol, next, history };
}

export async function registerEarningsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/earnings', async (request, reply) => {
    const parsed = QuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Query parameter "symbol" is required' });
    }
    const { symbol } = parsed.data;

    const hit = cache.get(symbol);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

    try {
      const info = await fetchEarnings(symbol);
      // Only cache a useful result so a transient upstream blip isn't pinned for 6h.
      if (info.next || info.history.length) cache.set(symbol, { at: Date.now(), value: info });
      return info;
    } catch (err) {
      app.log.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, 'earnings fetch failed');
      return { symbol, next: null, history: [] } satisfies EarningsInfo;
    }
  });
}
