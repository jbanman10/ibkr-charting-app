import { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { TIMEFRAMES, type Bar, type IndicatorConfig, type Timeframe, type ContractSearchResult, type Tick } from '@ibkr-chart/types';
import type { PanelConfig } from '../../lib/layout';
import type { Drawing, DataTimeRange } from '../../lib/drawings';
import type { DrawingToolType } from './DrawingCanvas';
import { useSymbolDrawings } from '../../hooks/useSymbolDrawings';
import { seedDrawings, getDrawings } from '../../lib/drawingStore';
import { newDrawingId, unixToDayString } from '../../lib/drawings';
import { ensureAudio, playQuack, shouldFire } from '../../lib/quack';
import { getExecutions, subscribeExecutions } from '../../lib/executionStore';
import type { SeriesMarker, Time } from 'lightweight-charts';
import { computeIndicators, computeDailyIndicators, indicatorKey } from '../../lib/indicators';
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

// TradingView-style timeframe hotkey: parse a typed resolution string into one
// of our supported timeframes. Bare numbers are minutes (60→1h, 240→4h); a
// letter suffix picks the unit ("1d"/"d" daily, "1w"/"w" weekly, "1h"/"4h").
function parseTimeframe(raw: string): Timeframe | null {
  const m = raw.trim().toLowerCase().match(/^(\d+)?([mhdw])?$/);
  if (!m || (!m[1] && !m[2])) return null;
  const num = m[1] ? parseInt(m[1], 10) : null;
  const unit = m[2] ?? null;
  if (!unit) {
    switch (num) {
      case 1: return '1m'; case 5: return '5m'; case 15: return '15m';
      case 30: return '30m'; case 60: return '1h'; case 240: return '4h';
      default: return null;
    }
  }
  const n = num ?? 1;
  switch (unit) {
    case 'm': return ({ 1: '1m', 5: '5m', 15: '15m', 30: '30m' } as Record<number, Timeframe>)[n] ?? null;
    case 'h': return n === 1 ? '1h' : n === 4 ? '4h' : null;
    case 'd': return n === 1 ? '1d' : null;
    case 'w': return n === 1 ? '1w' : null;
    default:  return null;
  }
}

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
  subscribe: (sym: string, secType: string, exchange: string, currency: string, tf: Timeframe, useRTH: 0 | 1 | undefined, subId: string, primaryExchange?: string) => void;
  unsubscribe: (sym: string, subId: string) => void;
  ibkrConnected: boolean;
  isFocused: boolean;
  onFocus: () => void;
  isMaximized: boolean;
  onToggleMaximize: () => void;
  showTrades: boolean;
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
  showTrades,
}: Props) {
  const chartRef = useRef<ChartHandle>(null);
  const barsRef = useRef<Bar[]>([]);            // closed bars — authoritative, straight from IBKR
  const chartReadyRef = useRef(false);
  const formingRef = useRef<Bar | null>(null);  // current live (forming) bar
  const dailyBarsRef = useRef<Bar[]>([]);       // daily bars for daily-source (MTF) MAs
  const gotSnapshotRef = useRef(false);         // has the initial snapshot arrived for this sub?
  const quoteRef = useRef({ bid: 0, ask: 0, last: 0 }); // running quote from sparse ticks
  const rafRef = useRef<number | null>(null);           // coalesce tick repaints to 1/frame
  const lastFeedRef = useRef(0); // last authoritative snapshot/bar_update/bar_close (ms)
  const prevPriceRef = useRef<number | null>(null);     // previous live price, for alert crossing
  const checkAlertsRef = useRef((_p: number) => {});    // assigned below (needs the drawings hook)
  const [showIndicators, setShowIndicators] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // TradingView-style timeframe hotkey: the buffer of typed chars (null = idle)
  // and a transient "invalid" flash when an unrecognized code is committed.
  const [tfInput, setTfInput] = useState<string | null>(null);
  const [tfInvalid, setTfInvalid] = useState(false);
  const tfInputRef = useRef<string | null>(null);
  useEffect(() => { tfInputRef.current = tfInput; }, [tfInput]);
  // Reactive mirror of barsRef for consumers that need to re-render (drawing
  // clamp extent, OHLC display, drawing hit-testing). Updated on snapshot and
  // on each bar close (~once/min), not on every live update.
  const [bars, setBars] = useState<Bar[]>([]);
  // Volume of the candle under the crosshair (null when not hovering a bar).
  const [hoverVolume, setHoverVolume] = useState<number | null>(null);

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

  // Compute + apply BOTH chart-source and daily-source (MTF) MAs in one pass —
  // setIndicators replaces the whole set, so they must be sent together.
  const applyIndicators = useCallback(() => {
    const handle = chartRef.current;
    if (!handle || !barsRef.current.length) return;
    const active = panel.indicators.filter((i) => i.visible);
    const chartCfgs = active.filter((i) => (i.source ?? 'chart') === 'chart');
    const dailyCfgs = active.filter((i) => i.source === 'daily');
    // Live price drives today's daily close so the projected level reacts.
    const livePrice = formingRef.current?.close
      ?? (barsRef.current.length ? Number(barsRef.current[barsRef.current.length - 1].close) : null);
    handle.setIndicators([
      ...computeIndicators(barsRef.current, chartCfgs, panel.timeframe),
      ...(dailyCfgs.length && dailyBarsRef.current.length
        ? computeDailyIndicators(barsRef.current, dailyBarsRef.current, dailyCfgs, panel.timeframe, livePrice)
        : []),
    ]);
  }, [panel.indicators, panel.timeframe]);

  const renderSnapshot = useCallback((snap: Bar[]) => {
    if (!chartRef.current || !snap.length) return;
    chartRef.current.setData(snap);
    formingRef.current = { ...snap[snap.length - 1] };
    applyIndicators();
    recomputeSessions();
  }, [applyIndicators, recomputeSessions]);

  // Re-apply overlays when toggles or timeframe change (bars already loaded).
  useEffect(() => { recomputeSessions(); }, [recomputeSessions]);

  // Called by ChartContainer once its lightweight-charts instance is created.
  const handleChartReady = useCallback(() => {
    chartReadyRef.current = true;
    if (barsRef.current.length) renderSnapshot(barsRef.current);
  }, [renderSnapshot]);

  // Recompute indicators when config changes.
  useEffect(() => {
    applyIndicators();
  }, [applyIndicators]);

  // Daily bars for daily-source (MTF) MAs — one fetch per symbol, refreshed
  // occasionally (today's bar + a new session after midnight). Independent of
  // the panel's own timeframe so a 1m panel can show the 200-DAY MA.
  useEffect(() => {
    if (!panel.symbol || !ibkrConnected) return;
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({
          symbol: panel.symbol, secType: panel.secType, exchange: panel.exchange,
          currency: panel.currency, timeframe: '1d', useRTH: '1',
        });
        if (panel.primaryExchange) params.set('primaryExchange', panel.primaryExchange);
        const res = await fetch(`/api/bars?${params}`);
        if (!res.ok || cancelled) return;
        const body = (await res.json()) as { bars?: Bar[] };
        dailyBarsRef.current = body.bars ?? [];
        applyIndicators();
      } catch { /* transient — next cycle retries */ }
    };
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.primaryExchange, ibkrConnected, applyIndicators]);

  // ─── Live subscription (keepUpToDate: snapshot + updates) ──────────────────

  useEffect(() => {
    if (!ibkrConnected || !panel.symbol) return;
    // New subscription → reset to loading until the snapshot arrives.
    setLoading(true);
    setError(null);
    gotSnapshotRef.current = false;
    barsRef.current = [];
    formingRef.current = null;
    prevPriceRef.current = null;
    dailyBarsRef.current = []; // the daily-bars effect refetches for the new symbol
    setBars([]);
    subscribe(panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, (panel.useRTH ?? 0) as 0 | 1, panel.id, panel.primaryExchange);
    const t = setTimeout(() => {
      if (!gotSnapshotRef.current) { setError('No data received'); setLoading(false); }
    }, 30_000);
    return () => { clearTimeout(t); unsubscribe(panel.symbol, panel.id); };
  }, [panel.id, panel.symbol, panel.secType, panel.exchange, panel.currency, panel.primaryExchange, panel.timeframe, panel.useRTH, ibkrConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic history re-sync — a backstop for late-reported prints, IBKR's
  // penny-level history revisions, and the extended-hours NBBO clamp (via
  // /api/bars). The backend's on-rollover correction already finalizes
  // regular-hours candles immediately, so this runs infrequently. Jittered so
  // panels don't burst together. ALSO fires when the window becomes visible:
  // background/occluded windows get their timers throttled (Chromium/Electron),
  // so an occluded window can miss every cycle and drift from official history —
  // resyncing on visibility guarantees a window is reconciled whenever the user
  // is actually looking at it.
  useEffect(() => {
    if (!panel.symbol) return;
    const REFRESH_MS = 180_000 + Math.random() * 30_000;
    const MIN_GAP_MS = 20_000; // visibility flaps shouldn't hammer /api/bars
    const ctrl = new AbortController();
    let lastRun = 0;
    const resync = async () => {
      if (!chartReadyRef.current || !gotSnapshotRef.current) return;
      if (Date.now() - lastRun < MIN_GAP_MS) return;
      lastRun = Date.now();
      try {
        const params = new URLSearchParams({
          symbol: panel.symbol,
          secType: panel.secType,
          exchange: panel.exchange,
          currency: panel.currency,
          timeframe: panel.timeframe,
          useRTH: String(panel.useRTH ?? 0),
        });
        if (panel.primaryExchange) params.set('primaryExchange', panel.primaryExchange);
        const res = await fetch(`/api/bars?${params}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { bars?: Bar[] };
        const official = body.bars ?? [];
        if (official.length < 2) return;
        barsRef.current = official;
        // Keep the live forming bar on the end (it's newer than official's last
        // when a bar is mid-formation); buildSeries de-dupes by time.
        const forming = formingRef.current;
        const series = forming && Number(forming.time) > Number(official[official.length - 1].time)
          ? [...official, forming]
          : official;
        chartRef.current?.correctBars(series);
        applyIndicators();
        setBars(official);
        recomputeSessions();
      } catch { /* transient — next cycle retries */ }
    };
    const timer = setInterval(resync, REFRESH_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void resync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { ctrl.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.primaryExchange, panel.timeframe, panel.useRTH, applyIndicators, recomputeSessions]);

  // ─── Stream handlers (snapshot / bar_update / bar_close) ───────────────────
  //
  // Bars come straight from IBKR's keepUpToDate feed (TWS-equivalent): the
  // snapshot is authoritative history, bar_update is the live forming bar, and
  // bar_close finalizes a bar (including late-print corrections to older bars).

  const snapshotHandlerRef = useRef((_s: string, _b: Bar[], _t?: Timeframe) => {});
  const barUpdateRef = useRef((_s: string, _b: Bar, _t?: Timeframe) => {});
  const barCloseRef = useRef((_s: string, _b: Bar, _t?: Timeframe) => {});
  const tickHandlerRef = useRef((_s: string, _t: Tick) => {});

  // Paint the forming candle from sub-second ticks between keepUpToDate updates.
  // Provisional only — the next bar_update re-anchors OHLC to the exact TWS bar.
  const applyTick = useCallback((symbol: string, tick: Tick) => {
    if (symbol !== panel.symbol) return;
    // Daily/weekly are RTH-only; don't let pre/post ticks drag the day's bar.
    if (panel.timeframe === '1d' || panel.timeframe === '1w') return;
    const q = quoteRef.current;
    if (tick.last > 0) q.last = tick.last;
    if (tick.bid > 0) q.bid = tick.bid;
    if (tick.ask > 0) q.ask = tick.ask;
    const price = q.last > 0 ? q.last : (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : 0);
    const base = formingRef.current;
    if (price <= 0 || !base) return;
    checkAlertsRef.current(price);

    // Clock-driven rollover: if the minute (bar boundary) has passed but IBKR's
    // keepUpToDate update hasn't arrived yet, open the next candle locally at the
    // current price so it appears right on the boundary (TWS-like) instead of a
    // couple seconds late. The next bar_update/bar_close re-anchors it to the
    // exact official OHLC. Anchored off base.time so it's correct for every
    // timeframe (incl. RTH-offset 1h bars), not just epoch-aligned ones.
    const tfSec = TIMEFRAMES[panel.timeframe].seconds;
    const nowSec = Math.floor(Date.now() / 1000);
    // Never fabricate candles from ticks alone: if the authoritative keepUpToDate
    // feed has gone quiet (dead/stomped stream), skip the local rollover — a
    // tick-only chart drifts into malformed, gappy candles.
    const feedFresh = Date.now() - lastFeedRef.current < 120_000;
    if (feedFresh && nowSec - Number(base.time) >= tfSec) {
      const steps = Math.floor((nowSec - Number(base.time)) / tfSec);
      const newTime = Number(base.time) + steps * tfSec;
      // Keep the just-finalized bar in the closed-bar history so overlays/session
      // math still see it until the authoritative bar_close confirms it.
      const cidx = barsRef.current.findIndex((b) => Number(b.time) === Number(base.time));
      if (cidx >= 0) barsRef.current[cidx] = base; else barsRef.current.push(base);
      const nb: Bar = { time: newTime, open: price, high: price, low: price, close: price, volume: 0 };
      formingRef.current = nb;
      chartRef.current?.updateBar(nb);
      recomputeSessions();
      return;
    }

    base.close = price;
    if (price > base.high) base.high = price;
    if (price < base.low) base.low = price;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (formingRef.current) chartRef.current?.updateBar(formingRef.current);
      });
    }
  }, [panel.symbol, panel.timeframe, recomputeSessions]);

  useEffect(() => {
    tickHandlerRef.current = applyTick;
  }, [applyTick]);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  useEffect(() => {
    snapshotHandlerRef.current = (symbol: string, snap: Bar[], tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      lastFeedRef.current = Date.now();
      gotSnapshotRef.current = true;
      barsRef.current = snap;
      formingRef.current = snap.length ? { ...snap[snap.length - 1] } : null;
      if (chartReadyRef.current) renderSnapshot(snap);
      setBars(snap);
      setError(null);
      setLoading(false);
    };

    barUpdateRef.current = (symbol: string, bar: Bar, tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      lastFeedRef.current = Date.now();
      formingRef.current = { ...bar };
      chartRef.current?.updateBar(bar);
      checkAlertsRef.current(Number(bar.close)); // backstop when ticks are sparse
      recomputeSessions();
    };

    barCloseRef.current = (symbol: string, bar: Bar, tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      lastFeedRef.current = Date.now();
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
        // Correction to a bar that's no longer the chart's last point (a late
        // print, or the bar we just rolled past locally) — re-render preserving
        // the viewport. Keep the live forming bar on the end so the candle we
        // opened locally doesn't flicker out until the next bar_update.
        chartRef.current?.correctBars([...bars, forming]);
      } else {
        formingRef.current = { ...bar };
        chartRef.current?.updateBar(bar);
      }
      applyIndicators();
      setBars([...bars]); // reactive mirror for drawing extent / OHLC display
      recomputeSessions();
    };
  }, [panel.symbol, panel.timeframe, applyIndicators, recomputeSessions, renderSnapshot]);

  useEffect(() => {
    const el = document.getElementById(`chart-panel-${panel.id}`);
    if (!el) return;
    (el as any).__snapshotHandler  = (sym: string, b: Bar[], tf?: Timeframe) => snapshotHandlerRef.current(sym, b, tf);
    (el as any).__barUpdateHandler = (sym: string, bar: Bar, tf?: Timeframe) => barUpdateRef.current(sym, bar, tf);
    (el as any).__barCloseHandler  = (sym: string, bar: Bar, tf?: Timeframe) => barCloseRef.current(sym, bar, tf);
    (el as any).__tickHandler      = (sym: string, tick: Tick) => tickHandlerRef.current(sym, tick);
    return () => {
      (el as any).__snapshotHandler  = null;
      (el as any).__barUpdateHandler = null;
      (el as any).__barCloseHandler  = null;
      (el as any).__tickHandler      = null;
    };
  }, [panel.id]);

  // ─── UI handlers ──────────────────────────────────────────────────────────

  const handleSymbolSelect = useCallback((result: ContractSearchResult) => {
    unsubscribe(panel.symbol, panel.id);
    // Stocks always pull data via SMART (consolidated tape, matches TWS/TV);
    // the search result's exchange is the LISTING exchange (e.g. NASDAQ) and is
    // kept only to disambiguate the symbol. Requesting data from a single venue
    // yields penny-different highs/lows and gappier candles.
    const stk = result.secType === 'STK';
    onPanelChange({
      symbol: result.symbol,
      secType: result.secType,
      exchange: stk ? 'SMART' : (result.exchange || 'SMART'),
      primaryExchange: stk && result.exchange && result.exchange !== 'SMART' ? result.exchange : undefined,
      currency: result.currency,
    });
  }, [panel.symbol, panel.id, unsubscribe, onPanelChange]);

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

  // ─── Trade execution arrows ─────────────────────────────────────────────────
  // Account fills (incl. manual TWS option orders, mapped to the underlying)
  // render as arrows: buys green below the bar, sells red above. Fill times are
  // snapped to the nearest bar at or before the fill.

  const rebuildMarkers = useCallback(() => {
    const handle = chartRef.current;
    if (!handle) return;
    const seriesBars = barsRef.current;
    if (!showTrades || !seriesBars.length) { handle.setMarkers([]); return; }
    const daily = panel.timeframe === '1d' || panel.timeframe === '1w';
    const firstTime = Number(seriesBars[0].time);
    const forming = formingRef.current;
    const markers: SeriesMarker<Time>[] = [];

    for (const e of getExecutions(panel.symbol)) {
      if (e.time < firstTime) continue; // older than loaded history
      let barTime: number | null = null;
      for (let i = seriesBars.length - 1; i >= 0; i--) {
        if (Number(seriesBars[i].time) <= e.time) { barTime = Number(seriesBars[i].time); break; }
      }
      if (barTime == null) continue;
      if (forming && e.time >= Number(forming.time)) barTime = Number(forming.time);

      const isBuy = e.side === 'BOT';
      const price = e.price.toFixed(2);
      const text = e.strike != null
        ? `${e.quantity}× ${e.strike}${e.right ?? ''} @${price}`
        : `${e.quantity} @${price}`;
      markers.push({
        time: (daily ? unixToDayString(barTime) : barTime) as Time,
        position: isBuy ? 'belowBar' : 'aboveBar',
        shape: isBuy ? 'arrowUp' : 'arrowDown',
        color: isBuy ? '#089981' : '#f23645',
        text,
        size: 1,
      });
    }
    handle.setMarkers(markers);
  }, [panel.symbol, panel.timeframe, showTrades]);

  // Refresh arrows when bars change (snapshot / bar close / timeframe) and when
  // new fills arrive for this symbol.
  useEffect(() => {
    rebuildMarkers();
    return subscribeExecutions((sym) => { if (sym === panel.symbol) rebuildMarkers(); });
  }, [bars, rebuildMarkers, panel.symbol]);

  // ─── Price alerts ───────────────────────────────────────────────────────────
  // Fire when the live price crosses an armed alert level: quack (duck, of
  // course) and mark it triggered (line dims). shouldFire de-dupes when several
  // panels show the same symbol.
  useEffect(() => {
    checkAlertsRef.current = (p: number) => {
      const prev = prevPriceRef.current;
      prevPriceRef.current = p;
      if (prev == null || prev === p) return;
      const all = getDrawings(panel.symbol);
      let changed = false;
      const next = all.map((d) => {
        if (d.type !== 'alert' || d.triggeredAt) return d;
        const crossed = (prev < d.price && p >= d.price) || (prev > d.price && p <= d.price);
        if (!crossed) return d;
        changed = true;
        if (shouldFire(d.id)) {
          playQuack(3);
          window.dispatchEvent(new CustomEvent('ibkr:alert-toast', {
            detail: { symbol: panel.symbol, price: d.price },
          }));
        }
        return { ...d, triggeredAt: Date.now() };
      });
      if (changed) setDrawings(next);
    };
  }, [panel.symbol, setDrawings]);

  // Alt+A drops an alert at the price under the cursor on the focused chart.
  // The keydown is a user gesture, so it also unlocks the AudioContext for the
  // quack that plays later when the alert actually fires.
  useEffect(() => {
    if (!isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.key.toLowerCase() !== 'a' || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      const price = chartRef.current?.getCursorPrice();
      if (price == null || price <= 0) return;
      e.preventDefault();
      ensureAudio();
      const alert: Drawing = { id: newDrawingId(), type: 'alert', price: Number(price.toFixed(2)), triggeredAt: null };
      setDrawings([...getDrawings(panel.symbol), alert]);
      setSelectedDrawingId(alert.id);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFocused, panel.symbol, setDrawings]);

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

  // Indicator settings card, opened by double-clicking an MA line. Keyed by the
  // same `indicatorKey` the chart series use (daily MAs get a `-D` suffix).
  const [indicatorSettingsKey, setIndicatorSettingsKey] = useState<string | null>(null);
  const settingsIndicator = indicatorSettingsKey
    ? panel.indicators.find((i) => indicatorKey(i) === indicatorSettingsKey) ?? null
    : null;

  const updateSettingsIndicator = useCallback((patch: Partial<IndicatorConfig>) => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.map((i) =>
        indicatorKey(i) === indicatorSettingsKey ? { ...i, ...patch } : i
      ),
    });
  }, [indicatorSettingsKey, panel.indicators, onPanelChange]);

  const removeSettingsIndicator = useCallback(() => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.filter((i) => indicatorKey(i) !== indicatorSettingsKey),
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
      if (tfInputRef.current !== null) return; // mid timeframe-hotkey entry
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

  // ─── Timeframe hotkey (TradingView-style) ─────────────────────────────────
  // Type a resolution over the focused chart: a digit opens the box, more
  // digits/letters build it up, Enter (or a brief pause) applies it.

  const commitTf = useCallback((raw: string) => {
    const tf = parseTimeframe(raw);
    if (tf) {
      setTfInput(null);
      setTfInvalid(false);
      if (tf !== panel.timeframe) onPanelChange({ timeframe: tf });
    } else {
      // Flash the box red briefly, then clear.
      setTfInvalid(true);
      setTimeout(() => { setTfInput(null); setTfInvalid(false); }, 550);
    }
  }, [panel.timeframe, onPanelChange]);

  useEffect(() => {
    if (!isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      const active = tfInputRef.current;
      if (active === null) {
        if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setTfInput(e.key); }
        return;
      }
      // A code is being typed — capture the relevant keys so nothing else acts.
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); setTfInput(active + e.key); }
      else if (/^[mhdw]$/i.test(e.key)) { e.preventDefault(); setTfInput(active + e.key.toLowerCase()); }
      else if (e.key === 'Backspace') { e.preventDefault(); setTfInput(active.length <= 1 ? null : active.slice(0, -1)); }
      else if (e.key === 'Enter') { e.preventDefault(); commitTf(active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); setTfInput(null); setTfInvalid(false); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFocused, commitTf]);

  // Auto-apply shortly after typing stops (TradingView behavior). Enter commits
  // immediately; this handles the "type and pause" case.
  useEffect(() => {
    if (tfInput === null || tfInvalid) return;
    const t = setTimeout(() => commitTf(tfInput), 1100);
    return () => clearTimeout(t);
  }, [tfInput, tfInvalid, commitTf]);

  // Cancel any in-progress hotkey entry when the panel loses focus.
  useEffect(() => {
    if (!isFocused && tfInput !== null) { setTfInput(null); setTfInvalid(false); }
  }, [isFocused, tfInput]);

  // Absolute time extent of loaded bars — used to clamp drawings that extend
  // beyond the loaded window (so they line up across timeframes).
  const dataTimeRange: DataTimeRange | null = useMemo(
    () => (bars.length ? { first: Number(bars[0].time), last: Number(bars[bars.length - 1].time) } : null),
    [bars]
  );

  const displayData = bars.length > 0 ? bars[bars.length - 1] : null;

  // Volume readout under the ⓘ chip: the hovered candle's volume, falling back
  // to the newest bar when the cursor is off the chart.
  const shownVolume = hoverVolume ?? (displayData ? Number(displayData.volume) : null);
  const fmtVolume = (n: number) => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
  };

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
          {shownVolume != null && (
            <div
              className={`${styles.volChip} ${hoverVolume != null ? styles.volChipHover : ''}`}
              title={hoverVolume != null ? 'Volume of the hovered candle' : 'Volume of the latest candle'}
            >
              Vol {fmtVolume(shownVolume)}
            </div>
          )}
        </div>

        {tfInput !== null && (
          <div className={`${styles.tfHotkey} ${tfInvalid ? styles.tfHotkeyInvalid : ''}`}>
            <span className={styles.tfHotkeyValue}>{tfInput.toUpperCase()}</span>
            <span className={styles.tfHotkeyHint}>timeframe</span>
          </div>
        )}

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
          onHoverVolume={setHoverVolume}
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
