import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import type { Bar, IndicatorConfig, Timeframe, ContractSearchResult } from '@ibkr-chart/types';
import type { PanelConfig } from '../../lib/layout';
import type { Drawing, DataTimeRange } from '../../lib/drawings';
import type { DrawingToolType } from './DrawingCanvas';
import { useSymbolDrawings } from '../../hooks/useSymbolDrawings';
import { seedDrawings, getDrawings } from '../../lib/drawingStore';
import { computeIndicators } from '../../lib/indicators';
import { computeSessionLevels, computeSessionRegions } from '../../lib/sessions';
import { SESSION_COLORS, RECT_PALETTE, type RectColor } from '../../lib/chartTheme';
import type { SessionOverlays, SessionLevelStyle } from '../../lib/layout';
import ChartContainer, { type ChartHandle, type SessionLevelLine } from './ChartContainer';
import PriceDisplay from './PriceDisplay';
import IndicatorPanel from './IndicatorPanel';
import DrawingSettings from './DrawingSettings';
import IndicatorSettings from './IndicatorSettings';
import SessionLevelSettings from './SessionLevelSettings';
import SymbolSearch from '../Toolbar/SymbolSearch';
import TimeframeSelector from '../Toolbar/TimeframeSelector';
import DrawingToolbar from '../Toolbar/DrawingToolbar';
import ExtendedHoursToggle from '../Toolbar/ExtendedHoursToggle';
import styles from './ChartPanel.module.css';

// Session overlays only make sense on fine-grained intraday timeframes.
const INTRADAY_TF: ReadonlySet<string> = new Set(['1m', '5m', '15m', '30m', '1h']);

// Default look + overlay group for each session level. Single source of truth
// for both line building and the double-click settings card.
const LEVEL_META: Record<string, {
  title: string; color: string; dashed: boolean; group: keyof SessionOverlays;
}> = {
  PDH: { title: 'Prev Day High',      color: SESSION_COLORS.prevDayHigh,  dashed: false, group: 'prevDayHL' },
  PDL: { title: 'Prev Day Low',       color: SESSION_COLORS.prevDayLow,   dashed: false, group: 'prevDayHL' },
  PMH: { title: 'Pre-market High',    color: SESSION_COLORS.premarket,    dashed: true,  group: 'premarketHL' },
  PML: { title: 'Pre-market Low',     color: SESSION_COLORS.premarket,    dashed: true,  group: 'premarketHL' },
  ORH: { title: 'Opening Range High', color: SESSION_COLORS.openingRange, dashed: true,  group: 'openingRange' },
  ORL: { title: 'Opening Range Low',  color: SESSION_COLORS.openingRange, dashed: true,  group: 'openingRange' },
};

