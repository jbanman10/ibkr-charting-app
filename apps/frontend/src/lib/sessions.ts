/**
 * Session utilities for US-equity (Eastern Time) intraday charts.
 *
 * Bars carry numeric UTC epoch seconds (IBKR formatDate=2). We bucket them into
 * ET sessions to derive session levels (opening range, prev-day H/L, pre-market
 * H/L) and the pre/post-market regions used for background shading.
 *
 * ET windows (minute-of-day, DST handled by Intl):
 *   pre-market   04:00–09:30   → 240 ≤ m < 570
 *   regular      09:30–16:00   → 570 ≤ m < 960
 *   post-market  16:00–20:00   → 960 ≤ m < 1200
 */

import type { Bar } from '@ibkr-chart/types';

export type SessionKind = 'pre' | 'rth' | 'post' | 'closed';

export interface SessionLevels {
  prevDayHigh: number | null;
  prevDayLow: number | null;
  premarketHigh: number | null;
  premarketLow: number | null;
  orHigh: number | null;
  orLow: number | null;
  or15High: number | null;
  or15Low: number | null;
}

export interface SessionRegion {
  from: number; // unix seconds (a real bar time)
  to: number;   // unix seconds (a real bar time)
  kind: 'pre' | 'post';
}

// Opening-range window lengths, in minutes from the 09:30 ET open. Both are
// derived from the same bars, so a chart can show either or both.
const OR_MINUTES = 5;
const OR15_MINUTES = 15;

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

interface EtParts {
  dateKey: string;     // "YYYY-MM-DD" in ET
  minuteOfDay: number; // 0–1439 in ET
}

const partsCache = new Map<number, EtParts>();

/** Convert a UTC epoch-seconds bar time to ET date + minute-of-day. */
export function etParts(unixSec: number): EtParts {
  const cached = partsCache.get(unixSec);
  if (cached) return cached;

  const p: Record<string, string> = {};
  for (const part of etFormatter.formatToParts(unixSec * 1000)) {
    if (part.type !== 'literal') p[part.type] = part.value;
  }
  const result: EtParts = {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minuteOfDay: Number(p.hour) * 60 + Number(p.minute),
  };
  // Bound the cache so a long session doesn't grow it without limit.
  if (partsCache.size > 20000) partsCache.clear();
  partsCache.set(unixSec, result);
  return result;
}

export function classify(minuteOfDay: number): SessionKind {
  if (minuteOfDay >= 240 && minuteOfDay < 570) return 'pre';
  if (minuteOfDay >= 570 && minuteOfDay < 960) return 'rth';
  if (minuteOfDay >= 960 && minuteOfDay < 1200) return 'post';
  return 'closed';
}

/**
 * Which session the wall clock is in right now (ET). Weekends count as closed —
 * a Saturday morning is inside the pre-market minute window but there is no
 * session, and showing a stale "Pre" line all weekend would be wrong.
 */
export function currentSession(nowMs = Date.now()): SessionKind {
  const { minuteOfDay } = etParts(Math.floor(nowMs / 1000));
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  }).format(nowMs);
  if (weekday === 'Sat' || weekday === 'Sun') return 'closed';
  return classify(minuteOfDay);
}

const hi = (bars: Bar[]) => (bars.length ? Math.max(...bars.map((b) => Number(b.high))) : null);
const lo = (bars: Bar[]) => (bars.length ? Math.min(...bars.map((b) => Number(b.low))) : null);

/**
 * Derive session levels from the loaded intraday bars. Returns nulls for any
 * level not present in the data window.
 */
export function computeSessionLevels(bars: Bar[]): SessionLevels {
  const empty: SessionLevels = {
    prevDayHigh: null, prevDayLow: null,
    premarketHigh: null, premarketLow: null,
    orHigh: null, orLow: null,
    or15High: null, or15Low: null,
  };
  if (!bars.length) return empty;

  // Group bar indices by ET trading day, tracking session kind per bar.
  const byDay = new Map<string, { kind: SessionKind; min: number; bar: Bar }[]>();
  const orderedDays: string[] = [];
  for (const bar of bars) {
    const { dateKey, minuteOfDay } = etParts(Number(bar.time));
    let arr = byDay.get(dateKey);
    if (!arr) { arr = []; byDay.set(dateKey, arr); orderedDays.push(dateKey); }
    arr.push({ kind: classify(minuteOfDay), min: minuteOfDay, bar });
  }

  const today = orderedDays[orderedDays.length - 1];
  const todayBars = byDay.get(today) ?? [];

  // Previous day = latest earlier day that actually has a regular session.
  let prevDay: string | null = null;
  for (let i = orderedDays.length - 2; i >= 0; i--) {
    if ((byDay.get(orderedDays[i]) ?? []).some((b) => b.kind === 'rth')) { prevDay = orderedDays[i]; break; }
  }
  const prevBars = prevDay ? (byDay.get(prevDay) ?? []) : [];

  const prevRth = prevBars.filter((b) => b.kind === 'rth').map((b) => b.bar);
  const todayPre = todayBars.filter((b) => b.kind === 'pre').map((b) => b.bar);
  // Bars whose ET start falls inside the first `mins` minutes of the regular
  // session. NOTE: a bar is included by where it STARTS, so on a timeframe
  // coarser than the window (a 5m range on a 30m chart) the single 09:30 bar
  // covers the whole window and both OR pairs collapse onto the same prices.
  // That is the pre-existing behaviour of the 5m range and is left as is —
  // read the levels on a timeframe at or below the window length.
  const orBars = (mins: number) => todayBars
    .filter((b) => b.kind === 'rth' && b.min >= 570 && b.min < 570 + mins)
    .map((b) => b.bar);
  const todayOr = orBars(OR_MINUTES);
  const todayOr15 = orBars(OR15_MINUTES);

  return {
    prevDayHigh: hi(prevRth),
    prevDayLow: lo(prevRth),
    premarketHigh: hi(todayPre),
    premarketLow: lo(todayPre),
    orHigh: hi(todayOr),
    orLow: lo(todayOr),
    or15High: hi(todayOr15),
    or15Low: lo(todayOr15),
  };
}

/**
 * Contiguous pre/post-market runs across the loaded bars, with boundaries snapped
 * to real bar times so the chart's timeToCoordinate() resolves them.
 */
export function computeSessionRegions(bars: Bar[]): SessionRegion[] {
  const regions: SessionRegion[] = [];
  let cur: SessionRegion | null = null;

  for (const bar of bars) {
    const t = Number(bar.time);
    const kind = classify(etParts(t).minuteOfDay);
    if (kind === 'pre' || kind === 'post') {
      if (cur && cur.kind === kind) {
        cur.to = t;
      } else {
        if (cur) regions.push(cur);
        cur = { from: t, to: t, kind };
      }
    } else if (cur) {
      regions.push(cur);
      cur = null;
    }
  }
  if (cur) regions.push(cur);
  return regions;
}
