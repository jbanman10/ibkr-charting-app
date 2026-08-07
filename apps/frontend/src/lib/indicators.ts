import type { Bar, IndicatorConfig } from '@ibkr-chart/types';
import type { LineData, Time } from 'lightweight-charts';

const DAILY_TF = new Set(['1d', '1w']);

/** Stable per-indicator key. Daily-source MAs get a `-D` suffix so a daily
 *  200 and a chart 200 never collide (settings/toggle/render all key on this). */
export function indicatorKey(cfg: { type: string; period: number; source?: string }): string {
  return cfg.source === 'daily' ? `${cfg.type}-${cfg.period}-D` : `${cfg.type}-${cfg.period}`;
}

/** Bollinger Bands render as three lines off ONE config, so their series keys
 *  carry a `:upper|:basis|:lower` suffix. Hit-testing a line yields that suffixed
 *  key; strip it to find the config it belongs to. */
export function baseIndicatorKey(seriesKey: string): string {
  const i = seriesKey.indexOf(':');
  return i === -1 ? seriesKey : seriesKey.slice(0, i);
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

// ─── Bollinger Bands ─────────────────────────────────────────────────────────

export const BB_DEFAULT_PERIOD = 20;
export const BB_DEFAULT_STDDEV = 2;
/** TradingView's default middle-band colour (the bands themselves use `color`). */
export const BB_DEFAULT_BASIS_COLOR = '#ff6d00';

export interface BollingerResult {
  upper: LineData[];
  basis: LineData[];
  lower: LineData[];
}

/**
 * Bollinger Bands, matching TradingView's built-in.
 *
 * Basis is an SMA of the close over `period`; the bands sit `mult` standard
 * deviations either side. The deviation is the **population** form (÷ N, over
 * the same window as the basis) — that's what Pine's `ta.stdev` computes by
 * default (`biased = true`), and using the sample form (÷ N−1) would widen every
 * band slightly versus TradingView.
 *
 * Computed on whatever bars it is handed, so the values follow the panel's
 * timeframe like any other chart-source indicator.
 */
export function calcBollinger(
  bars: Bar[],
  period: number,
  mult: number,
  timeframe = '1d'
): BollingerResult {
  const empty: BollingerResult = { upper: [], basis: [], lower: [] };
  if (period < 1 || bars.length < period) return empty;

  const isDaily = DAILY_TF.has(timeframe);
  const out: BollingerResult = { upper: [], basis: [], lower: [] };

  for (let i = period - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / period;

    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = bars[j].close - mean;
      variance += d * d;
    }
    const sd = Math.sqrt(variance / period); // population (biased), as Pine does
    const offset = mult * sd;

    const time = toChartTime(bars[i].time, isDaily);
    out.basis.push({ time, value: mean });
    out.upper.push({ time, value: mean + offset });
    out.lower.push({ time, value: mean - offset });
  }
  return out;
}

/** Translucent fill tint for the band interior, derived from the band colour. */
export function bandFillColor(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return 'rgba(41,98,255,0.09)';
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},0.09)`;
}

export type IndicatorSeries = {
  key: string; // e.g. "SMA-20", "EMA-50", "BB-20:upper"
  data: LineData[];
  color?: string;
  lineWidth?: number;
  // Keep this line out of the price scale's auto-range. Daily MAs projected
  // onto an intraday chart sit far from the intraday range (a 200-day MA can be
  // 15% below price) and would otherwise zoom the candles into a sliver.
  noAutoscale?: boolean;
  // Bollinger edges: pairs sharing a `group` get the region between them filled.
  bandFill?: { group: string; role: 'upper' | 'lower'; color: string };
};

export function computeIndicators(
  bars: Bar[],
  configs: IndicatorConfig[],
  timeframe = '1d'
): IndicatorSeries[] {
  const out: IndicatorSeries[] = [];

  for (const cfg of configs) {
    const key = indicatorKey(cfg);

    if (cfg.type === 'BB') {
      const bb = calcBollinger(
        bars,
        cfg.period,
        cfg.stdDev ?? BB_DEFAULT_STDDEV,
        timeframe
      );
      if (!bb.basis.length) continue;
      const fill = bandFillColor(cfg.color);
      // Bands first so the basis line draws over them where they touch.
      out.push({
        key: `${key}:upper`, data: bb.upper, color: cfg.color, lineWidth: cfg.lineWidth,
        bandFill: { group: key, role: 'upper', color: fill },
      });
      out.push({
        key: `${key}:lower`, data: bb.lower, color: cfg.color, lineWidth: cfg.lineWidth,
        bandFill: { group: key, role: 'lower', color: fill },
      });
      out.push({
        key: `${key}:basis`, data: bb.basis,
        color: cfg.basisColor ?? BB_DEFAULT_BASIS_COLOR,
        lineWidth: cfg.lineWidth,
      });
      continue;
    }

    out.push({
      key,
      data: cfg.type === 'SMA'
        ? calcSMA(bars, cfg.period, timeframe)
        : calcEMA(bars, cfg.period, timeframe),
      color: cfg.color,
      lineWidth: cfg.lineWidth,
    });
  }

  return out;
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

  // Bollinger Bands are a chart-source indicator only — a "daily BB projected
  // onto 1m" isn't a thing traders read, and the stepped projection would make
  // the band edges meaningless.
  const maConfigs = configs.filter((c): c is IndicatorConfig & { type: 'SMA' | 'EMA' } =>
    c.type === 'SMA' || c.type === 'EMA');

  return maConfigs.map((cfg) => {
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
