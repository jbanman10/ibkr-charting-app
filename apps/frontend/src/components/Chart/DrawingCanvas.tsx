/**
 * DrawingCanvas
 *
 * An absolutely-positioned <canvas> layered over a lightweight-charts chart that
 * handles all drawing *input*. Committed drawings are painted by the chart's
 * DrawingsPrimitive (frame-synced); this canvas only paints the in-progress
 * preview — a shape being created, moved, or resized.
 *
 * Pointer routing:
 *  - Tool active (rectangle/trendline/hline): the canvas captures pointer events
 *    so clicks/drags create shapes instead of panning the chart.
 *  - Selection mode (tool = none): the canvas is pointer-events:none so pans pass
 *    through to the chart — EXCEPT when the pointer is hovering a handle or body
 *    of the currently selected drawing, where we flip it to auto so the shape can
 *    be dragged (move) or resized. Hover is detected via the chart's crosshair
 *    move event, so we know when to flip without stealing pan gestures.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import type { Bar } from '@ibkr-chart/types';
import type {
  Drawing,
  DrawingToolType,
  DrawingPoint,
  DataTimeRange,
  ResizeHandle,
} from '../../lib/drawings';
import {
  renderDrawings,
  hitTestDrawing,
  hitResizeHandle,
  newDrawingId,
  plotRight,
  timeToUnix,
  DRAWING_COLORS,
} from '../../lib/drawings';

export type { DrawingToolType };

interface Props {
  chart: IChartApi | null;
  priceSeries: ISeriesApi<'Candlestick'> | null;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  onDrawingComplete?: () => void;
  onSelect?: (id: string | null) => void;
  onOpenSettings?: (id: string) => void;
  selectedId?: string | null;
  onDragChange?: (id: string | null) => void;
  rectColor?: { border: string; fill: string };
  dataTimeRange?: DataTimeRange | null;
  bars?: Bar[];
  activeTool: DrawingToolType;
  width: number;
  height: number;
}

// Minimum pointer travel (px) that turns a create-click into a create-drag.
const DRAG_THRESHOLD = 4;

type HoverInfo = { mode: 'move' | 'resize'; handle?: ResizeHandle; cursor: string };
type Interaction =
  | { kind: 'move'; orig: Drawing; grab: DrawingPoint }
  | { kind: 'resize'; orig: Drawing; handle: ResizeHandle };

// ─── Pure geometry helpers ────────────────────────────────────────────────────

function cursorForHandle(handle: ResizeHandle, type: Drawing['type']): string {
  if (type === 'trendline') return 'move';
  // Rectangle corners: diagonal resize cursors.
  if (handle === 'tl' || handle === 'br') return 'nwse-resize';
  return 'nesw-resize';
}

/** Move an entire drawing by a logical (time/price) delta. */
function applyMove(d: Drawing, dTime: number, dPrice: number): Drawing {
  if (d.type === 'hline') return { ...d, price: d.price + dPrice };
  const shift = (p: DrawingPoint): DrawingPoint => ({ time: p.time + dTime, price: p.price + dPrice });
  return { ...d, p1: shift(d.p1), p2: shift(d.p2) } as Drawing;
}

