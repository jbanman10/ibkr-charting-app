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
import { getActiveTrade, subscribeJournal, setActiveTrade } from '../../lib/journalStore';
import { buildJournalMarkers } from '../../lib/tradeMarkers';
import { getEarnings, subscribeEarnings } from '../../lib/earningsStore';
import type { EarningsMark, EarningsMarkDetail } from '../../lib/earningsPrimitive';
import type { EarningsInfo } from '@ibkr-chart/types';
import type { SeriesMarker, Time } from 'lightweight-charts';
import { computeIndicators, computeDailyIndicators, indicatorKey, baseIndicatorKey } from '../../lib/indicators';
import { computeSessionLevels, computeSessionRegions, currentSession } from '../../lib/sessions';
import { getChartSettings, subscribeChartSettings } from '../../lib/chartSettingsStore';
import { SESSION_COLORS, RECT_PALETTE, type RectColor } from '../../lib/chartTheme';
import type { SessionOverlays, SessionLevelStyle } from '../../lib/layout';
import ChartContainer, { type ChartHandle, type SessionLevelLine, type HoverBar } from './ChartContainer';
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

const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/**
 * Today's ET calendar date as a UTC-midnight unix timestamp — the same basis
 * earnings dates and daily bar times use, so day arithmetic between them is
 * exact (differencing against `Date.now()` loses a day for most of the session).
 */
function etMidnightUtc(): number {
  return Date.parse(`${ET_DAY_FMT.format(new Date())}T00:00:00Z`) / 1000;
}

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

// How often the daily pre/post price line may be redrawn from ticks.
const EXT_PRICE_MS = 400;

// Recomputing every MA across the full history costs a few ms, so the live tick
// path goes through a trailing throttle instead of running per tick.
const INDICATOR_THROTTLE_MS = 400;

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

/**
 * The live pre/post-market price, as a dotted line on the DAILY chart.
 *
 * A daily candle closes at the 16:00 RTH close, so outside regular hours the
 * current price appears nowhere on a daily chart — you can't see that a stock
 * is trading $3 higher after an earnings print. This adds it the way TradingView
 * does: dotted line + an axis badge, orange in pre-market and blue in post.
 *
 * Intraday charts already plot extended-hours candles, so this is daily/weekly
 * only. Nothing is drawn during regular hours (the last candle IS the price) or
 * when the market is closed (a frozen line would read as live).
 */
