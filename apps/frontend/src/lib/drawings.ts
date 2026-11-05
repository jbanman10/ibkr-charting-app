/**
 * drawings.ts
 *
 * Types and pure functions for chart drawing tools.
 *
 * lightweight-charts doesn't have a native drawing layer, so we overlay
 * an absolutely-positioned <canvas> on top of the chart div and paint
 * onto it ourselves, converting between pixel and logical (time/price)
 * coordinates using the chart's own coordinate converters.
 *
 * Drawing types supported:
 *   - TrendLine    : two anchor points, extended to chart edges
 *   - HorizontalLine: one price level, full-width
 *   - Rectangle    : two corner points
 */

import type { IChartApi } from 'lightweight-charts';
import type { Time } from 'lightweight-charts';
import { etParts } from './sessions';

// ─── Serialisable drawing types ───────────────────────────────────────────────

export type DrawingToolType = 'trendline' | 'hline' | 'rectangle' | 'position' | 'callout' | 'none';

export interface DrawingPoint {
  time: number;   // Unix seconds
  price: number;
}

export interface TrendLineDrawing {
  id: string;
  type: 'trendline';
  p1: DrawingPoint;
  p2: DrawingPoint;
  color: string;
  width: number;
  dashed?: boolean;
  extended: boolean;     // extend both directions to the chart edges
  extendRight?: boolean; // extend only the right edge to the chart edge (and beyond)
  label?: string;        // free text, drawn as a chip at the line's right end
}

export interface HLineDrawing {
  id: string;
  type: 'hline';
  price: number;
  color: string;
  width: number;
  dashed: boolean;
  label?: string;        // free text, drawn as a chip at the right edge
}

export interface RectangleDrawing {
  id: string;
  type: 'rectangle';
  p1: DrawingPoint;
  p2: DrawingPoint;
  borderColor: string;
  fillColor: string;
  borderWidth?: number;  // default 1
  extendRight?: boolean; // open the right edge to the chart edge (and beyond)
  label?: string;        // free text, drawn as a chip in the top-right corner
}

// TradingView-style long/short position: entry line with a green reward zone
// (entry ↔ target) and a red risk zone (entry ↔ stop). Direction is implied by
// where target/stop sit relative to entry (target above = long, below = short).
export interface PositionDrawing {
  id: string;
  type: 'position';
  time1: number;  // left edge (unix seconds)
  time2: number;  // right edge (unix seconds)
  entry: number;
  stop: number;
  target: number;
}

// Price alert: a full-width line at a price level. Created with Alt+A at the
// cursor, draggable like an hline (dragging re-arms it). When the live price
// crosses the level the app quacks and the alert flips to triggered (dim).
export interface AlertDrawing {
  id: string;
  type: 'alert';
  price: number;
  triggeredAt?: number | null; // unix ms when it fired; null/absent = armed
}

// TradingView-style callout: a rounded text bubble with a tail pointing at a
// spot on the chart. `anchor` is what it points AT; `bubble` is where the box
// sits. Both are logical points, so the callout tracks the candle it marks
// across pan/zoom and every timeframe.
export interface CalloutDrawing {
  id: string;
  type: 'callout';
  anchor: DrawingPoint;
  bubble: DrawingPoint;
  text: string;
  color: string;      // border + text
  fillColor: string;  // bubble background
  width?: number;     // border width, default 1
}

export type Drawing =
  | TrendLineDrawing
  | HLineDrawing
  | RectangleDrawing
  | PositionDrawing
  | AlertDrawing
  | CalloutDrawing;

// ─── Coordinate helpers ───────────────────────────────────────────────────────

export interface PixelPoint { x: number; y: number }

/**
 * Minimal view of the price series the drawing layer needs: price↔pixel mapping
 * plus the chart's OWN bar times, which drive time↔pixel (see timeToIndex).
 */
export interface DrawingSeries {
  priceToCoordinate: (p: number) => number | null;
  data?: () => readonly { time: Time }[];
}

/** Time extent (unix seconds) of the bars currently loaded on a panel. */
export interface DataTimeRange { first: number; last: number }

/**
 * Normalize any lightweight-charts Time to numeric unix seconds. Daily/weekly
 * charts use business-day form, so coordinateToTime returns a {year,month,day}
 * object (or "YYYY-MM-DD" string) — convert those to a numeric UTC-midnight time
 * so drawings store a consistent numeric time across all timeframes.
 */
export function timeToUnix(t: Time): number {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') return Date.parse(`${t}T00:00:00Z`) / 1000;
  const bd = t as { year: number; month: number; day: number };
  return Date.UTC(bd.year, bd.month - 1, bd.day) / 1000;
}