/** Resize a drawing by dragging one handle to a new logical point. */
function applyResize(d: Drawing, handle: ResizeHandle, logical: DrawingPoint): Drawing {
  if (d.type === 'trendline') {
    return handle === 'p1' ? { ...d, p1: logical } : { ...d, p2: logical };
  }
  if (d.type === 'rectangle') {
    const tLeft = Math.min(d.p1.time, d.p2.time);
    const tRight = Math.max(d.p1.time, d.p2.time);
    const pLow = Math.min(d.p1.price, d.p2.price);
    const pHigh = Math.max(d.p1.price, d.p2.price);
    // The fixed anchor is the corner diagonally opposite the grabbed one.
    let fixed: DrawingPoint;
    switch (handle) {
      case 'tl': fixed = { time: tRight, price: pLow }; break;  // opposite = br
      case 'tr': fixed = { time: tLeft,  price: pLow }; break;  // opposite = bl
      case 'bl': fixed = { time: tRight, price: pHigh }; break; // opposite = tr
      default:   fixed = { time: tLeft,  price: pHigh };        // 'br' opposite = tl
    }
    // Explicit resize clears extend-right (user is setting a concrete far corner).
    return { ...d, p1: fixed, p2: logical, extendRight: false };
  }
  return d;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DrawingCanvas({
  chart,
  priceSeries,
  drawings,
  onDrawingsChange,
  onDrawingComplete,
  onSelect,
  onOpenSettings,
  selectedId = null,
  onDragChange,
  rectColor,
  dataTimeRange = null,
  bars = [],
  activeTool,
  width,
  height,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [inProgress, setInProgress] = useState<Drawing | null>(null);
  const [firstPoint, setFirstPoint] = useState<DrawingPoint | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Refs so pointer handlers read live values without stale closures.
  const createStartPx = useRef<{ x: number; y: number } | null>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const drawingsRef = useRef(drawings);
  drawingsRef.current = drawings;

  // ─── Redraw (overlay paints only the live preview) ──────────────────────────

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !chart || !priceSeries) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.scale(dpr, dpr);

    const ghost = inProgress ? [inProgress] : [];
    renderDrawings(ctx, ghost, chart, priceSeries, inProgress?.id ?? null, width, height, dataTimeRange);
  }, [inProgress, chart, priceSeries, width, height, dataTimeRange]);

  useEffect(() => { redraw(); }, [redraw]);

  useEffect(() => {
    if (!chart) return;
    chart.timeScale().subscribeVisibleTimeRangeChange(redraw);
    return () => chart.timeScale().unsubscribeVisibleTimeRangeChange(redraw);
  }, [chart, redraw]);

  // ─── Coordinate helpers ─────────────────────────────────────────────────────

  const getLogical = useCallback((e: React.PointerEvent): DrawingPoint | null => {
    if (!chart || !priceSeries) return null;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const price = priceSeries.coordinateToPrice(px.y);
    if (price === null) return null;
    const rawT = chart.timeScale().coordinateToTime(px.x);
    const time: number | null = rawT !== null ? timeToUnix(rawT) : (dataTimeRange ? dataTimeRange.last : null);
    if (time === null) return null;
    const logical: DrawingPoint = { time, price };

    // Hold Ctrl to snap to the nearest candle's high or low (whichever is closer).
    if (e.ctrlKey && bars.length) {
      let nearest = bars[0];
      let best = Infinity;
      for (const b of bars) {
        const d = Math.abs(Number(b.time) - logical.time);
        if (d < best) { best = d; nearest = b; }
      }
      const snapPrice =
        Math.abs(logical.price - nearest.high) <= Math.abs(logical.price - nearest.low)
          ? nearest.high
          : nearest.low;
      return { time: Number(nearest.time), price: snapPrice };
    }

    return logical;
  }, [chart, priceSeries, bars, dataTimeRange]);

  const getPixel = useCallback((e: React.PointerEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // Is `px` over a handle (resize) or body (move) of the selected drawing?
  const computeHover = useCallback((px: { x: number; y: number }): HoverInfo | null => {
    if (!chart || !priceSeries || !selectedId) return null;
    const sel = drawingsRef.current.find((d) => d.id === selectedId);
    if (!sel) return null;
    const edge = plotRight(chart, width);
    const handle = hitResizeHandle(sel, px, chart, priceSeries, dataTimeRange, edge);
    if (handle) return { mode: 'resize', handle, cursor: cursorForHandle(handle, sel.type) };
    if (hitTestDrawing(sel, px, chart, priceSeries, dataTimeRange, width)) {
      return { mode: 'move', cursor: sel.type === 'hline' ? 'ns-resize' : 'move' };
    }
    return null;
  }, [chart, priceSeries, selectedId, dataTimeRange, width]);

  const commitCreate = useCallback((p1: DrawingPoint, p2: DrawingPoint, curPx: { x: number; y: number } | null) => {
    const rectBorder = rectColor?.border ?? DRAWING_COLORS.rectBorder;
    const rectFill = rectColor?.fill ?? DRAWING_COLORS.rectangle;

    let extendRight = false;
    if (curPx && chart) {
      const lastBarX = dataTimeRange ? chart.timeScale().timeToCoordinate(dataTimeRange.last as Time) : null;
      const edge = plotRight(chart, width);
      extendRight = (lastBarX != null && curPx.x >= lastBarX) || curPx.x >= edge - 2;
    }

    const nd: Drawing = activeTool === 'trendline'
      ? { id: newDrawingId(), type: 'trendline', p1, p2, color: DRAWING_COLORS.trendline, width: 1, extended: false, extendRight }
      : { id: newDrawingId(), type: 'rectangle', p1, p2, borderColor: rectBorder, fillColor: rectFill, extendRight };

    onDrawingsChange([...drawingsRef.current, nd]);
    setFirstPoint(null);
    setInProgress(null);
    createStartPx.current = null;
    onSelect?.(nd.id); // select the fresh shape so its handles show for tweaking
    onDrawingComplete?.();
  }, [activeTool, rectColor, chart, dataTimeRange, width, onDrawingsChange, onDrawingComplete, onSelect]);

  // ─── Pointer handlers ───────────────────────────────────────────────────────

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const logical = getLogical(e);
    const px = getPixel(e);

    // Selection mode: begin a move/resize drag if the pointer is on the selected
    // drawing (hover already flipped the canvas to interactive).
    if (activeTool === 'none') {
      const h = hover ?? (px ? computeHover(px) : null);
      if (!h || !logical) return;
      const sel = drawingsRef.current.find((d) => d.id === selectedId);
      if (!sel) return;
      e.stopPropagation();
      canvasRef.current?.setPointerCapture(e.pointerId);
      interactionRef.current = h.mode === 'resize'
        ? { kind: 'resize', orig: sel, handle: h.handle! }
        : { kind: 'move', orig: sel, grab: logical };
      setInProgress(sel);
      onDragChange?.(sel.id);
      return;
    }

    // Tool active: create shapes.
    e.stopPropagation();
    if (!logical) return;

    if (activeTool === 'hline') {
      const id = newDrawingId();
      onDrawingsChange([...drawingsRef.current, {
        id, type: 'hline', price: logical.price, color: DRAWING_COLORS.hline, width: 1, dashed: true,
      }]);
      onSelect?.(id);
      onDrawingComplete?.();
      return;
    }

    if (!firstPoint) {
      // First anchor down — start a create drag (also works as first click).
      setFirstPoint(logical);
      createStartPx.current = px;
      canvasRef.current?.setPointerCapture(e.pointerId);
      const rectBorder = rectColor?.border ?? DRAWING_COLORS.rectBorder;
      const rectFill = rectColor?.fill ?? DRAWING_COLORS.rectangle;
      setInProgress(activeTool === 'trendline'
        ? { id: '__ghost__', type: 'trendline', p1: logical, p2: logical, color: DRAWING_COLORS.trendline, width: 1, extended: false }
        : { id: '__ghost__', type: 'rectangle', p1: logical, p2: logical, borderColor: rectBorder, fillColor: rectFill });
    } else {
      // Second click (two-click fallback).
      commitCreate(firstPoint, logical, px);
    }
  }, [activeTool, hover, selectedId, firstPoint, getLogical, getPixel, computeHover, onDragChange, onDrawingsChange, onDrawingComplete, onSelect, rectColor, commitCreate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const logical = getLogical(e);
    const px = getPixel(e);

    // Active drag of a committed drawing (move/resize).
    const it = interactionRef.current;
    if (it && logical) {
      const live = it.kind === 'move'
        ? applyMove(it.orig, logical.time - it.grab.time, logical.price - it.grab.price)
        : applyResize(it.orig, it.handle, logical);
      setInProgress(live);
      return;
    }

    // Creating a shape: stretch the ghost to the pointer, drive the crosshair.
    if (activeTool !== 'none') {
      if (!logical) return;
      if (chart && priceSeries) chart.setCrosshairPosition(logical.price, logical.time as Time, priceSeries);
      if (firstPoint && inProgress) {
        setInProgress((prev) => (prev && prev.type !== 'hline' ? { ...prev, p2: logical } as Drawing : prev));
      }
      return;
    }

    // Selection mode, not dragging: keep hover/cursor fresh so we release the
    // canvas back to pan-through the moment the pointer leaves the shape.
    if (px) setHover(computeHover(px));
  }, [activeTool, firstPoint, inProgress, getLogical, getPixel, computeHover, chart, priceSeries]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Finish a move/resize drag: commit the live shape.
    const it = interactionRef.current;
    if (it) {
      const live = inProgress;
      interactionRef.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      if (live) onDrawingsChange(drawingsRef.current.map((d) => (d.id === it.orig.id ? live : d)));
      setInProgress(null);
      onDragChange?.(null);
      const px = getPixel(e);
      setHover(px ? computeHover(px) : null);
      return;
    }

    // Finish a create gesture. If the pointer barely moved, treat it as a click
    // and keep the first anchor (two-click mode); otherwise commit the drag.
    if (activeTool !== 'none' && firstPoint && activeTool !== 'hline') {
      const px = getPixel(e);
      const start = createStartPx.current;
      const moved = px && start ? Math.hypot(px.x - start.x, px.y - start.y) : 0;
      if (moved > DRAG_THRESHOLD) {
        const logical = getLogical(e);
        if (logical) commitCreate(firstPoint, logical, px);
      } else {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      }
    }
  }, [activeTool, firstPoint, inProgress, getLogical, getPixel, computeHover, onDrawingsChange, onDragChange, commitCreate]);

  const handlePointerLeave = useCallback(() => {
    chart?.clearCrosshairPosition();
    if (activeTool === 'none' && !interactionRef.current) setHover(null);
  }, [chart, activeTool]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setFirstPoint(null);
      setInProgress(null);
      createStartPx.current = null;
      interactionRef.current = null;
      onDragChange?.(null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
      onDrawingsChange(drawingsRef.current.filter((d) => d.id !== selectedId));
      onSelect?.(null);
    }
  }, [selectedId, onDrawingsChange, onSelect, onDragChange]);

  // ─── Selection via chart clicks (canvas is pass-through in selection mode) ───

  useEffect(() => {
    if (!chart || !priceSeries) return;
    const onClick = (param: { point?: { x: number; y: number } }) => {
      if (activeTool !== 'none') return;
      if (interactionRef.current) return; // a drag just ended — don't reselect
      const pt = param.point;
      if (!pt) { onSelect?.(null); return; }
      for (const d of [...drawingsRef.current].reverse()) {
        if (hitTestDrawing(d, pt, chart, priceSeries, dataTimeRange, width)) {
          onSelect?.(d.id);
          return;
        }
      }
      onSelect?.(null);
    };
    chart.subscribeClick(onClick);
    return () => chart.unsubscribeClick(onClick);
  }, [chart, priceSeries, dataTimeRange, width, activeTool, onSelect]);

  // Double-click on a drawing opens its settings dialog (select + open). Uses a
  // native DOM listener on the shared container (not the chart library's dblclick
  // API) so it works whether the event lands on the chart canvases or on this
  // overlay while it's interactive.
  useEffect(() => {
    if (!chart || !priceSeries) return;
    const el = canvasRef.current?.parentElement;
    if (!el) return;
    const onDbl = (e: MouseEvent) => {
      if (activeTool !== 'none') return;
      const rect = el.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      for (const d of [...drawingsRef.current].reverse()) {
        if (hitTestDrawing(d, pt, chart, priceSeries, dataTimeRange, width)) {
          onSelect?.(d.id);
          onOpenSettings?.(d.id);
          return;
        }
      }
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, [chart, priceSeries, dataTimeRange, width, activeTool, onSelect, onOpenSettings]);

  // Hover detection over the selected drawing, so we know when to make the canvas
  // interactive (vs. letting pans pass through). Uses the chart crosshair event,
  // which fires while the canvas is pass-through.
  useEffect(() => {
    if (!chart || activeTool !== 'none' || !selectedId) { setHover(null); return; }
    const onMove = (param: { point?: { x: number; y: number } }) => {
      if (interactionRef.current) return;
      setHover(param.point ? computeHover(param.point) : null);
    };
    chart.subscribeCrosshairMove(onMove);
    return () => chart.unsubscribeCrosshairMove(onMove);
  }, [chart, activeTool, selectedId, computeHover]);

  // Canvas is interactive when a tool is active, or when hovering/dragging a
  // selected drawing in selection mode. Otherwise it's pass-through so pans work.
  const isToolActive = activeTool !== 'none';
  const interactive = isToolActive || hover !== null || interactionRef.current !== null;
  const cursor = isToolActive ? 'crosshair' : (hover?.cursor ?? 'default');

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        pointerEvents: interactive ? 'auto' : 'none',
        cursor,
        zIndex: 5,
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerLeave}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    />
  );
}
