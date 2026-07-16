import {
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useState,
} from 'react';
import { createChart, ColorType } from 'lightweight-charts';
import type {
  IChartApi,
  ISeriesApi,
  IPriceLine,
  CandlestickData,
  LineData,
  HistogramData,
  Time,
  DeepPartial,
  ChartOptions,
} from 'lightweight-charts';
import { LineStyle } from 'lightweight-charts';
import type { Bar } from '@ibkr-chart/types';
import type { IndicatorSeries } from '../../lib/indicators';
import type { Drawing, DataTimeRange } from '../../lib/drawings';
import type { SessionRegion } from '../../lib/sessions';
import { SessionShadingPrimitive } from '../../lib/sessionShadingPrimitive';
import { DrawingsPrimitive } from '../../lib/drawingsPrimitive';
import { etTickMarkFormatter, etCrosshairFormatter } from '../../lib/chartTime';
import { indicatorColors } from '../../lib/chartTheme';
import DrawingCanvas, { type DrawingToolType } from './DrawingCanvas';

// ─── Time conversion ──────────────────────────────────────────────────────────
// lightweight-charts v4 requires daily bars as "YYYY-MM-DD" strings.
// IBKR sometimes returns time as a string "1749168000" not a number,
// so we handle both types explicitly.

const DAILY_TF = new Set(['1d', '1w']);

// Matches a pre-formatted daily date "YYYY-MM-DD" (what the backend already
// emits for daily/weekly bars). lightweight-charts wants exactly this for daily.
const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when this time value is renderable (positive unix seconds or a YYYY-MM-DD string). */
function isValidChartTime(t: number | string | null | undefined): boolean {
  if (t == null) return false;
  if (typeof t === 'string' && DATE_STR_RE.test(t)) return true;
  return Number(t) > 0;
}

