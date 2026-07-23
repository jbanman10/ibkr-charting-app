import type { Bar, IndicatorConfig } from '@ibkr-chart/types';
import type { LineData, Time } from 'lightweight-charts';

const DAILY_TF = new Set(['1d', '1w']);

/** Stable per-indicator key. Daily-source MAs get a `-D` suffix so a daily
 *  200 and a chart 200 never collide (settings/toggle/render all key on this). */
export function indicatorKey(cfg: { type: string; period: number; source?: string }): string {
  return cfg.source === 'daily' ? `${cfg.type}-${cfg.period}-D` : `${cfg.type}-${cfg.period}`;
}
function toChartTime(unix: number | string, isDaily: boolean): Time {
  // Daily bars already arrive as "YYYY-MM-DD" strings — pass them through.
  // (Multiplying that string by 1000 yields NaN → "NaN-NaN-NaN".)
  if (typeof unix === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(unix)) {
    return unix as Time;
  }
  if (isDaily) {
    const d = new Date(Number(unix) * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}` as Time;
  }
  return unix as unknown as Time;
}


/** Simple Moving Average */
export function calcSMA(bars: Bar[], period: number, timeframe = '1d'): LineData[] {
  if (bars.length < period) return [];
  const result: LineData[] = [];

  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += bars[j].close;
    }
    result.push({
      time: toChartTime(bars[i].time, DAILY_TF.has(timeframe)),
      value: sum / period,
    });
  }
  return result;
}

/** Exponential Moving Average */
export function calcEMA(bars: Bar[], period: number, timeframe = '1d'): LineData[] {
  if (bars.length < period) return [];
  const result: LineData[] = [];
  const multiplier = 2 / (period + 1);

  // Seed with SMA of first `period` bars
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += bars[i].close;
  }
  ema /= period;
  result.push({ time: toChartTime(bars[period - 1].time, DAILY_TF.has(timeframe)), value: ema });

  for (let i = period; i < bars.length; i++) {
    ema = (bars[i].close - ema) * multiplier + ema;
    result.push({ time: toChartTime(bars[i].time, DAILY_TF.has(timeframe)), value: ema });
  }
  return result;
}

/** Append a single new bar/close price to an existing EMA series (for live updates) */
export function appendEMA(
  prevEMA: number,
  newClose: number,
  period: number
): number {
  const multiplier = 2 / (period + 1);
  return (newClose - prevEMA) * multiplier + prevEMA;
}

export type IndicatorSeries = {
  key: string; // e.g. "SMA-20", "EMA-50"
  data: LineData[];
  color?: string;
  lineWidth?: number;
  // Keep this line out of the price scale's auto-range. Daily MAs projected
  // onto an intraday chart sit far from the intraday range (a 200-day MA can be
  // 15% below price) and would otherwise zoom the candles into a sliver.
  noAutoscale?: boolean;
};

export function computeIndicators(
  bars: Bar[],
  configs: Array<{ type: 'SMA' | 'EMA'; period: number; color?: string; lineWidth?: number }>,
  timeframe = '1d'
): IndicatorSeries[] {
  return configs.map((cfg) => ({
    key: `${cfg.type}-${cfg.period}`,
    data: cfg.type === 'SMA' ? calcSMA(bars, cfg.period, timeframe) : calcEMA(bars, cfg.period, timeframe),
    color: cfg.color,
    lineWidth: cfg.lineWidth,
  }));
}

// ─── Daily (multi-timeframe) MAs projected onto the panel's timeframe ─────────

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // → YYYY-MM-DD

/** The trading day (YYYY-MM-DD) a DAILY bar represents. Daily bar times are
 *  UTC-midnight of that date, so read the date in UTC (ET-formatting a UTC
 *  midnight would slip to the previous day). */
function dailyBarDay(b: Bar): string {
  const t = b.time as unknown;
  if (typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(Number(t) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** The ET trading day of any timestamp (used for intraday panel bars). */
function etDay(unixSec: number): string {
  return ET_DAY.format(new Date(unixSec * 1000));
}

function maByDay(closes: number[], days: string[], type: 'SMA' | 'EMA', period: number): Map<string, number> {
  const out = new Map<string, number>();
  if (closes.length < period) return out;
  if (type === 'SMA') {
    for (let i = period - 1; i < closes.length; i++) {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      out.set(days[i], sum / period);
    }
  } else {
    const mult = 2 / (period + 1);
    let ema = 0;
    for (let i = 0; i < period; i++) ema += closes[i];
    ema /= period;
    out.set(days[period - 1], ema);
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * mult + ema;
      out.set(days[i], ema);
    }
  }
  return out;
}

/**
 * Compute daily-source MAs and map each day's value onto the panel's bars,
 * producing a stepped line (flat within a day, jumps at the day boundary).
 * Today's daily close is replaced by the live price so the level reacts
 * intraday. Values carry forward across any day missing from the daily set.
 */
export function computeDailyIndicators(
  panelBars: Bar[],
  dailyBars: Bar[],
  configs: IndicatorConfig[],
  panelTimeframe: string,
  livePrice: number | null,
): IndicatorSeries[] {
  if (!panelBars.length || !dailyBars.length || !configs.length) return [];
  const isDaily = DAILY_TF.has(panelTimeframe);

  // Daily (day, close) rows, with today's close overridden by the live price so
  // the projected level moves with price (and today exists even pre-open).
  const rows = dailyBars
    .filter((b) => Number(b.close) > 0)
    .map((b) => ({ day: dailyBarDay(b), close: Number(b.close) }));
  if (livePrice != null && livePrice > 0) {
    const todayStr = etDay(Math.floor(Date.now() / 1000));
    if (rows.length && rows[rows.length - 1].day === todayStr) {
      rows[rows.length - 1] = { day: todayStr, close: livePrice };
    } else {
      rows.push({ day: todayStr, close: livePrice });
    }
  }
  const closes = rows.map((r) => r.close);
  const days = rows.map((r) => r.day);

  const panelBarDay = (b: Bar) => (isDaily ? dailyBarDay(b) : etDay(Number(b.time)));

  return configs.map((cfg) => {
    const byDay = maByDay(closes, days, cfg.type, cfg.period);
    const data: LineData[] = [];
    let carried: number | null = null;
    for (const b of panelBars) {
      const v = byDay.get(panelBarDay(b));
      if (v != null) carried = v;
      if (carried == null) continue; // before the MA has enough history
      data.push({ time: toChartTime(b.time, isDaily), value: carried });
    }
    // On intraday charts the daily level sits far from the visible range, so it
    // must not drive the price scale (on a daily chart it's a normal MA).
    return { key: indicatorKey(cfg), data, color: cfg.color, lineWidth: cfg.lineWidth, noAutoscale: !isDaily };
  });
}
