import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { Bar, IndicatorConfig, Timeframe, ContractSearchResult, Tick } from '@ibkr-chart/types';
import { TIMEFRAMES } from '@ibkr-chart/types';
import type { PanelConfig } from '../../lib/layout';
import type { Drawing, DataTimeRange } from '../../lib/drawings';
import type { DrawingToolType } from './DrawingCanvas';
import { useHistoricalBars } from '../../hooks/useHistoricalBars';
import { useSymbolDrawings } from '../../hooks/useSymbolDrawings';
import { seedDrawings } from '../../lib/drawingStore';
import { computeIndicators } from '../../lib/indicators';
import { computeSessionLevels, computeSessionRegions, etParts, classify } from '../../lib/sessions';
import { SESSION_COLORS, RECT_PALETTE, type RectColor } from '../../lib/chartTheme';
import type { SessionOverlays } from '../../lib/layout';
import ChartContainer, { type ChartHandle, type SessionLevelLine } from './ChartContainer';
import PriceDisplay from './PriceDisplay';
import IndicatorPanel from './IndicatorPanel';
import SymbolSearch from '../Toolbar/SymbolSearch';
import TimeframeSelector from '../Toolbar/TimeframeSelector';
import DrawingToolbar from '../Toolbar/DrawingToolbar';
import ExtendedHoursToggle from '../Toolbar/ExtendedHoursToggle';
import styles from './ChartPanel.module.css';

// Session overlays only make sense on fine-grained intraday timeframes.
const INTRADAY_TF: ReadonlySet<string> = new Set(['1m', '5m', '15m', '30m', '1h']);

function buildSessionLines(
  levels: ReturnType<typeof computeSessionLevels>,
  ov: SessionOverlays
): SessionLevelLine[] {
  const out: SessionLevelLine[] = [];
  const push = (key: string, price: number | null, color: string, title: string, solid = false) => {
    if (price != null) out.push({ key, price, color, title, solid });
  };
  if (ov.prevDayHL) {
    push('PDH', levels.prevDayHigh, SESSION_COLORS.prevDayHigh, 'PDH', true);
    push('PDL', levels.prevDayLow, SESSION_COLORS.prevDayLow, 'PDL', true);
  }
  if (ov.premarketHL) {
    push('PMH', levels.premarketHigh, SESSION_COLORS.premarket, 'PMH');
    push('PML', levels.premarketLow, SESSION_COLORS.premarket, 'PML');
  }
  if (ov.openingRange) {
    push('ORH', levels.orHigh, SESSION_COLORS.openingRange, 'ORH');
    push('ORL', levels.orLow, SESSION_COLORS.openingRange, 'ORL');
  }
  return out;
}

interface Props {
  panel: PanelConfig;
  activeTool: DrawingToolType;
  onToolChange: (tool: DrawingToolType) => void;
  onPanelChange: (updates: Partial<PanelConfig>) => void;
  onClose?: () => void;
  canClose: boolean;
  subscribe: (sym: string, secType: string, exchange: string, currency: string, tf: Timeframe, useRTH?: 0 | 1) => void;
  unsubscribe: (sym: string) => void;
  ibkrConnected: boolean;
  isFocused: boolean;
  onFocus: () => void;
}

