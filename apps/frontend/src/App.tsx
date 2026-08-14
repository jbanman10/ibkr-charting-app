import { useState, useCallback, useEffect, useRef } from 'react';
import type { Bar, MatchedTrade, Tick, Timeframe } from '@ibkr-chart/types';
import {
  loadLayout,
  saveLayout,
  switchPreset,
  updatePanel,
  defaultLayout,
  GRID_PRESETS,
  type LayoutConfig,
  type PanelConfig,
  type GridPresetId,
} from './lib/layout';
import type { DrawingToolType } from './components/Chart/DrawingCanvas';
import { useMarketStream } from './hooks/useMarketStream';
import { addExecutions } from './lib/executionStore';
import {
  startQuoteStore,
  setWatchSender,
  setQuotesConnected,
  applyLiveQuote,
} from './lib/quoteStore';
import { setActiveTrade, sessionEndFor, etDay } from './lib/journalStore';
import ChartPanel from './components/Chart/ChartPanel';
import ResizableGrid from './components/Grid/ResizableGrid';
import LayoutPicker from './components/Grid/LayoutPicker';
import StatusBar from './components/StatusBar';
import MarketSummary from './components/MarketSummary/MarketSummary';
import WatchlistPanel from './components/Watchlist/WatchlistPanel';
import RvolScanner from './components/Scanner/RvolScanner';
import PnlCalendar from './components/PnlCalendar/PnlCalendar';
import SettingsModal from './components/Settings/SettingsModal';
import JournalCalendar from './components/Journal/JournalCalendar';
import { captureChartGrid, saveCapture, todayEt } from './lib/chartCapture';
import SideRail, { type RailItem } from './components/SideRail/SideRail';
import MallardIcon from './components/MallardIcon';
import AlertToasts from './components/AlertToasts/AlertToasts';
import styles from './App.module.css';

const AUTOSAVE_MS = 5_000;

