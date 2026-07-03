import type { Bar } from '@ibkr-chart/types';
import type { LineData, Time } from 'lightweight-charts';

const DAILY_TF = new Set(['1d', '1w']);
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
};

export function computeIndicators(
  bars: Bar[],
  configs: Array<{ type: 'SMA' | 'EMA'; period: number }>,
  timeframe = '1d'
): IndicatorSeries[] {
  return configs.map((cfg) => ({
    key: `${cfg.type}-${cfg.period}`,
    data: cfg.type === 'SMA' ? calcSMA(bars, cfg.period, timeframe) : calcEMA(bars, cfg.period, timeframe),
  }));
}
