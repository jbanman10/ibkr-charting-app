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

// ─── Serialisable drawing types ───────────────────────────────────────────────

export type DrawingToolType = 'trendline' | 'hline' | 'rectangle' | 'position' | 'none';

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

export type Drawing = TrendLineDrawing | HLineDrawing | RectangleDrawing | PositionDrawing | AlertDrawing;

// ─── Coordinate helpers ───────────────────────────────────────────────────────

export interface PixelPoint { x: number; y: number }

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

/**
 * Map an absolute time to an x pixel. Within the loaded data we use the chart's
 * own converter; outside it we clamp to the chart edge (so a drawing made on a
 * different timeframe still lines up / shows partially rather than vanishing).
 */
export function timeToX(
  chart: IChartApi,
  time: number,
  range: DataTimeRange | null,
  width: number
): number | null {
  const ts = chart.timeScale();
  let c = ts.timeToCoordinate(time as Time);
  // On a daily/weekly (business-day) chart a numeric time won't resolve directly —
  // retry as the day it falls in so drawings line up across timeframes.
  if (c === null) c = ts.timeToCoordinate(unixToDayString(time) as unknown as Time);
  if (c !== null) return c;
  if (!range) return null;
  if (time <= range.first) return 0;
  if (time >= range.last) return width;
  return interpolateX(chart, time); // in-range but not directly mappable
}

/**
 * Like timeToX, but a time beyond the last loaded bar EXTRAPOLATES at the
 * current px-per-second (measured near the right edge) instead of clamping to
 * the chart edge. Position boxes use this so a fixed-width box keeps its real
 * width when it reaches into the future, rather than visually pinning to the
 * right edge of the chart.
 */
export function timeToXAnchored(
  chart: IChartApi,
  time: number,
  range: DataTimeRange | null,
  width: number
): number | null {
  const ts = chart.timeScale();
  const c = ts.timeToCoordinate(time as Time);
  if (c !== null) return c;
  if (range && time > range.last) {
    const lastX = timeToX(chart, range.last, range, width);
    if (lastX !== null) {
      const probePx = 80;
      const tProbe = ts.coordinateToTime(lastX - probePx);
      if (tProbe !== null) {
        const secPerPx = (range.last - timeToUnix(tProbe)) / probePx;
        if (secPerPx > 0) return lastX + (time - range.last) / secPerPx;
      }
    }
  }
  return timeToX(chart, time, range, width);
}

/**
 * Inverse of timeToXAnchored: map an x pixel PAST the last bar back to an
 * extrapolated unix time (coordinateToTime returns null in the future
 * whitespace). Lets drags — e.g. a position's right-edge handle — reach as far
 * right as the user wants instead of snapping to the last bar.
 */
export function xToTimeAnchored(chart: IChartApi, x: number, range: DataTimeRange | null): number | null {
  const ts = chart.timeScale();
  const t = ts.coordinateToTime(x);
  if (t !== null) return timeToUnix(t);
  if (!range) return null;
  const lastX = timeToX(chart, range.last, range, Number.MAX_SAFE_INTEGER);
  if (lastX === null || x <= lastX) return null;
  const probePx = 80;
  const tProbe = ts.coordinateToTime(lastX - probePx);
  if (tProbe === null) return null;
  const secPerPx = (range.last - timeToUnix(tProbe)) / probePx;
  if (secPerPx <= 0) return null;
  return Math.round(range.last + (x - lastX) * secPerPx);
}

function interpolateX(chart: IChartApi, time: number): number | null {
  const ts = chart.timeScale();
  const vr = ts.getVisibleRange();
  if (!vr) return null;
  const fromT = Number(vr.from), toT = Number(vr.to);
  const fromX = ts.timeToCoordinate(vr.from);
  const toX = ts.timeToCoordinate(vr.to);
  if (fromX === null || toX === null || toT === fromT) return null;
  return fromX + ((time - fromT) / (toT - fromT)) * (toX - fromX);
}

/** Convert a logical drawing point to canvas pixels (clamped via range). */
export function toPixel(
  chart: IChartApi,
  point: DrawingPoint,
  series: { priceToCoordinate: (p: number) => number | null },
  range: DataTimeRange | null = null,
  width = 0
): PixelPoint | null {
  const x = timeToX(chart, point.time, range, width);
  const y = series.priceToCoordinate(point.price);
  if (x === null || y === null) return null;
  return { x, y };
}

/** Convert canvas pixel position back to logical coordinates. */
export function fromPixel(
  chart: IChartApi,
  px: PixelPoint,
  series: { coordinateToPrice: (y: number) => number | null }
): DrawingPoint | null {
  const time = chart.timeScale().coordinateToTime(px.x);
  const price = series.coordinateToPrice(px.y);
  if (time === null || price === null) return null;
  return { time: time as number, price };
}

// ─── Hit testing ──────────────────────────────────────────────────────────────

const HIT_RADIUS = 8; // px tolerance for clicking on a drawing

export function hitTestDrawing(
  drawing: Drawing,
  px: PixelPoint,
  chart: IChartApi,
  series: { priceToCoordinate: (p: number) => number | null },
  range: DataTimeRange | null = null,
  width = 0
): boolean {
  if (drawing.type === 'hline' || drawing.type === 'alert') {
    const y = series.priceToCoordinate(drawing.price);
    if (y === null) return false;
    return Math.abs(px.y - y) < HIT_RADIUS;
  }

  if (drawing.type === 'position') {
    const edge = plotRight(chart, width);
    const x1 = timeToXAnchored(chart, drawing.time1, range, edge);
    const x2 = timeToXAnchored(chart, drawing.time2, range, edge);
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
export type ResizeHandle = 'p1' | 'p2' | 'tl' | 'tr' | 'bl' | 'br' | 'entry' | 'stop' | 'target' | 'right';

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
  series: { priceToCoordinate: (p: number) => number | null },
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

  if (drawing.type === 'position') {
    const x1 = timeToXAnchored(chart, drawing.time1, range, edge);
    const x2 = timeToXAnchored(chart, drawing.time2, range, edge);
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
  series: { priceToCoordinate: (p: number) => number | null },
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
  series: { priceToCoordinate: (p: number) => number | null },
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
  series: { priceToCoordinate: (p: number) => number | null },
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
  series: { priceToCoordinate: (p: number) => number | null },
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
  series: { priceToCoordinate: (p: number) => number | null },
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

const POS_GREEN = '#089981';
const POS_RED   = '#f23645';
const POS_GRAY  = '#b2b5be';

function renderPosition(
  ctx: CanvasRenderingContext2D,
  d: PositionDrawing,
  chart: IChartApi,
  series: { priceToCoordinate: (p: number) => number | null },
  selected: boolean,
  width: number,
  range: DataTimeRange | null
): void {
  const x1r = timeToXAnchored(chart, d.time1, range, width);
  const x2r = timeToXAnchored(chart, d.time2, range, width);
  const yE = series.priceToCoordinate(d.entry);
  const yS = series.priceToCoordinate(d.stop);
  const yT = series.priceToCoordinate(d.target);
  if (x1r === null || x2r === null || yE === null || yS === null || yT === null) return;

  const x = Math.min(x1r, x2r);
  const w = Math.abs(x2r - x1r);
  if (w < 1) return;

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
} as const;
