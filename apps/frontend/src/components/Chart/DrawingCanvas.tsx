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
  applyMove,
  applyResize,
  cloneDrawing,
  newDrawingId,
  plotRight,
  timeToUnix,
  xToTimeAnchored,
  channelLinePriceAt,
  defaultChannelOffset,
  DRAWING_COLORS,
} from '../../lib/drawings';
import { withDefaults, defaultPositionRR } from '../../lib/drawingDefaultsStore';

export type { DrawingToolType };

interface Props {
  chart: IChartApi | null;
  priceSeries: ISeriesApi<'Candlestick'> | null;
  drawings: Drawing[];
  onDrawingsChange: (drawings: Drawing[]) => void;
  onDrawingComplete?: () => void;
  onSelect?: (id: string | null) => void;
  onOpenSettings?: (id: string) => void;
  /** Double-click that hit no drawing — lets the chart check indicator lines. */
  onDblClickMiss?: (pt: { x: number; y: number }) => void;
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
  // `duplicate` means `orig` is a fresh copy being dragged off the original,
  // which stays put — TradingView's ctrl-drag. It changes what pointer-up does
  // (append, not replace) and switches candle snapping off for the gesture.
  | { kind: 'move'; orig: Drawing; grab: DrawingPoint; duplicate?: boolean }
  | { kind: 'resize'; orig: Drawing; handle: ResizeHandle };

// ─── Pure geometry helpers ────────────────────────────────────────────────────

function cursorForHandle(handle: ResizeHandle, type: Drawing['type']): string {
  if (type === 'trendline') return 'move';
  if (type === 'callout') return 'move';
  // Channel: the anchors reposition the base line, the width handle only
  // changes how far apart the two edges sit.
  if (type === 'channel') return handle === 'offset' ? 'ns-resize' : 'move';
  if (type === 'position') return handle === 'right' ? 'ew-resize' : 'ns-resize';
  // Rectangle corners: diagonal resize cursors.
  if (handle === 'tl' || handle === 'br') return 'nwse-resize';
  return 'nesw-resize';
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
  onDblClickMiss,
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

  // `snap: false` turns the ctrl-held candle snap off for one call. Ctrl is
  // overloaded — it is this app's magnet key AND TradingView's duplicate
  // modifier — so a ctrl-drag duplicate would otherwise jump wick to wick
  // while you tried to place it.
  const getLogical = useCallback((e: React.PointerEvent, opts?: { snap?: boolean }): DrawingPoint | null => {
    if (!chart || !priceSeries) return null;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const px = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const price = priceSeries.coordinateToPrice(px.y);
    if (price === null) return null;
    const rawT = chart.timeScale().coordinateToTime(px.x);
    // In the whitespace right of the last bar, extrapolate a real future time
    // (so e.g. a position's right edge can be dragged out as far as wanted)
    // instead of snapping to the last bar.
    const time: number | null = rawT !== null
      ? timeToUnix(rawT)
      : xToTimeAnchored(chart, px.x, dataTimeRange, priceSeries) ?? (dataTimeRange ? dataTimeRange.last : null);
    if (time === null) return null;
    const logical: DrawingPoint = { time, price };

    // Hold Ctrl to snap to the nearest candle's high or low: above the high →
    // high, below the low → low, inside the candle's range → whichever wick is
    // nearer (ties go to the high).
    if ((opts?.snap ?? true) && e.ctrlKey && bars.length) {
      let nearest = bars[0];
      let best = Infinity;
      for (const b of bars) {
        const d = Math.abs(Number(b.time) - logical.time);
        if (d < best) { best = d; nearest = b; }
      }
      const hi = Number(nearest.high);
      const lo = Number(nearest.low);
      let snapPrice: number;
      if (logical.price >= hi) snapPrice = hi;
      else if (logical.price <= lo) snapPrice = lo;
      else snapPrice = hi - logical.price <= logical.price - lo ? hi : lo;
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
      return { mode: 'move', cursor: sel.type === 'hline' || sel.type === 'alert' ? 'ns-resize' : 'move' };
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

    let nd: Drawing;
    if (activeTool === 'callout') {
      // A plain click (no drag) still needs somewhere to put the bubble: offset
      // it up and to the left of the anchor, scaled to the chart's own bar
      // spacing and volatility so it lands sensibly on a 1m or a daily.
      let bubble = p2;
      if (p2.time === p1.time && p2.price === p1.price) {
        let barSec = 60;
        let rise = p1.price * 0.004;
        if (bars.length >= 2) {
          barSec = Math.max(1, Number(bars[bars.length - 1].time) - Number(bars[bars.length - 2].time));
          const recent = bars.slice(-20);
          const avgRange = recent.reduce((a, b) => a + (Number(b.high) - Number(b.low)), 0) / recent.length;
          if (avgRange > 0) rise = avgRange * 3;
        }
        bubble = { time: p1.time - barSec * 10, price: p1.price + rise };
      }
      nd = {
        id: newDrawingId(), type: 'callout',
        anchor: p1, bubble, text: '',
        color: DRAWING_COLORS.callout, fillColor: DRAWING_COLORS.calloutFill, width: 1,
      };
    } else if (activeTool === 'trendline') {
      nd = { id: newDrawingId(), type: 'trendline', p1, p2, color: DRAWING_COLORS.trendline, width: 1, extended: false, extendRight };
    } else if (activeTool === 'channel') {
      // The drag only defines the base edge; the width is inferred from the
      // price action it was drawn along (see defaultChannelOffset), so the
      // channel lands already enclosing the swing. Drag the middle handle to
      // change it.
      nd = {
        id: newDrawingId(), type: 'channel', p1, p2,
        offset: defaultChannelOffset(p1, p2, bars),
        color: DRAWING_COLORS.channel, width: 1,
        fillColor: DRAWING_COLORS.channelFill,
        extended: false, extendRight,
      };
    } else {
      nd = { id: newDrawingId(), type: 'rectangle', p1, p2, borderColor: rectBorder, fillColor: rectFill, extendRight };
    }

    // Saved per-tool defaults are applied last, so "always unfilled channels"
    // (or whatever the user saved) wins over the built-in look. Read live so a
    // change takes effect on the very next drawing, with no reload.
    nd = withDefaults(nd);

    onDrawingsChange([...drawingsRef.current, nd]);
    setFirstPoint(null);
    setInProgress(null);
    createStartPx.current = null;
    onSelect?.(nd.id); // select the fresh shape so its handles show for tweaking
    onDrawingComplete?.();
    // A blank bubble is useless — go straight to the text field.
    if (nd.type === 'callout') onOpenSettings?.(nd.id);
  }, [activeTool, rectColor, chart, dataTimeRange, width, bars, onDrawingsChange, onDrawingComplete, onSelect, onOpenSettings]);

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

      // Ctrl (or ⌘) + drag on the BODY leaves the original where it is and
      // drags a copy off it. Only the body: ctrl on a resize handle still
      // resizes, since duplicating by a corner has no obvious meaning.
      const duplicate = h.mode === 'move' && (e.ctrlKey || e.metaKey);
      if (duplicate) {
        // Re-read the grab point with snapping off, or the first move would
        // jump by the difference between the snapped and real press position.
        const grab = getLogical(e, { snap: false }) ?? logical;
        const copy = cloneDrawing(sel);
        interactionRef.current = { kind: 'move', orig: copy, grab, duplicate: true };
        setInProgress(copy);
        // Deliberately no onDragChange: that hides the dragged drawing's
        // committed copy, and here the original must stay on screen.
        return;
      }

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
      onDrawingsChange([...drawingsRef.current, withDefaults({
        id, type: 'hline', price: logical.price, color: DRAWING_COLORS.hline, width: 1, dashed: true,
      })]);
      onSelect?.(id);
      onDrawingComplete?.();
      return;
    }

    if (activeTool === 'position') {
      // One click places a long position at the click price, spanning ~20 bars.
      // Default risk scales with recent volatility (2× the average bar range of
      // the last 20 bars) so it's tight on a 1m chart and sensible on a daily.
      // The reward multiple comes from the saved default (2R out of the box) —
      // a position has no colours to remember, so its R multiple is what
      // "save as default" keeps. Drag the handles (or edit the numbers via
      // double-click settings) to adjust; drag target below entry for a short.
      let barSec = 60;
      let risk = logical.price * 0.005; // fallback when no bars are loaded
      if (bars.length >= 2) {
        barSec = Math.max(1, Number(bars[bars.length - 1].time) - Number(bars[bars.length - 2].time));
        const recent = bars.slice(-20);
        const avgRange = recent.reduce((a, b) => a + (Number(b.high) - Number(b.low)), 0) / recent.length;
        if (avgRange > 0) risk = avgRange * 2;
      }
      const id = newDrawingId();
      const entry = logical.price;
      onDrawingsChange([...drawingsRef.current, {
        id, type: 'position',
        time1: logical.time, time2: logical.time + barSec * 20,
        entry,
        stop: Number((entry - risk).toFixed(2)),
        target: Number((entry + risk * defaultPositionRR()).toFixed(2)),
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
      // The ghost gets the same defaults as the committed shape, so what you
      // drag out is what you get on release.
      setInProgress(withDefaults(
        activeTool === 'callout'
          ? { id: '__ghost__', type: 'callout', anchor: logical, bubble: logical, text: '', color: DRAWING_COLORS.callout, fillColor: DRAWING_COLORS.calloutFill, width: 1 }
          : activeTool === 'trendline'
            ? { id: '__ghost__', type: 'trendline', p1: logical, p2: logical, color: DRAWING_COLORS.trendline, width: 1, extended: false }
            : activeTool === 'channel'
              ? { id: '__ghost__', type: 'channel', p1: logical, p2: logical, offset: 0, color: DRAWING_COLORS.channel, width: 1, fillColor: DRAWING_COLORS.channelFill, extended: false }
              : { id: '__ghost__', type: 'rectangle', p1: logical, p2: logical, borderColor: rectBorder, fillColor: rectFill }));
    } else {
      // Second click (two-click fallback).
      commitCreate(firstPoint, logical, px);
    }
  }, [activeTool, hover, selectedId, firstPoint, bars, getLogical, getPixel, computeHover, onDragChange, onDrawingsChange, onDrawingComplete, onSelect, rectColor, commitCreate]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const it = interactionRef.current;
    // A duplicate drag holds ctrl the whole way, which would otherwise keep the
    // copy snapping to candle wicks instead of following the pointer.
    const logical = getLogical(e, it?.kind === 'move' && it.duplicate ? { snap: false } : undefined);
    const px = getPixel(e);

    // Active drag of a committed drawing (move/resize).
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
        setInProgress((prev) => {
          if (!prev) return prev;
          // The callout's second point is its bubble, not a p2.
          if (prev.type === 'callout') return { ...prev, bubble: logical };
          // The channel previews its inferred width live, so the band you see
          // while dragging is the one you get on release.
          if (prev.type === 'channel') {
            return { ...prev, p2: logical, offset: defaultChannelOffset(prev.p1, logical, bars) };
          }
          return prev.type !== 'hline' ? { ...prev, p2: logical } as Drawing : prev;
        });
      }
      return;
    }

    // Selection mode, not dragging: keep hover/cursor fresh so we release the
    // canvas back to pan-through the moment the pointer leaves the shape.
    if (px) setHover(computeHover(px));
  }, [activeTool, firstPoint, inProgress, bars, getLogical, getPixel, computeHover, chart, priceSeries]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    // Finish a move/resize drag: commit the live shape.
    const it = interactionRef.current;
    if (it) {
      const live = inProgress;
      interactionRef.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      if (live) {
        if (it.kind === 'move' && it.duplicate) {
          // Append: the original is still in the list and must stay there.
          onDrawingsChange([...drawingsRef.current, live]);
          onSelect?.(live.id); // the copy is what you are now holding
        } else {
          onDrawingsChange(drawingsRef.current.map((d) => (d.id === it.orig.id ? live : d)));
        }
      }
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
      // A callout always commits on release: a plain click drops it with a
      // default bubble offset (see commitCreate) and opens the text field, so
      // there's no half-placed state waiting on a second click.
      if (activeTool === 'callout') {
        const logical = moved > DRAG_THRESHOLD ? getLogical(e) : firstPoint;
        canvasRef.current?.releasePointerCapture(e.pointerId);
        if (logical) commitCreate(firstPoint, logical, px);
        return;
      }
      if (moved > DRAG_THRESHOLD) {
        const logical = getLogical(e);
        if (logical) commitCreate(firstPoint, logical, px);
      } else {
        canvasRef.current?.releasePointerCapture(e.pointerId);
      }
    }
  }, [activeTool, firstPoint, inProgress, getLogical, getPixel, computeHover, onDrawingsChange, onDragChange, onSelect, commitCreate]);

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
      onDblClickMiss?.(pt); // no drawing here — maybe an indicator line
    };
    el.addEventListener('dblclick', onDbl);
    return () => el.removeEventListener('dblclick', onDbl);
  }, [chart, priceSeries, dataTimeRange, width, activeTool, onSelect, onOpenSettings, onDblClickMiss]);

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
