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

export type DrawingToolType = 'trendline' | 'hline' | 'rectangle' | 'none';

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
  extended: boolean;     // extend both directions to the chart edges
  extendRight?: boolean; // extend only the right edge to the chart edge (and beyond)
}

export interface HLineDrawing {
  id: string;
  type: 'hline';
  price: number;
  color: string;
  width: number;
  dashed: boolean;
}

export interface RectangleDrawing {
  id: string;
  type: 'rectangle';
  p1: DrawingPoint;
  p2: DrawingPoint;
  borderColor: string;
  fillColor: string;
  extendRight?: boolean; // open the right edge to the chart edge (and beyond)
}

export type Drawing = TrendLineDrawing | HLineDrawing | RectangleDrawing;

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
  if (drawing.type === 'hline') {
    const y = series.priceToCoordinate(drawing.price);
    if (y === null) return false;
    return Math.abs(px.y - y) < HIT_RADIUS;
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
// endpoints; rectangles expose their four visual corners.
export type ResizeHandle = 'p1' | 'p2' | 'tl' | 'tr' | 'bl' | 'br';

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

  // Price label
  ctx.fillStyle = d.color;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.fillText(d.price.toFixed(2), width - 70, y - 4);
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
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(endX, endY);
  ctx.stroke();

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

  ctx.strokeStyle = selected ? '#ffffff' : d.borderColor;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x, y, w, h);

  if (selected) {
    drawHandle(ctx, a.x, a.y, d.borderColor);
    drawHandle(ctx, b.x, b.y, d.borderColor);
  }
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