export function buildExtendedPriceLine(
  timeframe: Timeframe,
  ov: SessionOverlays,
  price: number | null
): SessionLevelLine[] {
  if (timeframe !== '1d' && timeframe !== '1w') return [];
  if (ov.extendedPrice === false) return [];
  if (price == null || !(price > 0)) return [];

  const kind = currentSession();
  if (kind !== 'pre' && kind !== 'post') return [];

  return [{
    // The key carries the session, so moving pre → post swaps the line rather
    // than recolouring a stale one.
    key: kind === 'pre' ? 'PREPX' : 'POSTPX',
    price,
    title: kind === 'pre' ? 'Pre' : 'Post',
    color: kind === 'pre' ? SESSION_COLORS.preMarketPrice : SESSION_COLORS.postMarketPrice,
    solid: false,
    lineWidth: 1,
  }];
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
  // Last AUTHORITATIVE value for the forming minute — a copy that ticks never
  // touch, unlike formingRef which they mutate in place. Used when a local
  // rollover has to write the finished minute into barsRef, so tick-derived
  // OHLC never enters the closed-bar history.
  const authFormingRef = useRef<Bar | null>(null);
  const dailyBarsRef = useRef<Bar[]>([]);       // daily bars for daily-source (MTF) MAs
  const chartAreaRef = useRef<HTMLDivElement>(null); // for clamping the earnings popover
  const gotSnapshotRef = useRef(false);         // has the initial snapshot arrived for this sub?
  const quoteRef = useRef({ bid: 0, ask: 0, last: 0 }); // running quote from sparse ticks
  const rafRef = useRef<number | null>(null);           // coalesce tick repaints to 1/frame
  const lastFeedRef = useRef(0); // last authoritative snapshot/bar_update/bar_close (ms)
  const prevPriceRef = useRef<number | null>(null);     // previous live price, for alert crossing
  // Live last price on a DAILY panel — the only way to know where price is
  // outside regular hours, since a daily candle stops at the RTH close.
  const extPriceRef = useRef<number | null>(null);
  const extPriceAtRef = useRef(0);                      // last redraw (ms), for throttling
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
  // The bar under the crosshair — drives the on-chart legend. Null = the pointer
  // is off the chart, so the legend falls back to the newest bar.
  const [hoverBar, setHoverBar] = useState<HoverBar | null>(null);
  // Earnings: next report date + last 4 quarters (bubbles on the daily chart).
  const [earnings, setEarnings] = useState<EarningsInfo | null>(null);
  // Trade being reviewed from the P&L journal — its legs draw as labelled
  // entry/exit markers on top of the ordinary fill arrows.
  const [journalTrade, setJournalTrade] = useState(getActiveTrade);
  // Detail popover for a clicked earnings badge (null = closed).
  const [erPopover, setErPopover] = useState<
    { detail: EarningsMarkDetail; kind: EarningsMark['kind']; x: number } | null
  >(null);

  /**
   * Closed bars plus the LIVE forming candle — the series every derived visual
   * (indicators, session levels) should be computed from.
   *
   * barsRef holds closed bars only, and right after a snapshot its last element
   * is a *copy* of the candle that is still forming: ticks mutate formingRef,
   * never that copy. Reading barsRef directly therefore feeds indicators a
   * frozen value for the newest candle, and once the clock rolls it leaves them
   * a whole bar behind the chart — which is why the moving averages looked
   * stuck between bar closes.
   */
  const seriesBars = useCallback((): Bar[] => {
    const bars = barsRef.current;
    const forming = formingRef.current;
    if (!forming) return bars;
    if (!bars.length) return [forming];
    const lastT = Number(bars[bars.length - 1].time);
    const formingT = Number(forming.time);
    if (formingT > lastT) return [...bars, forming];
    // Same bar: the live copy wins over the stale closed one.
    if (formingT === lastT) return [...bars.slice(0, -1), forming];
    return bars;
  }, []);

  // Recompute session levels + pre/post shading from the current bar history.
  // Intraday-only; clears the overlays on daily/weekly or when toggled off.
  const recomputeSessions = useCallback(() => {
    const handle = chartRef.current;
    if (!handle) return;
    const ov = panel.sessionOverlays;
    const bars = seriesBars();
    if (!INTRADAY_TF.has(panel.timeframe) || !bars.length) {
      // Daily/weekly: no session levels (they're intraday concepts), but the
      // live extended-hours price still belongs here — see buildExtendedPriceLine.
      handle.setSessionLevels(buildExtendedPriceLine(panel.timeframe, ov, extPriceRef.current));
      handle.setSessionRegions([]);
      return;
    }
    handle.setSessionLevels(buildSessionLines(computeSessionLevels(bars), ov, panel.sessionLevelStyles));
    handle.setSessionRegions(ov.shading ? computeSessionRegions(bars) : []);
  }, [panel.timeframe, panel.sessionOverlays, panel.sessionLevelStyles, seriesBars]);

  // Compute + apply BOTH chart-source and daily-source (MTF) MAs in one pass —
  // setIndicators replaces the whole set, so they must be sent together.
  const applyIndicators = useCallback(() => {
    const handle = chartRef.current;
    const series = seriesBars();
    if (!handle || !series.length) return;
    const active = panel.indicators.filter((i) => i.visible);
    const chartCfgs = active.filter((i) => (i.source ?? 'chart') === 'chart');
    const dailyCfgs = active.filter((i) => i.source === 'daily');
    // Live price drives today's daily close so the projected level reacts.
    const livePrice = Number(series[series.length - 1].close);
    handle.setIndicators([
      ...computeIndicators(series, chartCfgs, panel.timeframe),
      ...(dailyCfgs.length && dailyBarsRef.current.length
        ? computeDailyIndicators(series, dailyBarsRef.current, dailyCfgs, panel.timeframe, livePrice)
        : []),
    ]);
  }, [panel.indicators, panel.timeframe, seriesBars]);

  // Trailing-throttled indicator refresh for the live tick path.
  const indicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleIndicators = useCallback(() => {
    if (indicatorTimerRef.current != null) return;
    indicatorTimerRef.current = setTimeout(() => {
      indicatorTimerRef.current = null;
      applyIndicators();
    }, INDICATOR_THROTTLE_MS);
  }, [applyIndicators]);

  useEffect(() => () => {
    if (indicatorTimerRef.current != null) clearTimeout(indicatorTimerRef.current);
  }, []);

  const renderSnapshot = useCallback((snap: Bar[]) => {
    if (!chartRef.current || !snap.length) return;
    chartRef.current.setData(snap);
    formingRef.current = { ...snap[snap.length - 1] };
    authFormingRef.current = { ...snap[snap.length - 1] };
    applyIndicators();
    recomputeSessions();
  }, [applyIndicators, recomputeSessions]);

  // Re-apply overlays when toggles or timeframe change (bars already loaded).
  useEffect(() => { recomputeSessions(); }, [recomputeSessions]);

  // Session boundaries move on the clock, not on ticks: 16:00 and 20:00 ET pass
  // with no print at all on a quiet name. Without this the "Post" line would sit
  // there all night looking live.
  useEffect(() => {
    if (panel.timeframe !== '1d' && panel.timeframe !== '1w') return;
    const t = setInterval(() => recomputeSessions(), 30_000);
    return () => clearInterval(t);
  }, [panel.timeframe, recomputeSessions]);

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
    authFormingRef.current = null;
    prevPriceRef.current = null;
    extPriceRef.current = null; // last price belongs to the OLD symbol
    dailyBarsRef.current = []; // the daily-bars effect refetches for the new symbol
    setBars([]);

    // ─ Journal review: a fixed past session, loaded once over REST ─
    // keepUpToDate can only stream the LIVE window, so a session from months
    // ago is fetched as history ending at that day's post-market close and
    // rendered through the same snapshot path. No stream, no re-sync.
    if (panel.sessionEnd) {
      const ctrl = new AbortController();
      void (async () => {
        try {
          const params = new URLSearchParams({
            symbol: panel.symbol, secType: panel.secType, exchange: panel.exchange,
            currency: panel.currency, timeframe: panel.timeframe,
            useRTH: String(panel.useRTH ?? 0), end: String(panel.sessionEnd),
          });
          if (panel.primaryExchange) params.set('primaryExchange', panel.primaryExchange);
          const res = await fetch(`/api/bars?${params}`, { signal: ctrl.signal });
          if (!res.ok) { setError(`Could not load that session (${res.status})`); setLoading(false); return; }
          const body = (await res.json()) as { bars?: Bar[] };
          gotSnapshotRef.current = true;
          renderSnapshot(body.bars ?? []);
          setLoading(false);
        } catch (err) {
          if ((err as Error)?.name !== 'AbortError') { setError('Could not load that session'); setLoading(false); }
        }
      })();
      return () => ctrl.abort();
    }

    subscribe(panel.symbol, panel.secType, panel.exchange, panel.currency, panel.timeframe, (panel.useRTH ?? 0) as 0 | 1, panel.id, panel.primaryExchange);
    const t = setTimeout(() => {
      if (!gotSnapshotRef.current) { setError('No data received'); setLoading(false); }
    }, 30_000);
    return () => { clearTimeout(t); unsubscribe(panel.symbol, panel.id); };
  }, [panel.id, panel.symbol, panel.secType, panel.exchange, panel.currency, panel.primaryExchange, panel.timeframe, panel.useRTH, panel.sessionEnd, ibkrConnected]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (panel.sessionEnd) return; // a reviewed past session is already final
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
  }, [panel.symbol, panel.secType, panel.exchange, panel.currency, panel.primaryExchange, panel.timeframe, panel.useRTH, panel.sessionEnd, applyIndicators, recomputeSessions]);

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
    if (panel.timeframe === '1d' || panel.timeframe === '1w') {
      // The tick must NOT touch the bar (a daily candle is the RTH session), but
      // it is the only source for the live pre/post-market price line. Throttled
      // because setSessionLevels re-applies options on every call and ticks can
      // arrive several times a second.
      if (tick.last > 0) {
        extPriceRef.current = tick.last;
        const now = Date.now();
        if (now - extPriceAtRef.current >= EXT_PRICE_MS) {
          extPriceAtRef.current = now;
          recomputeSessions();
        }
      }
      return;
    }
    const q = quoteRef.current;
    if (tick.last > 0) q.last = tick.last;
    if (tick.bid > 0) q.bid = tick.bid;
    if (tick.ask > 0) q.ask = tick.ask;
    const price = q.last > 0 ? q.last : (q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : 0);
    const base = formingRef.current;
    if (price <= 0 || !base) return;
    checkAlertsRef.current(price);

    // 'exact' mode: the chart shows only what IBKR has actually sent, so ticks
    // must not touch bar OHLC and must not fabricate a rollover. Alerts (above)
    // still run off every tick — it is only the BARS that are left alone. Read
    // live rather than captured so toggling the setting takes effect at once.
    if (getChartSettings().candleUpdates !== 'smooth') return;

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
    const steps = Math.floor((nowSec - Number(base.time)) / tfSec);
    // Only ever pre-empt the NEXT bar. If more than one boundary has passed the
    // feed is behind or the tape was quiet, and jumping straight to the newest
    // slot silently skipped every bar in between — a real hole in the series
    // until the periodic resync (3–3.5 min) refilled it. Let the feed open those.
    if (feedFresh && steps === 1) {
      const newTime = Number(base.time) + tfSec;
      // Close the finished minute with the last AUTHORITATIVE value we hold, not
      // the tick-painted one. `base` has been mutated by ticks whose price can be
      // a bid/ask midpoint rather than a trade, and whose volume is stale — and
      // barsRef is consumed as real history by indicators, session levels and
      // markers. IBKR's bar_close overwrites it a few seconds later regardless,
      // so the only question is whether the interim value is plausible or junk.
      const auth = authFormingRef.current;
      const closed = auth && Number(auth.time) === Number(base.time) ? auth : base;
      const cidx = barsRef.current.findIndex((b) => Number(b.time) === Number(closed.time));
      if (cidx >= 0) barsRef.current[cidx] = closed; else barsRef.current.push(closed);
      const nb: Bar = { time: newTime, open: price, high: price, low: price, close: price, volume: 0 };
      formingRef.current = nb;
      authFormingRef.current = null; // nothing authoritative for the new minute yet
      chartRef.current?.updateBar(nb);
      applyIndicators(); // a bar just closed locally — advance the MAs with it
      setBars([...barsRef.current]); // mirror was skipping locally-closed bars
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
    scheduleIndicators();
  }, [panel.symbol, panel.timeframe, recomputeSessions, applyIndicators, scheduleIndicators]);

  useEffect(() => {
    tickHandlerRef.current = applyTick;
  }, [applyTick]);

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  // Switching to 'exact' mid-minute would otherwise leave whatever the ticks had
  // painted (or a wholly fabricated candle) on screen until IBKR's next update
  // ~6s later. Re-anchor straight away: the forming bar reverts to its last
  // authoritative value, and a fabricated candle — which has none — disappears
  // until IBKR actually opens that minute.
  useEffect(() => subscribeChartSettings((s) => {
    if (s.candleUpdates === 'smooth') return;
    formingRef.current = authFormingRef.current ? { ...authFormingRef.current } : null;
    const bars = barsRef.current;
    if (!bars.length) return;
    const forming = formingRef.current;
    const series = forming && Number(forming.time) > Number(bars[bars.length - 1].time)
      ? [...bars, forming]
      : bars;
    chartRef.current?.correctBars(series);
    applyIndicators();
    recomputeSessions();
  }), [applyIndicators, recomputeSessions]);

  useEffect(() => {
    snapshotHandlerRef.current = (symbol: string, snap: Bar[], tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      lastFeedRef.current = Date.now();
      gotSnapshotRef.current = true;
      barsRef.current = snap;
      formingRef.current = snap.length ? { ...snap[snap.length - 1] } : null;
      authFormingRef.current = snap.length ? { ...snap[snap.length - 1] } : null;
      if (chartReadyRef.current) renderSnapshot(snap);
      setBars(snap);
      setError(null);
      setLoading(false);
    };

    barUpdateRef.current = (symbol: string, bar: Bar, tf?: Timeframe) => {
      if (symbol !== panel.symbol || (tf && tf !== panel.timeframe)) return;
      lastFeedRef.current = Date.now();

      // An update for a minute we have already moved PAST is a correction to a
      // closed bar, not the forming one. Adopting it as `forming` used to wedge
      // the chart: after a local rollover the chart's newest point is the
      // fabricated bar, so ChartContainer.updateBar drops this older time —
      // while formingRef had already regressed to it, which made `steps` >= 2
      // and disabled the rollover, so every later tick repaint was dropped too.
      // The candle then sat as a flat volume-0 doji until the next bar_close or
      // the 3-minute resync. Route it through the closed-bar path instead.
      const forming = formingRef.current;
      if (forming && Number(bar.time) < Number(forming.time)) {
        const bars = barsRef.current;
        const idx = bars.findIndex((b) => Number(b.time) === Number(bar.time));
        if (idx >= 0) bars[idx] = bar; else bars.push(bar);
        chartRef.current?.correctBars([...bars, forming]);
        applyIndicators();
        setBars([...bars]);
        recomputeSessions();
        return;
      }

      formingRef.current = { ...bar };
      authFormingRef.current = { ...bar };
      chartRef.current?.updateBar(bar);
      checkAlertsRef.current(Number(bar.close)); // backstop when ticks are sparse
      applyIndicators(); // the forming bar moved, so the MAs must move with it
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
        // A genuinely late bar for an unseen older time lands out of order;
        // seriesBars / snapToBar / dataTimeRange all assume ascending times.
        bars.push(bar);
        bars.sort((a, b) => Number(a.time) - Number(b.time));
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
        authFormingRef.current = { ...bar };
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
  const [drawings, setDrawings, drawingUndo] = useSymbolDrawings(panel.symbol);
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
    if (!seriesBars.length) { handle.setMarkers([]); return; }
    const daily = panel.timeframe === '1d' || panel.timeframe === '1w';
    const firstTime = Number(seriesBars[0].time);
    const forming = formingRef.current;
    const markers: SeriesMarker<Time>[] = [];

    // Nearest loaded bar at or before `t` (markers only render on real bars).
    const snapToBar = (t: number): number | null => {
      if (t < firstTime) return null;
      for (let i = seriesBars.length - 1; i >= 0; i--) {
        if (Number(seriesBars[i].time) <= t) return Number(seriesBars[i].time);
      }
      return null;
    };

    if (showTrades) {
      for (const e of getExecutions(panel.symbol)) {
        let barTime = snapToBar(e.time);
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
    }

    // A trade opened from the journal marks every one of its legs, labelled
    // Entry/Exit (and numbered when it was scaled). Drawn brighter and larger
    // than the ambient fill arrows so the reviewed trade stands out among them.
    if (journalTrade && journalTrade.symbol === panel.symbol) {
      markers.push(...buildJournalMarkers(journalTrade, seriesBars, forming, daily));
    }

    handle.setMarkers(markers);

    // Earnings badges pinned to the bottom of the pane (daily/weekly only — on
    // intraday the report dates fall outside the loaded history). Past reports
    // sit on their bar; the upcoming one is projected past the last bar by the
    // number of TRADING days away, so it lands in the future whitespace.
    if (!daily || !earnings) { handle.setEarningsMarks([]); return; }
    const dayLabel = (unix: number) => new Date(unix * 1000).toLocaleDateString('en-US', {
      timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
    });
    const marks: EarningsMark[] = [];
    for (const e of earnings.history) {
      const barTime = snapToBar(e.date);
      if (barTime == null) continue;
      marks.push({
        time: unixToDayString(barTime) as Time,
        kind: (e.surprisePct ?? 0) >= 0 ? 'beat' : 'miss',
        detail: {
          dateLabel: dayLabel(e.date),
          fiscalQtr: e.fiscalQtr,
          eps: e.eps,
          consensus: e.consensus,
          surprisePct: e.surprisePct,
        },
      });
    }
    const nx = earnings.next;
    if (nx) {
      const lastBar = Number(seriesBars[seriesBars.length - 1].time);
      const detail = {
        dateLabel: dayLabel(nx.date),
        consensus: nx.consensusEps,
        timing: nx.timing,
        estimated: nx.estimated,
      };
      if (nx.date > lastBar) {
        // Future: place it past the last bar. Calendar days → trading days (the
        // daily scale advances one index per session).
        const calDays = Math.round((nx.date - lastBar) / 86_400);
        const barsAhead = Math.max(1, Math.round(calDays * (5 / 7)));
        marks.push({ kind: 'upcoming', barsAhead, estimated: nx.estimated, detail });
      } else {
        // The report is TODAY (or just passed): today's bar now exists, so pin
        // the badge to it instead of dropping it — you most want to see "E" on
        // the session a print lands in. Skip if a reported badge already owns
        // that bar so the two can't stack.
        const barTime = snapToBar(nx.date);
        if (barTime != null) {
          const key = unixToDayString(barTime);
          if (!marks.some((m) => m.time === key)) {
            marks.push({ kind: 'upcoming', time: key as Time, estimated: nx.estimated, detail });
          }
        }
      }
    }
    handle.setEarningsMarks(marks);
  }, [panel.symbol, panel.timeframe, showTrades, earnings, journalTrade]);

  // Refresh arrows when bars change (snapshot / bar close / timeframe) and when
  // new fills arrive for this symbol.
  useEffect(() => {
    rebuildMarkers();
    return subscribeExecutions((sym) => { if (sym === panel.symbol) rebuildMarkers(); });
  }, [bars, rebuildMarkers, panel.symbol]);

  // The trade currently under review in the journal (drawn as labelled legs).
  useEffect(() => subscribeJournal(() => setJournalTrade(getActiveTrade())), []);

  // Earnings (next date + last 4 quarters) for this symbol — cached per symbol.
  useEffect(() => {
    setEarnings(getEarnings(panel.symbol));
    return subscribeEarnings((sym) => {
      if (sym === panel.symbol) setEarnings(getEarnings(panel.symbol));
    });
  }, [panel.symbol]);

  // The earnings popover belongs to one badge on one chart — drop it when the
  // chart changes underneath it, and on Escape.
  useEffect(() => { setErPopover(null); }, [panel.symbol, panel.timeframe]);
  useEffect(() => {
    if (!erPopover) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setErPopover(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [erPopover]);

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
      // Not a user edit — keep it out of the undo history.
      if (changed) setDrawings(next, { undoable: false });
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
  // Double-clicking a Bollinger edge yields a suffixed series key ("BB-20:upper"),
  // so the lookup runs on the base key — all three lines open the one config.
  const [indicatorSettingsKey, setIndicatorSettingsKey] = useState<string | null>(null);
  const settingsIndicator = indicatorSettingsKey
    ? panel.indicators.find((i) => indicatorKey(i) === baseIndicatorKey(indicatorSettingsKey)) ?? null
    : null;

  const updateSettingsIndicator = useCallback((patch: Partial<IndicatorConfig>) => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.map((i) =>
        indicatorKey(i) === baseIndicatorKey(indicatorSettingsKey) ? { ...i, ...patch } : i
      ),
    });
  }, [indicatorSettingsKey, panel.indicators, onPanelChange]);

  const removeSettingsIndicator = useCallback(() => {
    if (!indicatorSettingsKey) return;
    onPanelChange({
      indicators: panel.indicators.filter((i) => indicatorKey(i) !== baseIndicatorKey(indicatorSettingsKey)),
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

  // Ctrl+Z (⌘Z) undoes the last drawing edit on the focused panel's symbol —
  // most importantly a delete. Separate from the Delete/Escape handler below
  // because that one only runs while something is selected, and undo has to work
  // right after a delete has cleared the selection.
  useEffect(() => {
    if (!isFocused) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z' || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      drawingUndo.undo();
      setSelectedDrawingId(null);
      setShowDrawingSettings(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isFocused, drawingUndo]);

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

  // Next-earnings chip: days out, highlighted when it's inside a week (holding
  // options through a print is a decision you want to make deliberately).
  const nextEarnings = useMemo(() => {
    const n = earnings?.next;
    if (!n) return null;
    // Count CALENDAR days between today's ET date and the report date. Earnings
    // dates are UTC-midnight stamps of a US market date, so differencing them
    // against the current instant loses a day for most of the ET session.
    const days = Math.round((n.date - etMidnightUtc()) / 86_400);
    // Confirmed dates stop being interesting the day after; a projection stays
    // (it's a rough marker) until it's clearly stale.
    if (days < (n.estimated ? -14 : -1)) return null;
    const label = new Date(n.date * 1000).toLocaleDateString('en-US', {
      timeZone: 'UTC', month: 'short', day: 'numeric',
    });
    const when = days === 0 ? 'today'
      : days === 1 ? 'tomorrow'
      : days === -1 ? 'yesterday'
      : days > 0 ? `in ${days}d`
      : `${-days}d ago`;
    return {
      label: n.estimated ? `~${label}` : label, // ~ = projected, not yet confirmed
      when, soon: days >= 0 && days <= 7, timing: n.timing, consensusEps: n.consensusEps,
      estimated: n.estimated,
    };
  }, [earnings]);

  // The on-chart legend describes the hovered candle, falling back to the newest
  // bar when the cursor is off the chart.
  const legendBar = hoverBar ?? displayData;

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
        <SymbolSearch
          currentSymbol={panel.symbol}
          exchange={panel.primaryExchange ?? panel.exchange}
          onSelect={handleSymbolSelect}
        />
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
          canUndo={drawingUndo.canUndo}
          onUndo={() => { drawingUndo.undo(); setSelectedDrawingId(null); setShowDrawingSettings(false); }}
        />
        {panel.sessionEnd && (
          <button
            className={styles.reviewChip}
            onClick={(e) => {
              e.stopPropagation();
              setActiveTrade(null);
              onPanelChange({ sessionEnd: undefined, sessionLabel: undefined });
            }}
            title="Reviewing a past session (not live) — click to return to the live chart"
          >
            <span className={styles.reviewDot} />
            Reviewing {panel.sessionLabel ?? 'session'}
            <span className={styles.reviewClose}>✕</span>
          </button>
        )}
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
      <div className={styles.chartArea} ref={chartAreaRef}>
        <div className={styles.ohlcvRow}>
          <PriceDisplay symbol={panel.symbol} data={legendBar} hovering={hoverBar != null} />
          {nextEarnings && (
            <div
              className={`${styles.erChip} ${nextEarnings.soon ? styles.erChipSoon : ''}`}
              title={`${nextEarnings.estimated ? 'Projected' : 'Confirmed'} next earnings: ${nextEarnings.label}${
                nextEarnings.timing ? ` (${nextEarnings.timing})` : ''
              }${nextEarnings.consensusEps != null ? ` · consensus EPS $${nextEarnings.consensusEps}` : ''}${
                nextEarnings.estimated ? ' — projected from reporting cadence, updates when announced' : ''
              }`}
            >
              ER {nextEarnings.label} · {nextEarnings.when}
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
          onHoverBar={setHoverBar}
          onEarningsClick={(detail, kind, x) => setErPopover({ detail, kind, x })}
        />

        {erPopover && (
          <div
            className={styles.erPopover}
            style={{ left: Math.max(8, Math.min(erPopover.x - 90, Math.max(8, (chartAreaRef.current?.clientWidth ?? 400) - 196))) }}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className={styles.erPopHeader}>
              <span className={styles.erPopTitle}>
                {erPopover.kind === 'upcoming'
                  ? (erPopover.detail.estimated ? 'Next earnings (projected)' : 'Next earnings')
                  : erPopover.detail.fiscalQtr || 'Reported'}
              </span>
              <button className={styles.erPopClose} onClick={() => setErPopover(null)} title="Close">
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div className={styles.erPopDate}>
              {erPopover.detail.dateLabel}
              {erPopover.detail.timing ? ` · ${erPopover.detail.timing}` : ''}
            </div>
            {erPopover.kind === 'upcoming' ? (
              <>
                {erPopover.detail.consensus != null && (
                  <div className={styles.erPopRow}>
                    <span className={styles.erPopKey}>Consensus EPS</span>
                    <span className={styles.erPopVal}>${erPopover.detail.consensus.toFixed(2)}</span>
                  </div>
                )}
                {erPopover.detail.estimated && (
                  <div className={styles.erPopNote}>Projected from reporting cadence — updates when announced.</div>
                )}
              </>
            ) : (
              <>
                <div className={styles.erPopRow}>
                  <span className={styles.erPopKey}>Reported EPS</span>
                  <span className={styles.erPopVal}>
                    {erPopover.detail.eps != null ? `$${erPopover.detail.eps.toFixed(2)}` : '—'}
                  </span>
                </div>
                <div className={styles.erPopRow}>
                  <span className={styles.erPopKey}>Consensus</span>
                  <span className={styles.erPopVal}>
                    {erPopover.detail.consensus != null ? `$${erPopover.detail.consensus.toFixed(2)}` : '—'}
                  </span>
                </div>
                <div className={styles.erPopRow}>
                  <span className={styles.erPopKey}>Surprise</span>
                  <span className={`${styles.erPopVal} ${erPopover.kind === 'beat' ? styles.erUp : styles.erDown}`}>
                    {erPopover.detail.surprisePct != null
                      ? `${erPopover.detail.surprisePct >= 0 ? '+' : ''}${erPopover.detail.surprisePct.toFixed(2)}%`
                      : '—'}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

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