function buildSessionLines(
  levels: ReturnType<typeof computeSessionLevels>,
  ov: SessionOverlays,
  styles?: Record<string, SessionLevelStyle>
): SessionLevelLine[] {
  const out: SessionLevelLine[] = [];
  const push = (key: string, price: number | null) => {
    if (price == null) return;
    const meta = LEVEL_META[key];
    const st = styles?.[key];
    out.push({
      key,
      price,
      title: key,
      color: st?.color ?? meta.color,
      solid: !(st?.dashed ?? meta.dashed),
      lineWidth: st?.lineWidth ?? 1,
    });
  };
  if (ov.prevDayHL) {
    push('PDH', levels.prevDayHigh);
    push('PDL', levels.prevDayLow);
  }
  if (ov.premarketHL) {
    push('PMH', levels.premarketHigh);
    push('PML', levels.premarketLow);
  }
  if (ov.openingRange) {
    push('ORH', levels.orHigh);
    push('ORL', levels.orLow);
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
  isMaximized: boolean;
  onToggleMaximize: () => void;
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
  isMaximized,
  onToggleMaximize,
}: Props) {
  const chartRef = useRef<ChartHandle>(null);
  const barsRef = useRef<Bar[]>([]);            // closed bars — authoritative, straight from IBKR
  const chartReadyRef = useRef(false);
  const formingRef = useRef<Bar | null>(null);  // current live (forming) bar
  const gotSnapshotRef = useRef(false);         // has the initial snapshot arrived for this sub?
  const [showIndicators, setShowIndicators] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    const forming = formingRef.current;
    if (forming && Number(forming.time) > Number(bars[bars.length - 1].time)) {
      bars = [...bars, forming];
    }
    handle.setSessionLevels(buildSessionLines(computeSessionLevels(bars), ov, panel.sessionLevelStyles));
    handle.setSessionRegions(ov.shading ? computeSessionRegions(bars) : []);
  }, [panel.timeframe, panel.sessionOverlays, panel.sessionLevelStyles]);

  const renderSnapshot = useCallback((snap: Bar[]) => {
    if (!chartRef.current || !snap.length) return;
    chartRef.current.setData(snap);
    formingRef.current = { ...snap[snap.length - 1] };
    const active = panel.indicators.filter((i) => i.visible);
    if (active.length) chartRef.current.setIndicators(computeIndicators(snap, active, panel.timeframe));
    recomputeSessions();
  }, [panel.indicators, panel.timeframe, recomputeSessions]);

  // Re-apply overlays when toggles or timeframe change (bars already loaded).
  useEffect(() => { recomputeSessions(); }, [recomputeSessions]);

  // Called by ChartContainer once its lightweight-charts instance is created.
  const handleChartReady = useCallback(() => {
    chartReadyRef.current = true;
    if (barsRef.current.length) renderSnapshot(barsRef.current);
  }, [renderSnapshot]);

  // Recompute indicators when config changes.
  useEffect(() => {
    if (!chartRef.current || !barsRef.current.length) return;
    const active = panel.indicators.filter((i) => i.visible);
    chartRef.current.setIndicators(computeIndicators(barsRef.current, active, panel.timeframe));
  }, [panel.indicators, panel.timeframe]);

  // ─── Live subscription (keepUpToDate: snapshot + updates) ──────────────────

  useEffect(() => {
    if (!ibkrConnected || !panel.symbol) return;
    // New subscription → reset to loading until the snapshot arrives.
    setLoading(true);
    setError(null);
    gotSnapshotRef.current = false;
    barsRef.current = [];
    formingRef.current = null;
    subscribe(panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, (panel.useRTH ?? 0) as 0 | 1);
    const t = setTimeout(() => {
      if (!gotSnapshotRef.current) { setError('No data received'); setLoading(false); }
    }, 30_000);
    return () => { clearTimeout(t); unsubscribe(panel.symbol); };
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, panel.useRTH, ibkrConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Stream handlers (snapshot / bar_update / bar_close) ───────────────────
  //
  // Bars come straight from IBKR's keepUpToDate feed (TWS-equivalent): the
  // snapshot is authoritative history, bar_update is the live forming bar, and
  // bar_close finalizes a bar (including late-print corrections to older bars).

  const snapshotHandlerRef = useRef((_s: string, _b: Bar[], _t?: Timeframe) => {});
  const barUpdateRef = useRef((_s: string, _b: Bar, _t?: Timeframe) => {});
  const barCloseRef = useRef((_s: string, _b: Bar, _t?: Timeframe) => {});

  useEffect(() => {
    snapshotHandlerRef.current = (symbol: string, snap: Bar[], tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      gotSnapshotRef.current = true;
      barsRef.current = snap;
      formingRef.current = snap.length ? { ...snap[snap.length - 1] } : null;
      if (chartReadyRef.current) renderSnapshot(snap);
      setError(null);
      setLoading(false);
    };

    barUpdateRef.current = (symbol: string, bar: Bar, tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      formingRef.current = { ...bar };
      chartRef.current?.updateBar(bar);
      recomputeSessions();
    };

    barCloseRef.current = (symbol: string, bar: Bar, tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      const bars = barsRef.current;
      const idx = bars.findIndex((b) => Number(b.time) === Number(bar.time));
      if (idx >= 0) {
        const cur = bars[idx];
        if (cur.open === bar.open && cur.high === bar.high && cur.low === bar.low &&
            cur.close === bar.close && cur.volume === bar.volume) return; // unchanged re-emit
        bars[idx] = bar;
      } else {
        bars.push(bar);
      }
      barsRef.current = bars;
      const forming = formingRef.current;
      if (forming && Number(forming.time) > Number(bar.time)) {
        // Late correction to an older bar (no longer the chart's last point) —
        // re-render preserving the viewport.
        chartRef.current?.correctBars(bars);
      } else {
        formingRef.current = { ...bar };
        chartRef.current?.updateBar(bar);
      }
      const active = panel.indicators.filter((i) => i.visible);
      if (active.length) chartRef.current?.setIndicators(computeIndicators(bars, active, panel.timeframe));
      recomputeSessions();
    };
  }, [panel.symbol, panel.indicators, panel.timeframe, recomputeSessions, renderSnapshot]);

  useEffect(() => {
    const el = document.getElementById(`chart-panel-${panel.id}`);
    if (!el) return;
    (el as any).__snapshotHandler  = (sym: string, b: Bar[], tf?: Timeframe) => snapshotHandlerRef.current(sym, b, tf);
    (el as any).__barUpdateHandler = (sym: string, bar: Bar, tf?: Timeframe) => barUpdateRef.current(sym, bar, tf);
    (el as any).__barCloseHandler  = (sym: string, bar: Bar, tf?: Timeframe) => barCloseRef.current(sym, bar, tf);
    return () => {
      (el as any).__snapshotHandler  = null;
      (el as any).__barUpdateHandler = null;
      (el as any).__barCloseHandler  = null;
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
  const [showDrawingSettings, setShowDrawingSettings] = useState(false);
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
    // Read the latest store state (not the render-time array) so two rapid
    // setting changes in the same tick don't clobber each other.
    const current = getDrawings(panel.symbol);
    setDrawings(current.map((d) => (d.id === selectedDrawingId ? { ...d, ...patch } as Drawing : d)));
    // Remember the last rectangle color so new rectangles use it.
    const p = patch as { borderColor?: string; fillColor?: string };
    if (p.borderColor && p.fillColor) {
      setRectColor(
        RECT_PALETTE.find((c) => c.border === p.borderColor)
          ?? { name: 'Custom', border: p.borderColor, fill: p.fillColor }
      );
    }
  }, [selectedDrawingId, panel.symbol, setDrawings]);

  const deleteSelectedDrawing = useCallback(() => {
    if (!selectedDrawingId) return;
    setDrawings(getDrawings(panel.symbol).filter((d) => d.id !== selectedDrawingId));
    setSelectedDrawingId(null);
    setShowDrawingSettings(false);
  }, [selectedDrawingId, panel.symbol, setDrawings]);

  const selectedDrawing = drawings.find((d) => d.id === selectedDrawingId) ?? null;

  // Indicator settings card, opened by double-clicking an MA line. Keyed by
  // "TYPE-period" (the same key the chart series use).
  const [indicatorSettingsKey, setIndicatorSettingsKey] = useState<string | null>(null);
  const settingsIndicator = indicatorSettingsKey
    ? panel.indicators.find((i) => `${i.type}-${i.period}` === indicatorSettingsKey) ?? null
    : null;

  const updateSettingsIndicator = useCallback((patch: Partial<IndicatorConfig>) => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.map((i) =>
        `${i.type}-${i.period}` === indicatorSettingsKey ? { ...i, ...patch } : i
      ),
    });
  }, [indicatorSettingsKey, panel.indicators, onPanelChange]);

  const removeSettingsIndicator = useCallback(() => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.filter((i) => `${i.type}-${i.period}` !== indicatorSettingsKey),
    });
    setIndicatorSettingsKey(null);
  }, [indicatorSettingsKey, panel.indicators, onPanelChange]);

  // Session level settings card (PDH/PDL/PMH/PML/ORH/ORL), opened by
  // double-clicking the price line on the chart.
  const [sessionLevelKey, setSessionLevelKey] = useState<string | null>(null);
  const sessionLevelMeta = sessionLevelKey ? LEVEL_META[sessionLevelKey] : null;
  const sessionLevelStyle = sessionLevelKey ? panel.sessionLevelStyles?.[sessionLevelKey] : undefined;

  const updateSessionLevel = useCallback((patch: SessionLevelStyle) => {
    if (!sessionLevelKey) return;
    onPanelChange({
      sessionLevelStyles: {
        ...panel.sessionLevelStyles,
        [sessionLevelKey]: { ...panel.sessionLevelStyles?.[sessionLevelKey], ...patch },
      },
    });
  }, [sessionLevelKey, panel.sessionLevelStyles, onPanelChange]);

  const hideSessionLevel = useCallback(() => {
    if (!sessionLevelKey) return;
    const group = LEVEL_META[sessionLevelKey].group;
    onPanelChange({ sessionOverlays: { ...panel.sessionOverlays, [group]: false } });
    setSessionLevelKey(null);
  }, [sessionLevelKey, panel.sessionOverlays, onPanelChange]);

  // Escape closes whichever floating settings card is open.
  useEffect(() => {
    if (!indicatorSettingsKey && !sessionLevelKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIndicatorSettingsKey(null);
        setSessionLevelKey(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [indicatorSettingsKey, sessionLevelKey]);

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
        setShowDrawingSettings(false);
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

  // Alt+click anywhere on the panel maximizes it to fill the grid (alt+click
  // again restores) — like TradingView. Caught in the capture phase so it beats
  // the drawing canvas / chart click handlers and works even with a tool active.
  const handlePointerDownCapture = useCallback((e: React.PointerEvent) => {
    if (!e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    onToggleMaximize();
  }, [onToggleMaximize]);

  return (
    <div
      id={`chart-panel-${panel.id}`}
      className={`${styles.panel} ${isFocused ? styles.focused : ''}`}
      onClick={(e) => { if (e.altKey) return; onFocus(); }}
      onPointerDownCapture={handlePointerDownCapture}
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
          <button
            className={`${styles.actionBtn} ${isMaximized ? styles.actionActive : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
            title={isMaximized ? 'Restore to grid (Alt+click)' : 'Maximize panel (Alt+click)'}
          >
            {isMaximized ? (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M8.5 1.5v4h4M5.5 12.5v-4h-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M9 1.5h3.5V5M5 12.5H1.5V9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
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
          onDrawingSelect={(id) => {
            setSelectedDrawingId(id);
            if (id === null) setShowDrawingSettings(false); // clicked empty chart
          }}
          onDrawingOpenSettings={(id) => {
            setSelectedDrawingId(id);
            setShowDrawingSettings(true);
            setIndicatorSettingsKey(null);
            setSessionLevelKey(null);
          }}
          onIndicatorOpenSettings={(key) => {
            setIndicatorSettingsKey(key);
            setShowDrawingSettings(false);
            setSessionLevelKey(null);
          }}
          onSessionLevelOpenSettings={(key) => {
            if (!LEVEL_META[key]) return; // unknown price line
            setSessionLevelKey(key);
            setShowDrawingSettings(false);
            setIndicatorSettingsKey(null);
          }}
          rectColor={{ border: rectColor.border, fill: rectColor.fill }}
          dataTimeRange={dataTimeRange}
          onReady={handleChartReady}
          onDrawingComplete={() => onToolChange('none')}
        />

        {showDrawingSettings && selectedDrawing && (
          <DrawingSettings
            drawing={selectedDrawing}
            onChange={updateSelectedDrawing}
            onDelete={deleteSelectedDrawing}
            onClose={() => setShowDrawingSettings(false)}
          />
        )}

        {settingsIndicator && (
          <IndicatorSettings
            indicator={settingsIndicator}
            onChange={updateSettingsIndicator}
            onRemove={removeSettingsIndicator}
            onClose={() => setIndicatorSettingsKey(null)}
          />
        )}

        {sessionLevelKey && sessionLevelMeta && (
          <SessionLevelSettings
            levelKey={sessionLevelKey}
            title={sessionLevelMeta.title}
            color={sessionLevelStyle?.color ?? sessionLevelMeta.color}
            lineWidth={sessionLevelStyle?.lineWidth ?? 1}
            dashed={sessionLevelStyle?.dashed ?? sessionLevelMeta.dashed}
            onChange={updateSessionLevel}
            onHide={hideSessionLevel}
            onClose={() => setSessionLevelKey(null)}
          />
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