export default function ChartPanel({
  panel,
  activeTool,
  onToolChange,
  onPanelChange,
  onClose,
  canClose,
  subscribe,
  unsubscribe,
  ibkrConnected,
  isFocused,
  onFocus,
}: Props) {
  const chartRef = useRef<ChartHandle>(null);
  const barsRef = useRef<Bar[]>([]);
  const chartReadyRef = useRef(false);
  // Live (tick-by-tick) candle state
  const currentBarRef = useRef<Bar | null>(null);          // the forming bar being painted
  const quoteRef = useRef({ bid: 0, ask: 0, last: 0 });    // running quote (ticks are sparse)
  const rafRef = useRef<number | null>(null);              // coalesces tick redraws to 1/frame
  const [showIndicators, setShowIndicators] = useState(false);

  // Push the current forming bar to the chart, at most once per animation frame.
  const scheduleLiveRedraw = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (currentBarRef.current) chartRef.current?.updateBar(currentBarRef.current);
    });
  }, []);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // ─── Historical data ──────────────────────────────────────────────────────

  const { bars, loading, error } = useHistoricalBars(
    panel.symbol,
    panel.secType,
    panel.exchange,
    panel.currency,
    panel.timeframe,
    (panel.useRTH ?? 0) as 0 | 1
  );

  // Recompute session levels + pre/post shading from the current bar history.
  // Intraday-only; clears the overlays on daily/weekly or when toggled off.
  const recomputeSessions = useCallback(() => {
    const handle = chartRef.current;
    if (!handle) return;
    const ov = panel.sessionOverlays;
    let bars = barsRef.current;
    if (!INTRADAY_TF.has(panel.timeframe) || !bars.length) {
      handle.setSessionLevels([]);
      handle.setSessionRegions([]);
      return;
    }
    // Include the live forming bar so the shading/levels extend to the newest
    // candle instead of lagging until the bar closes.
    const forming = currentBarRef.current;
    if (forming && Number(forming.time) > Number(bars[bars.length - 1].time)) {
      bars = [...bars, forming];
    }
    handle.setSessionLevels(buildSessionLines(computeSessionLevels(bars), ov));
    handle.setSessionRegions(ov.shading ? computeSessionRegions(bars) : []);
  }, [panel.timeframe, panel.sessionOverlays]);

  const loadBarsIntoChart = useCallback((currentBars: Bar[]) => {
    if (!chartRef.current || !currentBars.length) return;
    chartRef.current.setData(currentBars);
    // Seed the live forming bar with the most recent historical bar so ticks have
    // a base to paint onto before the first server bar_update arrives.
    currentBarRef.current = { ...currentBars[currentBars.length - 1] };
    const active = panel.indicators.filter((i) => i.visible);
    if (active.length) {
      chartRef.current.setIndicators(computeIndicators(currentBars, active, panel.timeframe));
    }
    recomputeSessions();
  }, [panel.indicators, panel.timeframe, recomputeSessions]);

  // Re-apply overlays when toggles or timeframe change (bars already loaded).
  useEffect(() => { recomputeSessions(); }, [recomputeSessions]);

  // Called by ChartContainer once its lightweight-charts instance is created
  const handleChartReady = useCallback(() => {
    chartReadyRef.current = true;
    if (barsRef.current.length) loadBarsIntoChart(barsRef.current);
  }, [loadBarsIntoChart]);

  // Load bars into chart when they arrive (chart may already be ready)
  useEffect(() => {
    if (!bars.length) return;
    barsRef.current = bars;
    if (chartReadyRef.current) loadBarsIntoChart(bars);
  }, [bars, loadBarsIntoChart]);

  // Recompute indicators when config changes
  useEffect(() => {
    if (!chartRef.current || !barsRef.current.length) return;
    const active = panel.indicators.filter((i) => i.visible);
    chartRef.current.setIndicators(computeIndicators(barsRef.current, active, panel.timeframe));
  }, [panel.indicators, panel.timeframe]);

  // Periodic deep re-sync with IBKR's official history — the automatic version
  // of a manual refresh, with the viewport preserved. Needed because IBKR
  // incorporates late trade reports into history minutes after the fact, so a
  // bar (and levels derived from it, e.g. ORH/PMH) can be wrong long after the
  // fast 90s backend reconcile stopped covering it. Panels are jittered so they
  // don't burst the pacing queue in sync.
  useEffect(() => {
    if (!panel.symbol) return;
    const REFRESH_MS = 180_000 + Math.random() * 30_000;
    const ctrl = new AbortController();

    const timer = setInterval(async () => {
      if (!chartReadyRef.current || !barsRef.current.length) return;
      try {
        const params = new URLSearchParams({
          symbol: panel.symbol,
          secType: panel.secType,
          exchange: panel.exchange,
          currency: panel.currency,
          timeframe: panel.timeframe,
          useRTH: String(panel.useRTH ?? 0),
        });
        const res = await fetch(`/api/bars?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { bars?: Bar[] };
        const official = body.bars ?? [];
        if (official.length < 2) return;

        barsRef.current = official;
        // Keep the live forming bar on the end; buildSeries de-dupes by time
        // keeping the later entry, so the forming bar wins over a partial
        // last-history bucket.
        const forming = currentBarRef.current;
        const series = forming && Number(forming.time) >= Number(official[official.length - 1].time)
          ? [...official, forming]
          : official;
        chartRef.current?.correctBars(series);
        const active = panel.indicators.filter((i) => i.visible);
        if (active.length) chartRef.current?.setIndicators(computeIndicators(official, active, panel.timeframe));
        recomputeSessions();
      } catch {
        /* transient (abort/net) — next cycle retries */
      }
    }, REFRESH_MS);

    return () => { ctrl.abort(); clearInterval(timer); };
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, panel.useRTH, panel.indicators, recomputeSessions]);

  // ─── RT streaming subscription ────────────────────────────────────────────

  useEffect(() => {
    if (!ibkrConnected || !panel.symbol) return;
    subscribe(panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, (panel.useRTH ?? 0) as 0 | 1);
    return () => unsubscribe(panel.symbol);
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, panel.useRTH, ibkrConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── RT bar handlers ──────────────────────────────────────────────────────

  const barUpdateRef = useRef((symbol: string, bar: Bar) => {
    if (symbol !== panel.symbol) return;
    currentBarRef.current = { ...bar };
    chartRef.current?.updateBar(bar);
  });

  const barCloseRef = useRef((symbol: string, bar: Bar) => {
    if (symbol !== panel.symbol) return;
    const bars = barsRef.current;
    const idx = bars.findIndex((b) => b.time === bar.time);
    if (idx >= 0) bars[idx] = bar; else bars.push(bar);
    barsRef.current = bars;
    currentBarRef.current = { ...bar };
    chartRef.current?.addBar(bar);
    const active = panel.indicators.filter((i) => i.visible);
    if (active.length) chartRef.current?.setIndicators(computeIndicators(bars, active, panel.timeframe));
  });

  // Paint each tick onto the forming candle (TradingView-style real-time movement).
  // Assigned for real in the effect below (mirrors the bar handlers).
  const tickHandlerRef = useRef<(symbol: string, tick: Tick) => void>(() => {});

  const applyTick = useCallback((symbol: string, tick: Tick) => {
    if (symbol !== panel.symbol) return;

    // Ticks are sparse (one of last/bid/ask per message) — keep a running quote.
    const q = quoteRef.current;
    if (tick.last > 0) q.last = tick.last;
    if (tick.bid > 0) q.bid = tick.bid;
    if (tick.ask > 0) q.ask = tick.ask;

    // Prefer the traded price; fall back to the bid/ask mid (forex/quiet markets).
    const price = q.last > 0 ? q.last : (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : 0);
    const base = currentBarRef.current;
    if (price <= 0 || !base) return;

    // Daily/weekly candles are RTH-only (the backend fetches/streams them with
    // useRTH=1) — don't let pre/post-market ticks extend today's candle either.
    if (panel.timeframe === '1d' || panel.timeframe === '1w') {
      const sec = Math.floor(tick.timestamp / 1000);
      if (classify(etParts(sec).minuteOfDay) !== 'rth') return;
    }

    const tfSec = TIMEFRAMES[panel.timeframe].seconds;
    const barTime = Math.floor((tick.timestamp / 1000) / tfSec) * tfSec;

    if (barTime < Number(base.time)) return; // stale tick for an old bar

    if (barTime > Number(base.time)) {
      // New minute — open the candle immediately at the first trade so it doesn't
      // lag the ~5s server bar. The server bar_update re-anchors this candle's
      // OHLC to real trades, and bar_close corrects the just-finished bar (which
      // is now no longer the chart's last point) via correctBars — see barClose.
      currentBarRef.current = { time: barTime, open: price, high: price, low: price, close: price, volume: 0 };
    } else {
      // Same window — move close, extend high/low provisionally. The next server
      // bar_update re-anchors these to the real 5s aggregation.
      base.close = price;
      if (price > base.high) base.high = price;
      if (price < base.low) base.low = price;
    }
    scheduleLiveRedraw();
  }, [panel.symbol, panel.timeframe, scheduleLiveRedraw]);

  useEffect(() => {
    barUpdateRef.current = (symbol: string, bar: Bar) => {
      if (symbol !== panel.symbol) return;
      const cur = currentBarRef.current;
      if (cur && Number(bar.time) === Number(cur.time)) {
        if (INTRADAY_TF.has(panel.timeframe)) {
          // Trust the server's 5s-aggregated bar as the source of truth so any
          // provisional tick wick is re-anchored to real trades on every update
          // (~5s). Without this a stray tick print would inflate the candle and,
          // because Math.max/min can only grow the range, it would persist until
          // a manual refresh.
          currentBarRef.current = { ...bar };
        } else {
          // Daily/weekly: keep the protective merge so a pre-prime partial update
          // can't shrink the day's range back to the launch price. Sub-bar wick
          // precision is irrelevant at this scale.
          currentBarRef.current = {
            time: cur.time,
            open: cur.open,
            high: Math.max(cur.high, bar.high),
            low: Math.min(cur.low, bar.low),
            close: bar.close,
            volume: Math.max(cur.volume, bar.volume),
          };
        }
      } else if (!cur || Number(bar.time) > Number(cur.time)) {
        currentBarRef.current = { ...bar }; // a brand-new bar
      } else {
        return; // older than the current forming bar — ignore
      }
      chartRef.current?.updateBar(currentBarRef.current);
      // Keep pre/post shading + levels tracking the live forming bar (~5s cadence).
      recomputeSessions();
    };
    barCloseRef.current = (symbol: string, bar: Bar) => {
      if (symbol !== panel.symbol) return;
      const bars = barsRef.current;
      const idx = bars.findIndex((b) => Number(b.time) === Number(bar.time));
      if (idx >= 0) {
        // Backend reconciliation re-emits recent official bars every ~90s; most
        // match what's already on the chart — skip the re-render for those.
        const cur = bars[idx];
        if (
          cur.open === bar.open && cur.high === bar.high && cur.low === bar.low &&
          cur.close === bar.close && cur.volume === bar.volume
        ) return;
        bars[idx] = bar;
      } else {
        bars.push(bar);
      }
      barsRef.current = bars;
      const cur = currentBarRef.current;
      if (cur && Number(cur.time) > Number(bar.time)) {
        // Ticks already opened a newer candle, so the closed bar is no longer the
        // chart's last point — update() can't touch it. Re-render with the
        // authoritative closed bar (preserving the viewport) and keep the live
        // forming bar on the end.
        chartRef.current?.correctBars([...bars, cur]);
      } else {
        // Closed bar is still the last point — finalize it cheaply in place.
        currentBarRef.current = { ...bar };
        chartRef.current?.addBar(bar);
      }
      const active = panel.indicators.filter((i) => i.visible);
      if (active.length) chartRef.current?.setIndicators(computeIndicators(bars, active, panel.timeframe));
      recomputeSessions();
    };
    tickHandlerRef.current = applyTick;
  }, [panel.symbol, panel.indicators, panel.timeframe, applyTick, recomputeSessions]);

  useEffect(() => {
    const el = document.getElementById(`chart-panel-${panel.id}`);
    if (!el) return;
    (el as any).__barUpdateHandler = (sym: string, bar: Bar) => barUpdateRef.current(sym, bar);
    (el as any).__barCloseHandler  = (sym: string, bar: Bar) => barCloseRef.current(sym, bar);
    (el as any).__tickHandler      = (sym: string, tick: Tick) => tickHandlerRef.current(sym, tick);
    return () => {
      (el as any).__barUpdateHandler = null;
      (el as any).__barCloseHandler  = null;
      (el as any).__tickHandler      = null;
    };
  }, [panel.id]);

  // ─── UI handlers ──────────────────────────────────────────────────────────

  const handleSymbolSelect = useCallback((result: ContractSearchResult) => {
    unsubscribe(panel.symbol);
    onPanelChange({
      symbol: result.symbol,
      secType: result.secType,
      exchange: result.exchange || 'SMART',
      currency: result.currency,
    });
  }, [panel.symbol, unsubscribe, onPanelChange]);

  // Drawings live in a per-symbol store so they appear on every chart of this
  // symbol (any timeframe / any panel), lined up by absolute time.
  const [drawings, setDrawings] = useSymbolDrawings(panel.symbol);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [rectColor, setRectColor] = useState<RectColor>(RECT_PALETTE[0]);

  // One-time migration of any legacy per-panel drawings into the symbol store.
  useEffect(() => {
    if (panel.drawings?.length) seedDrawings(panel.symbol, panel.drawings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDrawingsChange = useCallback((next: Drawing[]) => {
    setDrawings(next);
  }, [setDrawings]);

  const updateSelectedDrawing = useCallback((patch: Partial<Drawing>) => {
    if (!selectedDrawingId) return;
    setDrawings(drawings.map((d) => (d.id === selectedDrawingId ? { ...d, ...patch } as Drawing : d)));
  }, [selectedDrawingId, drawings, setDrawings]);

  const deleteSelectedDrawing = useCallback(() => {
    if (!selectedDrawingId) return;
    setDrawings(drawings.filter((d) => d.id !== selectedDrawingId));
    setSelectedDrawingId(null);
  }, [selectedDrawingId, drawings, setDrawings]);

  const selectedDrawing = drawings.find((d) => d.id === selectedDrawingId) ?? null;

  // Backspace/Delete removes the highlighted drawing; Escape deselects. Scoped to
  // the focused panel and ignored while typing in inputs.
  useEffect(() => {
    if (!isFocused || !selectedDrawingId) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelectedDrawing();
      } else if (e.key === 'Escape') {
        setSelectedDrawingId(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFocused, selectedDrawingId, deleteSelectedDrawing]);

  // Absolute time extent of loaded bars — used to clamp drawings that extend
  // beyond the loaded window (so they line up across timeframes).
  const dataTimeRange: DataTimeRange | null = useMemo(
    () => (bars.length ? { first: Number(bars[0].time), last: Number(bars[bars.length - 1].time) } : null),
    [bars]
  );

  const displayData = bars.length > 0 ? bars[bars.length - 1] : null;

  return (
    <div
      id={`chart-panel-${panel.id}`}
      className={`${styles.panel} ${isFocused ? styles.focused : ''}`}
      onClick={onFocus}
    >
      {/* ── Panel toolbar ─────────────────────────────────────────────── */}
      <div className={styles.panelToolbar}>
        <SymbolSearch currentSymbol={panel.symbol} onSelect={handleSymbolSelect} />
        <TimeframeSelector
          value={panel.timeframe}
          onChange={(tf: Timeframe) => onPanelChange({ timeframe: tf })}
        />
        <ExtendedHoursToggle
          useRTH={(panel.useRTH ?? 0) as 0 | 1}
          onChange={(useRTH) => onPanelChange({ useRTH })}
        />
        <DrawingToolbar
          activeTool={isFocused ? activeTool : 'none'}
          onToolChange={onToolChange}
          onClearDrawings={() => { setDrawings([]); setSelectedDrawingId(null); }}
          drawingCount={drawings.length}
        />
        <div className={styles.panelActions}>
          <button
            className={`${styles.actionBtn} ${showIndicators ? styles.actionActive : ''}`}
            onClick={(e) => { e.stopPropagation(); setShowIndicators((v) => !v); }}
            title="Indicators"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M1 3.5h12M1 7h8M1 10.5h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          <button
            className={styles.actionBtn}
            onClick={(e) => { e.stopPropagation(); chartRef.current?.fitContent(); }}
            title="Fit content"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <rect x="1.5" y="1.5" width="11" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M4.5 9.5V5.5H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </button>
          {canClose && (
            <button
              className={`${styles.actionBtn} ${styles.closeBtn}`}
              onClick={(e) => { e.stopPropagation(); onClose?.(); }}
              title="Close panel"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* ── Chart area ────────────────────────────────────────────────── */}
      <div className={styles.chartArea}>
        <div className={styles.ohlcvRow}>
          <PriceDisplay symbol={panel.symbol} data={displayData} />
        </div>

        {loading && (
          <div className={styles.overlay}>
            <div className={styles.spinner} />
            <span>Loading {panel.symbol}…</span>
          </div>
        )}
        {error && !loading && (
          <div className={styles.overlay}>
            <span className={styles.errorText}>⚠ {error}</span>
          </div>
        )}

        <ChartContainer
          ref={chartRef}
          timeframe={panel.timeframe}
          activeTool={isFocused ? activeTool : 'none'}
          drawings={drawings}
          bars={bars}
          selectedDrawingId={selectedDrawingId}
          onDrawingsChange={handleDrawingsChange}
          onDrawingSelect={setSelectedDrawingId}
          rectColor={{ border: rectColor.border, fill: rectColor.fill }}
          dataTimeRange={dataTimeRange}
          onReady={handleChartReady}
          onDrawingComplete={() => onToolChange('none')}
        />

        {selectedDrawing && (
          <div className={styles.drawingOptions} onClick={(e) => e.stopPropagation()}>
            {selectedDrawing.type === 'rectangle' && (
              <div className={styles.swatchRow}>
                {RECT_PALETTE.map((c) => (
                  <button
                    key={c.name}
                    className={styles.swatch}
                    style={{ background: c.border }}
                    title={c.name}
                    onClick={() => { updateSelectedDrawing({ borderColor: c.border, fillColor: c.fill } as Partial<Drawing>); setRectColor(c); }}
                  />
                ))}
              </div>
            )}
            {(selectedDrawing.type === 'rectangle' || selectedDrawing.type === 'trendline') && (
              <button
                className={`${styles.optBtn} ${(selectedDrawing as any).extendRight ? styles.optActive : ''}`}
                onClick={() => updateSelectedDrawing({ extendRight: !(selectedDrawing as any).extendRight } as Partial<Drawing>)}
                title="Extend the right edge to the chart edge"
              >
                Extend →
              </button>
            )}
            <button className={styles.optBtn} onClick={deleteSelectedDrawing} title="Delete drawing">
              Delete
            </button>
          </div>
        )}

        {showIndicators && (
          <div className={styles.indicatorOverlay} onClick={(e) => e.stopPropagation()}>
            <IndicatorPanel
              indicators={panel.indicators}
              onChange={(indicators: IndicatorConfig[]) => onPanelChange({ indicators })}
              sessionOverlays={panel.sessionOverlays}
              onSessionOverlaysChange={(sessionOverlays) => onPanelChange({ sessionOverlays })}
            />
          </div>
        )}
      </div>
    </div>
  );
}