export default function App() {
  const [layout, setLayout] = useState<LayoutConfig>(loadLayout);
  const [focusedPanelId, setFocusedPanelId] = useState<string>(
    () => loadLayout().panels[0]?.id ?? ''
  );
  const [activeTool, setActiveTool] = useState<DrawingToolType>('none');
  const [showSummary, setShowSummary] = useState(false);
  const [showWatchlist, setShowWatchlist] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [showPnl, setShowPnl] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  // Transient toolbar feedback after a capture ('Saved' / an error).
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  // Trade-execution arrows on charts, toggled from the rail; persisted.
  const [showTrades, setShowTrades] = useState(() => localStorage.getItem('ibkr_show_trades') !== '0');
  const [maximizedPanelId, setMaximizedPanelId] = useState<string | null>(null);
  const layoutRef = useRef(layout);
  useEffect(() => { layoutRef.current = layout; }, [layout]);

  // ─── Autosave ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const t = setInterval(() => saveLayout(layoutRef.current), AUTOSAVE_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const h = () => saveLayout(layoutRef.current);
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, []);

  // ─── RT bar routing via DOM refs ───────────────────────────────────────────

  const routeBar = useCallback((
    ev: '__barUpdateHandler' | '__barCloseHandler',
    symbol: string,
    bar: Bar,
    tf: Timeframe
  ) => {
    for (const p of layoutRef.current.panels) {
      const el = document.getElementById(`chart-panel-${p.id}`);
      (el as any)?.[ev]?.(symbol, bar, tf);
    }
  }, []);

  const routeSnapshot = useCallback((symbol: string, bars: Bar[], tf: Timeframe) => {
    for (const p of layoutRef.current.panels) {
      const el = document.getElementById(`chart-panel-${p.id}`);
      (el as any)?.__snapshotHandler?.(symbol, bars, tf);
    }
  }, []);

  const routeTick = useCallback((tick: Tick) => {
    for (const p of layoutRef.current.panels) {
      const el = document.getElementById(`chart-panel-${p.id}`);
      (el as any)?.__tickHandler?.(tick.symbol, tick);
    }
  }, []);

  const { status, ibkrConnected, subscribe, unsubscribe, watch } = useMarketStream({
    onSnapshot:  useCallback((sym: string, bars: Bar[], tf: Timeframe) => routeSnapshot(sym, bars, tf), [routeSnapshot]),
    onBarUpdate: useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barUpdateHandler', sym, bar, tf), [routeBar]),
    onBarClose:  useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barCloseHandler',  sym, bar, tf), [routeBar]),
    onTick:      useCallback((tick: Tick) => routeTick(tick), [routeTick]),
    onExecutions: addExecutions, // store notifies subscribed panels directly
    onQuote:      applyLiveQuote, // watchlist prices — quoteStore notifies the drawer
  });

  // ─── Watchlist quotes ──────────────────────────────────────────────────────
  // The store runs for the whole app session, not just while the drawer is open,
  // so closing the watchlist no longer throws its data away.

  useEffect(() => { startQuoteStore(); }, []);
  useEffect(() => { setWatchSender(watch); return () => setWatchSender(null); }, [watch]);
  useEffect(() => { setQuotesConnected(ibkrConnected); }, [ibkrConnected]);

  // ─── Layout switching ──────────────────────────────────────────────────────

  const handlePresetChange = useCallback((presetId: GridPresetId) => {
    setMaximizedPanelId(null); // a fresh preset invalidates any maximized panel
    setLayout((l) => {
      const next = switchPreset(l, presetId);
      setFocusedPanelId(next.panels[0]?.id ?? '');
      return next;
    });
  }, []);

  const toggleMaximize = useCallback((id: string) => {
    setMaximizedPanelId((cur) => (cur === id ? null : id));
    setFocusedPanelId(id);
  }, []);

  // Escape restores a maximized panel to the grid.
  useEffect(() => {
    if (!maximizedPanelId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximizedPanelId(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximizedPanelId]);

  const handlePanelChange = useCallback((id: string, updates: Partial<PanelConfig>) => {
    setLayout((l) => updatePanel(l, id, updates));
  }, []);

  // Click a watchlist ticker → load it into the currently focused chart. The
  // panel's own subscription effect handles unsubscribe(old)/subscribe(new) when
  // its symbol changes. Watchlist quotes are STK/SMART/USD (like the summary).
  const handleWatchlistSelect = useCallback((symbol: string) => {
    const id = layoutRef.current.panels.some((p) => p.id === focusedPanelId)
      ? focusedPanelId
      : layoutRef.current.panels[0]?.id;
    if (!id) return;
    handlePanelChange(id, { symbol, secType: 'STK', exchange: 'SMART', currency: 'USD', primaryExchange: undefined });
  }, [focusedPanelId, handlePanelChange]);

  // Click a trade in the P&L journal → load its underlying's 1-minute chart for
  // that session into the focused panel, with the trade's entry/exit legs
  // marked. Past sessions load as fixed history (`sessionEnd`); today's stays
  // live, since the live 1m window already covers it.
  const handleOpenTradeOnChart = useCallback((trade: MatchedTrade) => {
    const id = layoutRef.current.panels.some((p) => p.id === focusedPanelId)
      ? focusedPanelId
      : layoutRef.current.panels[0]?.id;
    if (!id) return;

    setActiveTrade(trade);
    const isToday = trade.date === etDay();
    handlePanelChange(id, {
      symbol: trade.symbol,
      secType: 'STK',
      exchange: 'SMART',
      currency: 'USD',
      primaryExchange: undefined,
      timeframe: '1m',
      useRTH: 0,
      sessionEnd: isToday ? undefined : sessionEndFor(trade.date),
      sessionLabel: isToday ? undefined : trade.date,
    });
    setMaximizedPanelId(id); // give the review the whole grid
  }, [focusedPanelId, handlePanelChange]);

  // Snapshot the chart grid into today's journal entry. One capture per day, so
  // pressing this again replaces it.
  const handleCapture = useCallback(async () => {
    setCaptureMsg(null);
    try {
      const shot = captureChartGrid();
      if (!shot) { setCaptureMsg('No charts to capture'); return; }
      if (!shot.layers) { setCaptureMsg('Charts not painted yet — try again'); return; }
      await saveCapture(todayEt(), shot.dataUrl);
      setCaptureMsg('Captured to journal');
    } catch (err) {
      setCaptureMsg(err instanceof Error ? err.message : 'Capture failed');
    }
  }, []);

  useEffect(() => {
    if (!captureMsg) return;
    const t = setTimeout(() => setCaptureMsg(null), 2500);
    return () => clearTimeout(t);
  }, [captureMsg]);

  const handleColumnResize = useCallback((sizes: number[]) => {
    setLayout((l) => ({ ...l, columnSizes: sizes }));
  }, []);

  const handleRowResize = useCallback((sizes: number[]) => {
    setLayout((l) => ({ ...l, rowSizes: sizes }));
  }, []);

  const handleReset = useCallback(() => {
    if (!confirm('Reset layout? All panels and drawings will be cleared.')) return;
    const fresh = defaultLayout();
    setMaximizedPanelId(null);
    setLayout(fresh);
    setFocusedPanelId(fresh.panels[0]?.id ?? '');
    saveLayout(fresh);
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────

  const preset = GRID_PRESETS[layout.presetId];
  const focusedPanel = layout.panels.find((p) => p.id === focusedPanelId);
  const maxIdx = maximizedPanelId ? layout.panels.findIndex((p) => p.id === maximizedPanelId) : -1;
  const maximizedIndex = maxIdx >= 0 ? maxIdx : null;

  // Right-edge tool rail — extend this list as more quick tools land.
  // Watchlist and scanner share the single drawer slot (opening one closes the other).
  const railItems: RailItem[] = [
    {
      id: 'watchlist',
      title: showWatchlist ? 'Hide watchlist' : 'Show watchlist',
      active: showWatchlist,
      onClick: () => { setShowScanner(false); setShowWatchlist((v) => !v); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'scanner',
      title: showScanner ? 'Hide RVOL scanner' : 'RVOL scanner (mid/large caps)',
      active: showScanner,
      onClick: () => { setShowWatchlist(false); setShowScanner((v) => !v); },
      icon: (
        // radar/pulse icon
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M1.5 9.5h3l2-5 3 8 2-6 1.5 3h1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'pnl',
      title: 'P&L calendar & trade journal',
      active: showPnl,
      onClick: () => setShowPnl((v) => !v),
      icon: (
        // calendar with a trend tick
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="3.2" width="12" height="10.6" rx="1.6" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M2 6.4h12M5.4 2v2.4M10.6 2v2.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          <path d="M4.9 11.4l2-2.2 1.6 1.5 2.6-2.8" stroke="#0bd9a2" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ),
    },
    {
      id: 'trades',
      title: showTrades ? 'Hide trade arrows' : 'Show trade arrows',
      active: showTrades,
      onClick: () => setShowTrades((v) => {
        const next = !v;
        try { localStorage.setItem('ibkr_show_trades', next ? '1' : '0'); } catch { /* quota */ }
        return next;
      }),
      icon: (
        // paired entry/exit arrows
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M5 13V5M5 5L2.8 7.2M5 5l2.2 2.2" stroke="#089981" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M11 3v8m0 0 2.2-2.2M11 11 8.8 8.8" stroke="#f23645" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'journal',
      title: 'Trading journal (charts & notes)',
      active: showJournal,
      onClick: () => setShowJournal((v) => !v),
      icon: (
        // notebook with a page mark
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="3" y="2.2" width="10.5" height="11.6" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M3 5h10.5M3 8h10.5M3 11h6.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
          <path d="M5.6 1.4v2.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      ),
    },
    {
      id: 'settings',
      title: 'Settings',
      active: showSettings,
      onClick: () => setShowSettings((v) => !v),
      icon: (
        // gear
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="2.6" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 1.4v1.8M8 12.8v1.8M14.6 8h-1.8M3.2 8H1.4M12.67 3.33l-1.27 1.27M4.6 11.4l-1.27 1.27M12.67 12.67 11.4 11.4M4.6 4.6 3.33 3.33"
            stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div className={styles.root}>

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <header className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <div className={styles.brand}>
            <MallardIcon size={20} />
            <span className={styles.brandName}>Mallard</span>
          </div>

          <div className={styles.divider} />

          {/* Layout switcher */}
          <LayoutPicker current={layout.presetId} onChange={handlePresetChange} />

          <div className={styles.divider} />

          {/* Connection pill */}
          <div className={`${styles.connPill} ${ibkrConnected ? styles.connPillOn : styles.connPillOff}`}>
            <span className={styles.connDot} />
            {ibkrConnected ? 'IBKR Live' : 'Disconnected'}
          </div>
        </div>

        <div className={styles.toolbarRight}>
          {captureMsg && <span className={styles.captureMsg}>{captureMsg}</span>}
          <button
            className={styles.iconBtn}
            onClick={handleCapture}
            title="Capture the charts into today's journal entry (replaces today's capture)"
          >
            {/* camera */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M1.5 4.5h2.2l1-1.6h4.6l1 1.6h2.2a.8.8 0 0 1 .8.8v5.4a.8.8 0 0 1-.8.8H1.5a.8.8 0 0 1-.8-.8V5.3a.8.8 0 0 1 .8-.8z"
                stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
              <circle cx="7" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.2" />
            </svg>
            <span>Capture</span>
          </button>

          <button
            className={styles.iconBtn}
            onClick={() => setShowSummary(true)}
            title="Morning market summary"
          >
            {/* sunrise icon */}
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M1.5 10.5h11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M4 10.5a3 3 0 0 1 6 0" stroke="currentColor" strokeWidth="1.3"/>
              <path d="M7 1.5v2M2.4 4.9l1.4 1.4M11.6 4.9l-1.4 1.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
            <span>Summary</span>
          </button>

          <button
            className={styles.iconBtn}
            onClick={() => saveLayout(layoutRef.current)}
            title="Save layout"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M2 2h8l2 2v8a1 1 0 01-1 1H3a1 1 0 01-1-1V3z"
                stroke="currentColor" strokeWidth="1.3"/>
              <rect x="4" y="1.5" width="5" height="3" rx="0.5"
                stroke="currentColor" strokeWidth="1.3"/>
              <rect x="3" y="7" width="8" height="4.5" rx="0.5"
                stroke="currentColor" strokeWidth="1.3"/>
            </svg>
            <span>Save</span>
          </button>

          <button
            className={`${styles.iconBtn} ${styles.resetBtn}`}
            onClick={handleReset}
            title="Reset layout"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M2 7a5 5 0 1 0 1-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              <path d="M2 3v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── Workspace: panel grid + docked watchlist ────────────────── */}
      <div className={styles.workspace}>
        <div className={styles.gridWrapper}>
          <ResizableGrid
            layout={layout}
            preset={preset}
            onColumnResize={handleColumnResize}
            onRowResize={handleRowResize}
            maximizedIndex={maximizedIndex}
          >
            {layout.panels.map((panel) => (
              <ChartPanel
                key={panel.id}
                panel={panel}
                activeTool={activeTool}
                onToolChange={setActiveTool}
                onPanelChange={(updates) => handlePanelChange(panel.id, updates)}
                onClose={() => {/* handled by layout switch */}}
                canClose={false}
                subscribe={subscribe}
                unsubscribe={unsubscribe}
                ibkrConnected={ibkrConnected}
                isFocused={focusedPanelId === panel.id}
                onFocus={() => setFocusedPanelId(panel.id)}
                isMaximized={maximizedPanelId === panel.id}
                onToggleMaximize={() => toggleMaximize(panel.id)}
                showTrades={showTrades}
              />
            ))}
          </ResizableGrid>
        </div>

        {showWatchlist && (
          <WatchlistPanel
            ibkrConnected={ibkrConnected}
            focusedSymbol={focusedPanel?.symbol}
            onSelect={handleWatchlistSelect}
            onClose={() => setShowWatchlist(false)}
          />
        )}

        {showScanner && (
          <RvolScanner
            ibkrConnected={ibkrConnected}
            focusedSymbol={focusedPanel?.symbol}
            onSelect={handleWatchlistSelect}
            onClose={() => setShowScanner(false)}
          />
        )}

        {/* Persistent tool rail on the right edge */}
        <SideRail items={railItems} />
      </div>

      {/* ── Morning summary popup ───────────────────────────────────── */}
      {showSummary && <MarketSummary onClose={() => setShowSummary(false)} />}

      {/* ── P&L calendar window ─────────────────────────────────────── */}
      {showPnl && (
        <PnlCalendar
          onClose={() => setShowPnl(false)}
          onOpenTradeOnChart={handleOpenTradeOnChart}
        />
      )}

      {/* ── Trading journal (charts + notes) ────────────────────────── */}
      {showJournal && <JournalCalendar onClose={() => setShowJournal(false)} />}

      {/* ── App settings ────────────────────────────────────────────── */}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {/* ── Triggered-alert notifications (bottom right) ────────────── */}
      <AlertToasts />

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar
        symbol={focusedPanel?.symbol ?? null}
        streamStatus={status}
        ibkrConnected={ibkrConnected}
      />
    </div>
  );
}