/** Numeric unix seconds → "YYYY-MM-DD" (UTC), for mapping onto a business-day chart. */
export function unixToDayString(sec: number): string {
  const d = new Date(sec * 1000);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}-${day}`;
}

// ─── Time ↔ pixel, via the chart's own bar index ──────────────────────────────
//
// timeScale().timeToCoordinate() only answers for a time that is EXACTLY a bar
// time in the series, which is almost never true for a drawing viewed on a
// different timeframe: a rectangle drawn at 14:43 on the 1m chart is not a 30m
// bar time, and a daily drawing's midnight is not an intraday bar time. Every
// such lookup used to fall through to clamping (to the left edge, or the right)
// or to a linear interpolation that computed Number("2026-11-05") → NaN on
// daily and weekly charts. That is why drawings "didn't translate" between
// timeframes: both corners collapsed onto the same edge — a full-width band or
// a zero-width sliver — or vanished entirely.
//
// Bar INDEX space has none of those problems. The chart's index→pixel transform
// is exactly affine (measured: logicalToCoordinate is linear in the index with
// slope = bar spacing), it is defined for indices outside the data — so a shape
// reaching into the future, or off the left of the window, keeps its true size
// instead of pinning to an edge — and it behaves identically on numeric and
// business-day charts. So we map time → fractional bar index against the
// series' own bar times, then index → pixel.

/** Bar times of a series as unix seconds, cached per series instance. */
interface SeriesTimes {
  len: number;
  first: number;
  last: number;
  times: number[];
  /** Business-day chart (daily/weekly): bar times are UTC midnights of ET dates. */
  dayBased: boolean;
}
const timesCache = new WeakMap<object, SeriesTimes>();

function seriesTimes(series: DrawingSeries): SeriesTimes | null {
  if (typeof series.data !== 'function') return null;
  const data = series.data();
  const n = data.length;
  if (!n) return null;
  const first = timeToUnix(data[0].time);
  const last = timeToUnix(data[n - 1].time);
  const hit = timesCache.get(series as unknown as object);
  // A forming bar mutates OHLC but not its time, so (length, first, last) is a
  // sufficient identity — it changes exactly when bars are added or re-windowed.
  if (hit && hit.len === n && hit.first === first && hit.last === last) return hit;
  const times = new Array<number>(n);
  for (let i = 0; i < n; i++) times[i] = timeToUnix(data[i].time);
  const entry: SeriesTimes = {
    len: n, first, last, times,
    dayBased: typeof data[0].time !== 'number',
  };
  timesCache.set(series as unknown as object, entry);
  return entry;
}

/** A time that is exactly UTC midnight came from a daily/weekly (business-day) chart. */
function isDayLevel(sec: number): boolean {
  return Number.isFinite(sec) && sec % 86400 === 0;
}

/** UTC seconds at 00:00 ET on the given ET calendar date ("YYYY-MM-DD"). */
function etDayStartUnix(date: string): number {
  const base = Date.parse(`${date}T00:00:00Z`) / 1000;
  // Probe at 12:00 UTC — inside the target ET date at either US offset — and
  // back that day's offset out of the ET wall clock we get back (DST-safe).
  const { minuteOfDay } = etParts(base + 12 * 3600);
  return base + (12 * 60 - minuteOfDay) * 60;
}

/**
 * Put a drawing's absolute time into the convention the target chart's bar
 * times use, so a daily drawing lands on the right ET session intraday and an
 * intraday drawing lands on the right ET day on a daily chart.
 */
function alignToSeries(time: number, st: SeriesTimes): number {
  if (st.dayBased) {
    // Daily/weekly chart. Its bar times are UTC midnight of the ET trading
    // date, so an intraday time has to be bucketed by its ET date — reading it
    // as a UTC date puts anything after 19:00 ET on the following day.
    if (isDayLevel(time)) return time; // already day-level
    return Date.parse(`${etParts(time).dateKey}T00:00:00Z`) / 1000;
  }
  // Intraday chart. A day-level time means "that trading day", whose ET date is
  // its UTC date — note UTC midnight of day D is 19:00 ET on D-1, so reading it
  // as a plain instant would put the drawing a whole session early.
  if (isDayLevel(time)) return etDayStartUnix(unixToDayString(time));
  return time;
}

/**
 * Fractional bar index of an absolute time on the chart as currently loaded.
 * Beyond either end we extrapolate at the spacing of the nearest edge, so a
 * drawing outside the loaded window keeps its real extent and simply sits
 * off-screen rather than being clamped onto the edge.
 */
function timeToIndex(series: DrawingSeries, time: number): number | null {
  const st = seriesTimes(series);
  if (!st) return null;
  const { times } = st;
  const n = times.length;
  const t = alignToSeries(time, st);
  if (!Number.isFinite(t)) return null;

  if (t <= times[0]) {
    const sp = n > 1 ? times[1] - times[0] : 60;
    return sp > 0 ? (t - times[0]) / sp : 0;
  }
  if (t >= times[n - 1]) {
    const sp = n > 1 ? times[n - 1] - times[n - 2] : 60;
    return sp > 0 ? n - 1 + (t - times[n - 1]) / sp : n - 1;
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = times[hi] - times[lo];
  return span > 0 ? lo + (t - times[lo]) / span : lo;
}

/** Inverse of timeToIndex: a fractional bar index back to an absolute time. */
function indexToTime(series: DrawingSeries, index: number): number | null {
  const st = seriesTimes(series);
  if (!st) return null;
  const { times } = st;
  const n = times.length;
  if (index <= 0) {
    const sp = n > 1 ? times[1] - times[0] : 60;
    return Math.round(times[0] + index * sp);
  }
  if (index >= n - 1) {
    const sp = n > 1 ? times[n - 1] - times[n - 2] : 60;
    return Math.round(times[n - 1] + (index - (n - 1)) * sp);
  }
  const lo = Math.floor(index);
  return Math.round(times[lo] + (index - lo) * (times[lo + 1] - times[lo]));
}

/**
 * Bar index → x pixel. logicalToCoordinate() bails out and returns 0 for a
 * FRACTIONAL index, so take two integer probes and interpolate ourselves — the
 * transform is exactly linear in the index (slope = bar spacing).
 */
function indexToX(chart: IChartApi, index: number): number | null {
  const ts = chart.timeScale();
  const c0 = ts.logicalToCoordinate(0 as never);
  const c1 = ts.logicalToCoordinate(1 as never);
  if (c0 === null || c1 === null) return null;
  const x = c0 + index * (c1 - c0);
  if (!Number.isFinite(x)) return null;
  // A drawing from months ago can land a million pixels off-screen; keep the
  // numbers in a range canvas ops stay cheap on. It is clipped either way.
  return Math.max(-1e6, Math.min(1e6, x));
}

/** x pixel → fractional bar index. */
function xToIndex(chart: IChartApi, x: number): number | null {
  const ts = chart.timeScale();
  const c0 = ts.logicalToCoordinate(0 as never);
  const c1 = ts.logicalToCoordinate(1 as never);
  if (c0 === null || c1 === null || c1 === c0) return null;
  return (x - c0) / (c1 - c0);
}

/**
 * Map an absolute time to an x pixel on the chart as currently rendered.
 * `series` carries the bar times; without it we fall back to the chart's own
 * exact-match converter, which only answers for a real bar time.
 */
export function timeToX(
  chart: IChartApi,
  time: number,
  _range: DataTimeRange | null,
  _width: number,
  series?: DrawingSeries | null
): number | null {
  if (series) {
    const idx = timeToIndex(series, time);
    if (idx !== null) {
      const x = indexToX(chart, idx);
      if (x !== null) return x;
    }
  }
  const ts = chart.timeScale();
  let c = ts.timeToCoordinate(time as Time);
  if (c === null) c = ts.timeToCoordinate(unixToDayString(time) as unknown as Time);
  return c;
}

/**
 * Kept for the call sites that mean "a time past the last bar must extrapolate,
 * not pin to the edge". timeToX does that by construction now.
 */
export function timeToXAnchored(
  chart: IChartApi,
  time: number,
  range: DataTimeRange | null,
  width: number,
  series?: DrawingSeries | null
): number | null {
  return timeToX(chart, time, range, width, series);
}

/**
 * Inverse of timeToX: an x pixel back to an absolute time, including in the
 * whitespace past the last bar (so a drag can reach as far right as the user
 * wants). Going through index space keeps the mapping monotonic and smooth —
 * coordinateToTime() snaps to the nearest bar, so dragging across an overnight
 * gap used to jump the time by hours, and the old px→seconds extrapolation past
 * the last bar could fling a drawing months away.
 */
export function xToTimeAnchored(
  chart: IChartApi,
  x: number,
  range: DataTimeRange | null,
  series?: DrawingSeries | null
): number | null {
  if (series) {
    const idx = xToIndex(chart, x);
    if (idx !== null) {
      const t = indexToTime(series, idx);
      if (t !== null) return t;
    }
  }
  const t = chart.timeScale().coordinateToTime(x);
  if (t !== null) return timeToUnix(t);
  return range ? range.last : null;
}

/** Convert a logical drawing point to canvas pixels. */
export function toPixel(
  chart: IChartApi,
  point: DrawingPoint,
  series: DrawingSeries,
  range: DataTimeRange | null = null,
  width = 0
): PixelPoint | null {
  const x = timeToX(chart, point.time, range, width, series);
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Convert canvas pixel position back to logical coordinates. */
export function fromPixel(
  chart: IChartApi,
  px: PixelPoint,
  series: DrawingSeries & { coordinateToPrice: (y: number) => number | null },
  range: DataTimeRange | null = null
): DrawingPoint | null {
  const time = xToTimeAnchored(chart, px.x, range, series);
  const price = series.coordinateToPrice(px.y);
  if (time === null || price === null) return null;
  return { time, price };
}

// ─── Callout geometry ─────────────────────────────────────────────────────────
//
// Rendering and hit-testing must agree on exactly where the bubble sits, so both
// go through these helpers. Text is measured on a shared offscreen 2D context
// (hit-testing has no canvas of its own).

const CALLOUT_FONT = '12px JetBrains Mono, monospace';
const CALLOUT_PAD_X = 8;
const CALLOUT_PAD_Y = 6;
const CALLOUT_LINE_H = 15;
const CALLOUT_TAIL_HALF = 6; // half-width of the tail's base
const CALLOUT_MAX_LINES = 8;
export const CALLOUT_PLACEHOLDER = 'Text…';

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx ?? null;
}

/** The lines actually drawn — empty text shows a placeholder so a fresh
 *  callout is visible (and clickable) before anything is typed. */
export function calloutLines(d: CalloutDrawing): string[] {
  const raw = (d.text ?? '').replace(/\r/g, '');
  if (!raw.trim()) return [CALLOUT_PLACEHOLDER];
  return raw.split('\n').slice(0, CALLOUT_MAX_LINES);
}

export interface CalloutBox { x: number; y: number; w: number; h: number }

/** Bubble rect in pixels, centred on the bubble point. */
export function calloutBox(d: CalloutDrawing, bubblePx: PixelPoint): CalloutBox {
  const lines = calloutLines(d);
  const ctx = getMeasureCtx();
  let textW = 0;
  if (ctx) {
    ctx.font = CALLOUT_FONT;
    for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
  } else {
    // No canvas (SSR/test): approximate at the monospace advance width.
    for (const l of lines) textW = Math.max(textW, l.length * 7.2);
  }
  const w = Math.ceil(textW) + CALLOUT_PAD_X * 2;
  const h = lines.length * CALLOUT_LINE_H + CALLOUT_PAD_Y * 2;
  return { x: bubblePx.x - w / 2, y: bubblePx.y - h / 2, w, h };
}

/** Where the tail leaves the bubble: the box boundary along the ray toward `target`. */
function boxEdgeToward(box: CalloutBox, target: PixelPoint): PixelPoint {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? (box.w / 2) / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? (box.h / 2) / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

const HIT_RADIUS = 8; // px tolerance for clicking on a drawing
/** Floor on a shape's drawn width, so a span that is sub-pixel on a coarse
 *  timeframe still shows up instead of silently rendering as nothing. */
const MIN_SHAPE_W = 3;

export function hitTestDrawing(
  drawing: Drawing,
  px: PixelPoint,
  chart: IChartApi,
  series: DrawingSeries,
  range: DataTimeRange | null = null,
  width = 0
): boolean {
  if (drawing.type === 'hline' || drawing.type === 'alert') {
    const y = series.priceToCoordinate(drawing.price);
    if (y === null) return false;
    return Math.abs(px.y - y) < HIT_RADIUS;
  }

  if (drawing.type === 'callout') {
    const edge = plotRight(chart, width);
    const bub = toPixel(chart, drawing.bubble, series, range, edge);
    const anchor = toPixel(chart, drawing.anchor, series, range, edge);
    if (!bub) return false;
    const box = calloutBox(drawing, bub);
    const inBox = px.x >= box.x - HIT_RADIUS && px.x <= box.x + box.w + HIT_RADIUS
               && px.y >= box.y - HIT_RADIUS && px.y <= box.y + box.h + HIT_RADIUS;
    if (inBox) return true;
    // The tail counts too, so the pointer end is grabbable.
    if (!anchor) return false;
    return distToSegment(px, boxEdgeToward(box, anchor), anchor) < HIT_RADIUS;
  }

  if (drawing.type === 'position') {
    const edge = plotRight(chart, width);
    const x1 = timeToXAnchored(chart, drawing.time1, range, edge, series);
    const x2 = timeToXAnchored(chart, drawing.time2, range, edge, series);
    const yE = series.priceToCoordinate(drawing.entry);
    const yS = series.priceToCoordinate(drawing.stop);
    const yT = series.priceToCoordinate(drawing.target);
    if (x1 === null || x2 === null || yE === null || yS === null || yT === null) return false;
    const minY = Math.min(yE, yS, yT) - HIT_RADIUS;
    const maxY = Math.max(yE, yS, yT) + HIT_RADIUS;
    return px.x >= Math.min(x1, x2) - HIT_RADIUS && px.x <= Math.max(x1, x2) + HIT_RADIUS
        && px.y >= minY && px.y <= maxY;
  }

  if (drawing.type === 'trendline' || drawing.type === 'rectangle') {
    const edge = plotRight(chart, width);
    const a = toPixel(chart, drawing.p1, series, range, edge);
    const b = toPixel(chart, drawing.p2, series, range, edge);
    if (!a || !b) return false;
    const rightOpen = drawing.extendRight ? edge : Math.max(a.x, b.x);

    if (drawing.type === 'rectangle') {
      const minX = Math.min(a.x, b.x) - HIT_RADIUS;
      const maxX = rightOpen + HIT_RADIUS;
      const minY = Math.min(a.y, b.y) - HIT_RADIUS;
      const maxY = Math.max(a.y, b.y) + HIT_RADIUS;
      return px.x >= minX && px.x <= maxX && px.y >= minY && px.y <= maxY;
    }

    // Distance from point to line segment
    return distToSegment(px, a, b) < HIT_RADIUS;
  }

  return false;
}

// ─── Resize handles ─────────────────────────────────────────────────────────

// Which grab point a resize drag is manipulating. Trendlines expose their two
// endpoints; rectangles expose their four visual corners; positions expose
// their three price lines plus a right-edge width handle.
export type ResizeHandle =
  | 'p1' | 'p2' | 'tl' | 'tr' | 'bl' | 'br'
  | 'entry' | 'stop' | 'target' | 'right'
  | 'anchor' | 'bubble';

const HANDLE_HIT = 9; // px tolerance for grabbing a resize handle

/**
 * If `px` is over a resize handle of `drawing`, return which one — else null.
 * `edge` is the plot-area right edge (so an extend-right rectangle's right
 * corners sit on the edge, matching how it renders).
 */
export function hitResizeHandle(
  drawing: Drawing,
  px: PixelPoint,
  chart: IChartApi,
  series: DrawingSeries,
  range: DataTimeRange | null,
  edge: number
): ResizeHandle | null {
  const near = (hx: number, hy: number) => Math.abs(px.x - hx) <= HANDLE_HIT && Math.abs(px.y - hy) <= HANDLE_HIT;

  if (drawing.type === 'trendline') {
    const a = toPixel(chart, drawing.p1, series, range, edge);
    const b = toPixel(chart, drawing.p2, series, range, edge);
    if (a && near(a.x, a.y)) return 'p1';
    if (b && near(b.x, b.y)) return 'p2';
    return null;
  }

  if (drawing.type === 'rectangle') {
    const a = toPixel(chart, drawing.p1, series, range, edge);
    const b = toPixel(chart, drawing.p2, series, range, edge);
    if (!a || !b) return null;
    const xL = Math.min(a.x, b.x);
    const xR = drawing.extendRight ? edge : Math.max(a.x, b.x);
    const yT = Math.min(a.y, b.y);
    const yB = Math.max(a.y, b.y);
    if (near(xL, yT)) return 'tl';
    if (near(xR, yT)) return 'tr';
    if (near(xL, yB)) return 'bl';
    if (near(xR, yB)) return 'br';
    return null;
  }

  if (drawing.type === 'callout') {
    const bub = toPixel(chart, drawing.bubble, series, range, edge);
    const anchor = toPixel(chart, drawing.anchor, series, range, edge);
    // Tip first: it sits outside the box, so it can never be shadowed by it.
    if (anchor && near(anchor.x, anchor.y)) return 'anchor';
    if (bub) {
      const box = calloutBox(drawing, bub);
      if (near(box.x, box.y)) return 'bubble';
    }
    return null;
  }

  if (drawing.type === 'position') {
    const x1 = timeToXAnchored(chart, drawing.time1, range, edge, series);
    const x2 = timeToXAnchored(chart, drawing.time2, range, edge, series);
    const yE = series.priceToCoordinate(drawing.entry);
    const yS = series.priceToCoordinate(drawing.stop);
    const yT = series.priceToCoordinate(drawing.target);
    if (x1 === null || x2 === null || yE === null || yS === null || yT === null) return null;
    const midX = (x1 + x2) / 2;
    if (near(midX, yT)) return 'target';
    if (near(midX, yS)) return 'stop';
    if (near(midX, yE)) return 'entry';
    if (near(Math.max(x1, x2), yE)) return 'right';
    return null;
  }

  return null;
}

function distToSegment(p: PixelPoint, a: PixelPoint, b: PixelPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ─── Canvas rendering ─────────────────────────────────────────────────────────

export function renderDrawings(
  ctx: CanvasRenderingContext2D,
  drawings: Drawing[],
  chart: IChartApi,
  series: DrawingSeries,
  selectedId: string | null,
  width: number,
  height: number,
  range: DataTimeRange | null = null,
  // Right edge of the plot area. The DrawingsPrimitive's canvas width is already
  // the pane width (axis excluded) so it passes that directly; the full-width
  // overlay canvas omits this and we derive it by subtracting the axis.
  rightEdgeOverride?: number
): void {
  // NOTE: do not clearRect here. When this runs inside the chart's DrawingsPrimitive
  // it shares the canvas with the crosshair layer, and clearing would erase the
  // crosshair. The DrawingCanvas overlay clears itself by reassigning canvas.width.

  const rightEdge = rightEdgeOverride ?? plotRight(chart, width);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, rightEdge, height);
  ctx.clip();

  for (const d of drawings) {
    const isSelected = d.id === selectedId;
    ctx.save();
    ctx.setLineDash([]);

    if (d.type === 'hline') {
      renderHLine(ctx, d, series, rightEdge, isSelected);
    } else if (d.type === 'trendline') {
      renderTrendLine(ctx, d, chart, series, rightEdge, height, isSelected, range);
    } else if (d.type === 'rectangle') {
      renderRectangle(ctx, d, chart, series, isSelected, rightEdge, range);
    } else if (d.type === 'position') {
      renderPosition(ctx, d, chart, series, isSelected, rightEdge, range);
    } else if (d.type === 'alert') {
      renderAlert(ctx, d, series, rightEdge, isSelected);
    } else if (d.type === 'callout') {
      renderCallout(ctx, d, chart, series, isSelected, rightEdge, range);
    }

    ctx.restore();
  }

  ctx.restore();
}

/** Right edge of the plot area = canvas width minus the right price-scale width. */
export function plotRight(chart: IChartApi, width: number): number {
  let axis = 0;
  try { axis = chart.priceScale('right').width(); } catch { /* not ready */ }
  return axis > 0 && axis < width ? width - axis : width;
}

function renderHLine(
  ctx: CanvasRenderingContext2D,
  d: HLineDrawing,
  series: DrawingSeries,
  width: number,
  selected: boolean
): void {
  const y = series.priceToCoordinate(d.price);
  if (y === null) return;

  ctx.strokeStyle = d.color;
  ctx.lineWidth = selected ? d.width + 1 : d.width;
  if (d.dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();

  if (selected) drawHandle(ctx, width / 2, y, d.color);

  // User label sits at the far right; the price readout tucks in to its left
  // (with no label the price keeps its original position).
  let priceRight = width - 35;
  const chipW = drawLabelChip(ctx, d.label, width - 4, y, d.color, 'right');
  if (chipW) priceRight = width - 10 - chipW;

  // Price label
  ctx.fillStyle = d.color;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillText(d.price.toFixed(2), priceRight - 35, y - 4);
}

function renderTrendLine(
  ctx: CanvasRenderingContext2D,
  d: TrendLineDrawing,
  chart: IChartApi,
  series: DrawingSeries,
  width: number,
  height: number,
  selected: boolean,
  range: DataTimeRange | null
): void {
  const a = toPixel(chart, d.p1, series, range, width);
  const b = toPixel(chart, d.p2, series, range, width);
  if (!a || !b) return;

  let startX = a.x, startY = a.y, endX = b.x, endY = b.y;
  const slope = b.x === a.x ? Infinity : (b.y - a.y) / (b.x - a.x);

  if (d.extended && isFinite(slope)) {
    // Extend line to both canvas edges
    startX = 0;
    startY = a.y - slope * a.x;
    endX = width;
    endY = a.y + slope * (width - a.x);
  } else if (d.extendRight && isFinite(slope)) {
    // Keep the left anchor, extend the right end to the chart edge.
    const left = a.x <= b.x ? a : b;
    startX = left.x; startY = left.y;
    endX = width;
    endY = left.y + slope * (width - left.x);
  }

  ctx.strokeStyle = d.color;
  ctx.lineWidth = selected ? d.width + 1 : d.width;
  if (d.dashed) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Label at whichever end of the line is on the right, nudged above it and
  // clamped so the chip stays inside the plot area.
  if (d.label) {
    const rightIsEnd = endX >= startX;
    const lx = rightIsEnd ? endX : startX;
    const ly = rightIsEnd ? endY : startY;
    drawLabelChip(ctx, d.label, Math.min(lx, width - 4), ly - 11, d.color, 'right');
  }

  if (selected) {
    drawHandle(ctx, a.x, a.y, d.color);
    drawHandle(ctx, b.x, b.y, d.color);
  }
}

function renderRectangle(
  ctx: CanvasRenderingContext2D,
  d: RectangleDrawing,
  chart: IChartApi,
  series: DrawingSeries,
  selected: boolean,
  width: number,
  range: DataTimeRange | null
): void {
  const a = toPixel(chart, d.p1, series, range, width);
  const b = toPixel(chart, d.p2, series, range, width);
  if (!a || !b) return;

  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  // When extending right, the right edge runs to the chart edge (and stays there).
  const right = d.extendRight ? width : Math.max(a.x, b.x);
  const w = right - x;
  const h = Math.abs(b.y - a.y);

  ctx.fillStyle = d.fillColor;
  ctx.fillRect(x, y, w, h);

  const bw = d.borderWidth ?? 1;
  ctx.strokeStyle = selected ? '#ffffff' : d.borderColor;
  ctx.lineWidth = selected ? bw + 1 : bw;
  ctx.strokeRect(x, y, w, h);

  // Label inside the top-right corner.
  drawLabelChip(ctx, d.label, right - 4, y + 11, d.borderColor, 'right');

  if (selected) {
    drawHandle(ctx, a.x, a.y, d.borderColor);
    drawHandle(ctx, b.x, b.y, d.borderColor);
  }
}

const ALERT_ARMED = '#f59e0b';
const ALERT_DONE  = '#787b86';

function renderAlert(
  ctx: CanvasRenderingContext2D,
  d: AlertDrawing,
  series: DrawingSeries,
  width: number,
  selected: boolean
): void {
  const y = series.priceToCoordinate(d.price);
  if (y === null) return;
  const armed = !d.triggeredAt;
  const color = armed ? ALERT_ARMED : ALERT_DONE;

  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.setLineDash(armed ? [7, 4] : [2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(width, y);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillStyle = color;
  ctx.fillText(`${armed ? '\u{1F514}' : '✓'} ${d.price.toFixed(2)}`, width - 92, y - 5);

  if (selected) drawHandle(ctx, width / 2, y, color);
}

function renderCallout(
  ctx: CanvasRenderingContext2D,
  d: CalloutDrawing,
  chart: IChartApi,
  series: DrawingSeries,
  selected: boolean,
  width: number,
  range: DataTimeRange | null
): void {
  const bub = toPixel(chart, d.bubble, series, range, width);
  const anchor = toPixel(chart, d.anchor, series, range, width);
  if (!bub || !anchor) return;

  const box = calloutBox(d, bub);
  const bw = d.width ?? 1;
  const lines = calloutLines(d);
  const isPlaceholder = !(d.text ?? '').trim();

  // ─ Tail first, so the bubble paints over its base ─
  const edge = boxEdgeToward(box, anchor);
  const dx = anchor.x - edge.x;
  const dy = anchor.y - edge.y;
  const len = Math.hypot(dx, dy);
  if (len > 1) {
    const ux = dx / len;
    const uy = dy / len;
    // Perpendicular, so the base straddles the exit point along the box edge.
    const px = -uy * CALLOUT_TAIL_HALF;
    const py = ux * CALLOUT_TAIL_HALF;
    ctx.beginPath();
    ctx.moveTo(edge.x + px, edge.y + py);
    ctx.lineTo(anchor.x, anchor.y);
    ctx.lineTo(edge.x - px, edge.y - py);
    ctx.closePath();
    ctx.fillStyle = d.fillColor;
    ctx.fill();
    ctx.strokeStyle = d.color;
    ctx.lineWidth = bw;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // ─ Bubble ─
  const r = 6;
  ctx.beginPath();
  ctx.moveTo(box.x + r, box.y);
  ctx.arcTo(box.x + box.w, box.y, box.x + box.w, box.y + box.h, r);
  ctx.arcTo(box.x + box.w, box.y + box.h, box.x, box.y + box.h, r);
  ctx.arcTo(box.x, box.y + box.h, box.x, box.y, r);
  ctx.arcTo(box.x, box.y, box.x + box.w, box.y, r);
  ctx.closePath();
  ctx.fillStyle = d.fillColor;
  ctx.fill();
  ctx.strokeStyle = selected ? '#ffffff' : d.color;
  ctx.lineWidth = selected ? bw + 1 : bw;
  ctx.stroke();

  // ─ Text ─
  ctx.font = CALLOUT_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = isPlaceholder ? 'rgba(255,255,255,0.45)' : d.color;
  lines.forEach((line, i) => {
    ctx.fillText(
      line,
      box.x + CALLOUT_PAD_X,
      box.y + CALLOUT_PAD_Y + CALLOUT_LINE_H * i + CALLOUT_LINE_H / 2
    );
  });

  if (selected) {
    drawHandle(ctx, anchor.x, anchor.y, d.color);
    drawHandle(ctx, box.x, box.y, d.color);
  }
}

const POS_GREEN = '#089981';
const POS_RED   = '#f23645';
const POS_GRAY  = '#b2b5be';

function renderPosition(
  ctx: CanvasRenderingContext2D,
  d: PositionDrawing,
  chart: IChartApi,
  series: DrawingSeries,
  selected: boolean,
  width: number,
  range: DataTimeRange | null
): void {
  const x1r = timeToXAnchored(chart, d.time1, range, width, series);
  const x2r = timeToXAnchored(chart, d.time2, range, width, series);
  const yE = series.priceToCoordinate(d.entry);
  const yS = series.priceToCoordinate(d.stop);
  const yT = series.priceToCoordinate(d.target);
  if (x1r === null || x2r === null || yE === null || yS === null || yT === null) return;

  const x = Math.min(x1r, x2r);
  // A position is a fixed span of absolute time, so on a much coarser timeframe
  // it is genuinely sub-pixel wide (a 20-minute plan is 0.014 of a daily bar).
  // Drawing nothing made it look like the drawing had been lost; keep a floor
  // so it still reads as a marker, and stays selectable.
  const w = Math.max(Math.abs(x2r - x1r), MIN_SHAPE_W);

  // Reward zone (entry ↔ target) and risk zone (entry ↔ stop).
  ctx.fillStyle = 'rgba(8,153,129,0.16)';
  ctx.fillRect(x, Math.min(yE, yT), w, Math.abs(yT - yE));
  ctx.fillStyle = 'rgba(242,54,69,0.16)';
  ctx.fillRect(x, Math.min(yE, yS), w, Math.abs(yS - yE));

  const hLine = (y: number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.stroke();
  };
  hLine(yT, POS_GREEN);
  hLine(yS, POS_RED);
  hLine(yE, POS_GRAY);

  // Labels: target with reward + R multiple, stop with risk, entry price.
  const risk = Math.abs(d.entry - d.stop);
  const reward = Math.abs(d.target - d.entry);
  const rr = risk > 1e-9 ? reward / risk : 0;
  ctx.font = '10px JetBrains Mono, monospace';
  const towardTarget = yT < yE ? -4 : 11;  // put text just outside each line, inside its zone
  const towardStop = yS > yE ? 11 : -4;
  ctx.fillStyle = POS_GREEN;
  ctx.fillText(`${d.target.toFixed(2)}  +${reward.toFixed(2)}  (${rr.toFixed(2)}R)`, x + 5, yT + towardTarget);
  ctx.fillStyle = POS_RED;
  ctx.fillText(`${d.stop.toFixed(2)}  -${risk.toFixed(2)}`, x + 5, yS + towardStop);
  ctx.fillStyle = POS_GRAY;
  ctx.fillText(d.entry.toFixed(2), x + 5, yE - 4);

  if (selected) {
    const midX = x + w / 2;
    drawHandle(ctx, midX, yT, POS_GREEN);
    drawHandle(ctx, midX, yS, POS_RED);
    drawHandle(ctx, midX, yE, POS_GRAY);
    drawHandle(ctx, x + w, yE, POS_GRAY); // width handle
  }
}

/**
 * Draw a drawing's user label as a small chip (TradingView-style). Returns the
 * chip's width so callers can lay other text out beside it. `align` picks which
 * side of `x` the chip sits on ('right' = the chip ENDS at x). Saves/restores
 * the context so font/baseline changes don't leak into other drawings.
 */
function drawLabelChip(
  ctx: CanvasRenderingContext2D,
  text: string | undefined,
  x: number,
  y: number,
  color: string,
  align: 'left' | 'right'
): number {
  const label = (text ?? '').trim();
  if (!label) return 0;

  ctx.save();
  ctx.font = '11px JetBrains Mono, monospace';
  const padX = 5;
  const h = 16;
  const w = Math.ceil(ctx.measureText(label).width) + padX * 2;
  const bx = align === 'right' ? x - w : x;
  const by = y - h / 2;
  const r = 3;

  ctx.beginPath();
  ctx.moveTo(bx + r, by);
  ctx.arcTo(bx + w, by, bx + w, by + h, r);
  ctx.arcTo(bx + w, by + h, bx, by + h, r);
  ctx.arcTo(bx, by + h, bx, by, r);
  ctx.arcTo(bx, by, bx + w, by, r);
  ctx.closePath();
  // Opaque backing so the chip stays readable over candles/the line itself.
  ctx.fillStyle = 'rgba(19,23,34,0.88)';
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(label, bx + padX, y + 0.5);
  ctx.restore();
  return w;
}

function drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ─── ID generator ─────────────────────────────────────────────────────────────

export function newDrawingId(): string {
  return `d_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Color constants (duplicated from chartTheme to avoid circular deps) ──────
export const DRAWING_COLORS = {
  trendline:  '#3d7eff',
  hline:      '#f0b429',
  rectangle:  'rgba(61,126,255,0.15)',
  rectBorder: '#3d7eff',
  handle:     '#ffffff',
  handleBg:   '#3d7eff',
  callout:      '#3d7eff',
  calloutFill:  'rgba(19,23,34,0.92)', // near-opaque so text stays readable
} as const;