function toChartTime(unixSeconds: number | string, timeframe: string): Time {
  // Backend already emits daily/weekly bars as "YYYY-MM-DD" strings — pass them
  // through untouched. (Running parseInt on "2025-06-30" yields 2025 → 1970.)
  if (typeof unixSeconds === 'string' && DATE_STR_RE.test(unixSeconds)) {
    return unixSeconds as Time;
  }

  if (DAILY_TF.has(timeframe)) {
    // Handle string or number
    const ms = typeof unixSeconds === 'string'
      ? parseInt(unixSeconds, 10) * 1000
      : (unixSeconds as number) * 1000;

    if (isNaN(ms)) {
      console.warn('[ChartContainer] Invalid timestamp:', unixSeconds);
      return '1970-01-01' as Time;
    }

    const d = new Date(ms);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}` as Time;
  }

  const t = typeof unixSeconds === 'string' ? parseInt(unixSeconds, 10) : unixSeconds;
  return t as unknown as Time;
}

// ─── Chart options ────────────────────────────────────────────────────────────

const CHART_OPTIONS: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: '#131722' }, // TV dark chart bg
    textColor: '#787b86',
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: 'rgba(42,46,57,0.55)' },
    horzLines: { color: 'rgba(42,46,57,0.55)' },
  },
  crosshair: { mode: 0 }, // Normal (free-follow). Magnet/snap only while Ctrl is held.
  rightPriceScale: {
    borderColor: '#2a2e39',
    scaleMargins: { top: 0.1, bottom: 0.2 },
  },
  timeScale: {
    borderColor: '#2a2e39',
    timeVisible: true,
    secondsVisible: false,
    // A little blank space to the right of the last candle (breathing room +
    // somewhere to extend a rectangle past the current bar).
    rightOffset: 6,
    // Axis labels in Exchange time (ET); bar data stays UTC epoch.
    tickMarkFormatter: etTickMarkFormatter,
  },
  // Crosshair time tooltip in ET.
  localization: { timeFormatter: etCrosshairFormatter },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
  handleScale: { mouseWheel: true, pinch: true },
};

// ─── Handle ───────────────────────────────────────────────────────────────────

export interface SessionLevelLine {
  key: string;   // unique id, e.g. 'PDH'
  price: number;
  color: string;
  title: string; // axis label
  solid?: boolean; // solid line (PDH/PDL); dashed otherwise
  lineWidth?: number; // 1–4, default 1
}

export interface ChartHandle {
  setData: (bars: Bar[]) => void;
  updateBar: (bar: Bar) => void;
  addBar: (bar: Bar) => void;
  correctBars: (bars: Bar[]) => void;
  setIndicators: (series: IndicatorSeries[]) => void;
  setSessionLevels: (lines: SessionLevelLine[]) => void;
  setSessionRegions: (regions: SessionRegion[]) => void;
  scrollToEnd: () => void;
  fitContent: () => void;
  /** Price under the mouse cursor right now (null when off-chart). For Alt+A alerts. */
  getCursorPrice: () => number | null;
}

interface Props {
  timeframe?: string;
  activeTool?: DrawingToolType;
  drawings?: Drawing[];
  bars?: Bar[];
  selectedDrawingId?: string | null;
  onDrawingsChange?: (d: Drawing[]) => void;
  onDrawingSelect?: (id: string | null) => void;
  onDrawingOpenSettings?: (id: string) => void;
  onIndicatorOpenSettings?: (key: string) => void;
  onSessionLevelOpenSettings?: (key: string) => void;
  rectColor?: { border: string; fill: string };
  dataTimeRange?: DataTimeRange | null;
  onReady?: () => void;
  onDrawingComplete?: () => void;
  /** Volume of the bar under the crosshair (null when off-chart). */
  onHoverVolume?: (volume: number | null) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

const ChartContainer = forwardRef<ChartHandle, Props>(
  ({ timeframe = '1d', activeTool = 'none', drawings = [], bars = [], selectedDrawingId = null, onDrawingsChange, onDrawingSelect, onDrawingOpenSettings, onIndicatorOpenSettings, onSessionLevelOpenSettings, rectColor, dataTimeRange = null, onReady, onDrawingComplete, onHoverVolume }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef     = useRef<IChartApi | null>(null);
    const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const volumeRef    = useRef<ISeriesApi<'Histogram'> | null>(null);
    const linesRef     = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
    const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
    const shadingRef    = useRef<SessionShadingPrimitive | null>(null);
    const drawingsPrimRef = useRef<DrawingsPrimitive | null>(null);
    const tfRef        = useRef(timeframe);
    // Newest bar time (unix seconds) currently on the chart. lightweight-charts'
    // update() can only touch the last point or append a newer one — so we drop
    // any update for an older time (e.g. a late bar_close after a tick already
    // rolled the chart to the next minute).
    const lastTimeRef  = useRef(0);
    const cursorPriceRef = useRef<number | null>(null); // price under the mouse (crosshair)
    const onHoverVolumeRef = useRef(onHoverVolume);
    useEffect(() => { onHoverVolumeRef.current = onHoverVolume; }, [onHoverVolume]);
    const [dims, setDims] = useState({ w: 0, h: 0 });
    // Id of the drawing currently being dragged (move/resize). Its committed copy
    // is hidden from the primitive while the overlay paints the live preview.
    const [draggingId, setDraggingId] = useState<string | null>(null);

    // Keep timeframe ref current so callbacks always use latest value
    useEffect(() => { tfRef.current = timeframe; }, [timeframe]);

    // Crosshair follows the mouse freely; hold Ctrl to magnet/snap it to candles.
    // Only while NO drawing tool is active: the drawing overlay has its own Ctrl
    // high/low snap and positions the crosshair itself — the library's magnet
    // (which anchors to the CLOSE) would yank that feedback to the wrong price
    // and make snapping look broken.
    const activeToolRef = useRef(activeTool);
    useEffect(() => {
      activeToolRef.current = activeTool;
      // If a tool is picked while Ctrl-magnet is already on, drop the magnet.
      if (activeTool !== 'none') chartRef.current?.applyOptions({ crosshair: { mode: 0 } });
    }, [activeTool]);
    useEffect(() => {
      const setMagnet = (on: boolean) =>
        chartRef.current?.applyOptions({ crosshair: { mode: on ? 1 : 0 } });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Control') setMagnet(e.type === 'keydown' && activeToolRef.current === 'none');
      };
      const reset = () => setMagnet(false);
      document.addEventListener('keydown', onKey);
      document.addEventListener('keyup', onKey);
      window.addEventListener('blur', reset); // don't get stuck in magnet on alt-tab
      return () => {
        document.removeEventListener('keydown', onKey);
        document.removeEventListener('keyup', onKey);
        window.removeEventListener('blur', reset);
      };
    }, []);

    // ─── Mount chart ─────────────────────────────────────────────────────────

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const chart = createChart(el, {
        ...CHART_OPTIONS,
        width: el.clientWidth,
        height: el.clientHeight,
      });

      const candle = chart.addCandlestickSeries({
        upColor:         '#089981',
        downColor:       '#f23645',
        borderUpColor:   '#089981',
        borderDownColor: '#f23645',
        wickUpColor:     '#089981',
        wickDownColor:   '#f23645',
      });

      const volume = chart.addHistogramSeries({
        priceFormat:      { type: 'volume' },
        priceScaleId:     'vol',
        lastValueVisible: false,
        priceLineVisible: false,
      });
      chart.priceScale('vol').applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      chartRef.current  = chart;
      candleRef.current = candle;
      volumeRef.current = volume;

      // Render committed drawings inside the chart's render loop (frame-synced
      // with both axes — no lag when dragging the price scale).
      const drawingsPrim = new DrawingsPrimitive();
      candle.attachPrimitive(drawingsPrim);
      drawingsPrimRef.current = drawingsPrim;

      // Crosshair tracking: the price under the cursor (for Alt+A price alerts)
      // and the hovered bar's volume (for the volume readout).
      const onCross = (param: { point?: { x: number; y: number }; seriesData?: Map<unknown, unknown> }) => {
        cursorPriceRef.current = param.point ? candle.coordinateToPrice(param.point.y) : null;
        const vp = param.seriesData?.get(volume) as { value?: number } | undefined;
        onHoverVolumeRef.current?.(
          param.point && vp && typeof vp.value === 'number' ? vp.value : null
        );
      };
      chart.subscribeCrosshairMove(onCross);

      onReady?.();

      // Resize observer. Never re-fit on resize — that yanks the user's view
      // every time the layout shifts (opening the watchlist, grid drags, …).
      // 1m charts stay glued to the live edge (current price); other timeframes
      // keep whatever view the user had.
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        const vr = chart.timeScale().getVisibleLogicalRange();
        chart.applyOptions({ width: w, height: h });
        if (tfRef.current === '1m') chart.timeScale().scrollToRealTime();
        else if (vr) chart.timeScale().setVisibleLogicalRange(vr);
        setDims({ w, h });
      });
      ro.observe(el);
      setDims({ w: el.clientWidth, h: el.clientHeight });

      return () => {
        ro.disconnect();
        chart.remove();
        chartRef.current  = null;
        candleRef.current = null;
        volumeRef.current = null;
        linesRef.current.clear();
        // Price lines + primitives die with the series; just drop refs.
        priceLinesRef.current.clear();
        shadingRef.current = null;
        drawingsPrimRef.current = null;
      };
    }, []); // mount once

    // Keep the drawings primitive in sync with React state (frame-synced render).
    useEffect(() => {
      drawingsPrimRef.current?.setState(drawings, selectedDrawingId, dataTimeRange, draggingId);
    }, [drawings, selectedDrawingId, dataTimeRange, draggingId]);

    // ─── Imperative API ───────────────────────────────────────────────────────

    // Build lightweight-charts candle/volume arrays from raw bars: filter invalid,
    // de-dupe by time (keep latest), sort ascending (the library asserts strictly
    // ascending unique times — a single dup would throw and blank the chart).
    const buildSeries = useCallback((bars: Bar[], tf: string) => {
      const validBars = bars.filter((b) => isValidChartTime(b.time) && Number(b.open) > 0);
      if (validBars.length === 0) return null;

      // De-dupe by the CONVERTED chart time, not the raw time: on daily charts
      // several distinct unix times can collapse to the same "YYYY-MM-DD" (e.g.
      // an intraday bar that leaked in during a timeframe switch), and any
      // post-conversion duplicate throws "asc ordered" and blanks the chart.
      const byTime = new Map<string, Bar>();
      for (const b of validBars) byTime.set(String(toChartTime(b.time, tf)), b);
      const ordered = [...byTime.values()].sort((a, z) => {
        const ta = typeof a.time === 'string' ? Date.parse(a.time) : Number(a.time);
        const tz = typeof z.time === 'string' ? Date.parse(z.time) : Number(z.time);
        return ta - tz;
      });

      const cd: CandlestickData[] = ordered.map((b) => ({
        time:  toChartTime(b.time, tf),
        open:  Number(b.open),
        high:  Number(b.high),
        low:   Number(b.low),
        close: Number(b.close),
      }));
      const vd: HistogramData[] = ordered.map((b) => ({
        time:  toChartTime(b.time, tf),
        value: Number(b.volume),
        color: Number(b.close) >= Number(b.open)
          ? 'rgba(8,153,129,0.4)'
          : 'rgba(242,54,69,0.4)',
      }));
      return { cd, vd, lastTime: Number(ordered[ordered.length - 1].time) };
    }, []);

    const setData = useCallback((bars: Bar[]) => {
      const candle = candleRef.current;
      const volume = volumeRef.current;
      const chart  = chartRef.current;
      if (!candle || !volume || !chart) return;

      const built = buildSeries(bars, tfRef.current);
      if (!built) { console.warn('[ChartContainer] No valid bars to render'); return; }

      try {
        candle.setData(built.cd);
        volume.setData(built.vd);
        lastTimeRef.current = built.lastTime;
        // 1m: open on the last ~3 hours anchored to the live edge (fitContent
        // over 2 days of 1m bars is unreadably zoomed out). Other timeframes
        // fit the full history as before.
        if (tfRef.current === '1m') {
          const n = built.cd.length;
          chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 180), to: n + 6 });
        } else {
          chart.timeScale().fitContent();
        }
        console.log('[ChartContainer] Rendered', built.cd.length, 'bars');
      } catch (err) {
        console.error('[ChartContainer] setData error:', err);
      }
    }, [buildSeries]);

    // Re-render the whole series while PRESERVING the current viewport. Needed to
    // correct a bar that is no longer the chart's last point (the library's
    // update() only touches the last bar) — e.g. an authoritative bar_close that
    // arrives after ticks already opened the next candle.
    const correctBars = useCallback((bars: Bar[]) => {
      const candle = candleRef.current;
      const volume = volumeRef.current;
      const chart  = chartRef.current;
      if (!candle || !volume || !chart) return;

      const built = buildSeries(bars, tfRef.current);
      if (!built) return;

      try {
        const vr = chart.timeScale().getVisibleLogicalRange();
        candle.setData(built.cd);
        volume.setData(built.vd);
        if (vr) chart.timeScale().setVisibleLogicalRange(vr);
        lastTimeRef.current = built.lastTime;
      } catch (err) {
        console.error('[ChartContainer] correctBars error:', err);
      }
    }, [buildSeries]);

    const updateBar = useCallback((bar: Bar) => {
      if (!isValidChartTime(bar.time)) return;
      // Reject stale updates for a time older than the newest bar on the chart —
      // update() only works on the last point and would otherwise throw.
      const ts = Number(bar.time);
      if (ts < lastTimeRef.current) return;
      lastTimeRef.current = ts;
      const tf = tfRef.current;
      const t  = toChartTime(bar.time, tf);
      try {
        candleRef.current?.update({
          time: t, open: Number(bar.open), high: Number(bar.high),
          low: Number(bar.low), close: Number(bar.close),
        });
        volumeRef.current?.update({
          time: t, value: Number(bar.volume),
          color: Number(bar.close) >= Number(bar.open)
            ? 'rgba(8,153,129,0.4)'
            : 'rgba(242,54,69,0.4)',
        });
      } catch (err) {
        console.error('[ChartContainer] updateBar error:', err);
      }
    }, []);

    const addBar = updateBar;

    const setIndicators = useCallback((series: IndicatorSeries[]) => {
      const chart = chartRef.current;
      if (!chart) return;
      const existing = linesRef.current;
      const incoming = new Set(series.map((s) => s.key));

      for (const [key, line] of existing) {
        if (!incoming.has(key)) { chart.removeSeries(line); existing.delete(key); }
      }

      for (const { key, data, color, lineWidth } of series) {
        const opts = {
          color: color ?? indicatorColors[key] ?? '#8a95a8',
          lineWidth: Math.min(4, Math.max(1, lineWidth ?? 1)) as 1 | 2 | 3 | 4,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        };
        const line = existing.get(key);
        if (!line) existing.set(key, chart.addLineSeries(opts));
        else line.applyOptions(opts); // live color/width changes from the settings card
        try {
          // De-dupe by time (keep latest) + sort, matching the candle setData path.
          // Live bar_close merges can briefly duplicate a time in barsRef and
          // lightweight-charts throws on any non-ascending point.
          const byTime = new Map<string, LineData>();
          for (const p of data as LineData[]) byTime.set(String(p.time), p);
          const ordered = [...byTime.values()].sort((a, z) => {
            const ta = typeof a.time === 'string' ? Date.parse(a.time) : Number(a.time);
            const tz = typeof z.time === 'string' ? Date.parse(z.time) : Number(z.time);
            return ta - tz;
          });
          existing.get(key)!.setData(ordered);
        } catch (err) {
          console.error('[ChartContainer] indicator setData error:', key, err);
        }
      }
    }, []);

    // Session level horizontal lines (prev-day H/L, pre-market H/L, opening range).
    const setSessionLevels = useCallback((lines: SessionLevelLine[]) => {
      const candle = candleRef.current;
      if (!candle) return;
      const existing = priceLinesRef.current;
      const incoming = new Set(lines.map((l) => l.key));

      for (const [key, line] of existing) {
        if (!incoming.has(key)) { candle.removePriceLine(line); existing.delete(key); }
      }
      for (const l of lines) {
        const opts = {
          price: l.price,
          color: l.color,
          lineWidth: Math.min(4, Math.max(1, l.lineWidth ?? 1)) as 1 | 2 | 3 | 4,
          lineStyle: l.solid ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.title,
        };
        const prev = existing.get(l.key);
        if (prev) prev.applyOptions(opts);
        else existing.set(l.key, candle.createPriceLine(opts));
      }
    }, []);

    // Pre/post-market background shading via a series primitive (attached lazily).
    const setSessionRegions = useCallback((regions: SessionRegion[]) => {
      const candle = candleRef.current;
      if (!candle) return;
      if (!shadingRef.current) {
        shadingRef.current = new SessionShadingPrimitive();
        candle.attachPrimitive(shadingRef.current);
      }
      shadingRef.current.setRegions(regions);
    }, []);

    const fitContent  = useCallback(() => chartRef.current?.timeScale().fitContent(), []);
    const scrollToEnd = useCallback(() => chartRef.current?.timeScale().scrollToRealTime(), []);
    const getCursorPrice = useCallback(() => cursorPriceRef.current, []);

    // Which indicator line (if any) passes within a few pixels of the point.
    // Walks each line's visible points and measures vertical distance to the
    // segment spanning the click's x — cheap enough for a double-click.
    const hitTestIndicators = useCallback((pt: { x: number; y: number }): string | null => {
      const chart = chartRef.current;
      if (!chart) return null;
      const ts = chart.timeScale();
      const TOL = 6;
      let bestKey: string | null = null;
      let bestDist = TOL + 1;

      for (const [key, series] of linesRef.current) {
        let prev: { x: number; y: number } | null = null;
        for (const p of series.data() as LineData[]) {
          const cx = ts.timeToCoordinate(p.time);
          if (cx == null) { prev = null; continue; } // offscreen
          const cy = series.priceToCoordinate(p.value);
          if (cy == null) { prev = null; continue; }
          if (prev && prev.x <= pt.x && pt.x <= cx) {
            const t = (pt.x - prev.x) / Math.max(1e-9, cx - prev.x);
            const d = Math.abs(pt.y - (prev.y + t * (cy - prev.y)));
            if (d < bestDist) { bestDist = d; bestKey = key; }
          }
          if (cx > pt.x) break; // walked past the click; next line
          prev = { x: cx, y: cy };
        }
      }
      return bestDist <= TOL ? bestKey : null;
    }, []);

    // Which session price line (PDH/PDL/PMH/…) sits within a few pixels of the
    // point. Price lines are horizontal, so it's a plain vertical distance.
    const hitTestSessionLevels = useCallback((pt: { x: number; y: number }): string | null => {
      const candle = candleRef.current;
      if (!candle) return null;
      const TOL = 6;
      let bestKey: string | null = null;
      let bestDist = TOL + 1;
      for (const [key, line] of priceLinesRef.current) {
        const y = candle.priceToCoordinate(line.options().price);
        if (y == null) continue;
        const d = Math.abs(pt.y - y);
        if (d < bestDist) { bestDist = d; bestKey = key; }
      }
      return bestDist <= TOL ? bestKey : null;
    }, []);

    const handleDblClickMiss = useCallback((pt: { x: number; y: number }) => {
      const indKey = hitTestIndicators(pt);
      if (indKey) { onIndicatorOpenSettings?.(indKey); return; }
      const lvlKey = hitTestSessionLevels(pt);
      if (lvlKey) onSessionLevelOpenSettings?.(lvlKey);
    }, [hitTestIndicators, hitTestSessionLevels, onIndicatorOpenSettings, onSessionLevelOpenSettings]);

    useImperativeHandle(ref, () => ({
      setData, updateBar, addBar, correctBars, setIndicators, setSessionLevels, setSessionRegions, fitContent, scrollToEnd, getCursorPrice,
    }), [setData, updateBar, addBar, correctBars, setIndicators, setSessionLevels, setSessionRegions, fitContent, scrollToEnd, getCursorPrice]);

    return (
      <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
        <DrawingCanvas
          chart={chartRef.current}
          priceSeries={candleRef.current}
          drawings={drawings}
          onDrawingsChange={onDrawingsChange ?? (() => {})}
          onDrawingComplete={onDrawingComplete}
          onSelect={onDrawingSelect}
          onOpenSettings={onDrawingOpenSettings}
          onDblClickMiss={handleDblClickMiss}
          selectedId={selectedDrawingId}
          onDragChange={setDraggingId}
          rectColor={rectColor}
          dataTimeRange={dataTimeRange}
          bars={bars}
          activeTool={activeTool}
          width={dims.w}
          height={dims.h}
        />
      </div>
    );
  }
);

ChartContainer.displayName = 'ChartContainer';
export default ChartContainer;
