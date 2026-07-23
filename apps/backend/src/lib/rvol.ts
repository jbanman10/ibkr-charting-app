/**
 * Shared RVOL math — used by the scanner route and the watchlist quotes.
 *
 * RVOL = today's cumulative volume ÷ (10-day average daily volume × the
 * fraction of a NORMAL day's volume expected by this time of day). Intraday
 * volume is U-shaped (heavy open, slow lunch, heavy close), so the expected
 * fraction follows a piecewise curve instead of linear elapsed time — "3×" at
 * 9:45 means genuinely 3× the stock's normal opening pace. Pre-market is
 * measured against a 2% floor.
 */

import type { Logger } from 'pino';
import { MarketDataService } from '../services/market-data.service.js';

const ET_HM = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

export const AVG_DAYS = 10;

/** ET calendar day ("YYYY-MM-DD") for a unix-seconds time (default: now). */
export function etDay(unixSec?: number): string {
  return ET_DATE.format(unixSec != null ? new Date(unixSec * 1000) : new Date());
}

/** Expected cumulative fraction of a normal day's volume by minute-of-day (ET). */
const VOLUME_CURVE: Array<[number, number]> = [
  [570, 0.0],   // 09:30 open
  [600, 0.15],  // 10:00
  [660, 0.28],  // 11:00
  [720, 0.38],  // 12:00
  [810, 0.50],  // 13:30
  [870, 0.60],  // 14:30
  [930, 0.78],  // 15:30
  [960, 1.0],   // 16:00 close
];

export function sessionFraction(): number {
  const [h, m] = ET_HM.format(new Date()).split(':').map(Number);
  const min = h * 60 + m;
  const FLOOR = 0.02; // pre-market / first minutes: avoid divide-by-~0 blowups
  if (min <= VOLUME_CURVE[0][0]) return FLOOR;
  for (let i = 1; i < VOLUME_CURVE.length; i++) {
    const [t1, f1] = VOLUME_CURVE[i];
    if (min <= t1) {
      const [t0, f0] = VOLUME_CURVE[i - 1];
      return Math.max(FLOOR, f0 + ((min - t0) / (t1 - t0)) * (f1 - f0));
    }
  }
  return 1;
}

// symbol → { day, avg } — the 10-day average only changes once per trading day,
// so each symbol costs one daily-bars request per day (shared app-wide).
const avgCache = new Map<string, { day: string; avg: number }>();

/** 10-day average daily volume (excluding today's partial bar), day-cached. */
export async function avgDailyVolume(
  marketData: MarketDataService,
  symbol: string,
  logger?: Logger
): Promise<number | null> {
  const today = ET_DATE.format(new Date());
  const hit = avgCache.get(symbol);
  if (hit && hit.day === today) return hit.avg;
  try {
    const contract = MarketDataService.toIBContract(symbol, 'STK', 'SMART', 'USD');
    const bars = await marketData.fetchRecentDailyBars(contract, AVG_DAYS + 3);
    if (bars.length < 3) return null;
    // Last bar is today (partial) — average the prior AVG_DAYS full sessions.
    const window = bars.slice(0, -1).slice(-AVG_DAYS);
    const avg = window.reduce((a, b) => a + (Number(b.volume) || 0), 0) / Math.max(1, window.length);
    if (!(avg > 0)) return null;
    avgCache.set(symbol, { day: today, avg });
    return avg;
  } catch (err) {
    logger?.warn({ symbol, err: err instanceof Error ? err.message : String(err) }, 'avgDailyVolume failed');
    return null;
  }
}

/** Session-adjusted RVOL for a symbol given today's cumulative volume. */
export async function rvolFor(
  marketData: MarketDataService,
  symbol: string,
  todayVolume: number,
  logger?: Logger
): Promise<number | null> {
  const avg = await avgDailyVolume(marketData, symbol, logger);
  if (avg == null) return null;
  return todayVolume / (avg * sessionFraction());
}
