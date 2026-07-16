import { useState, useCallback, useEffect, useRef } from 'react';
import type { Bar, Tick, Timeframe } from '@ibkr-chart/types';
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
import ChartPanel from './components/Chart/ChartPanel';
import ResizableGrid from './components/Grid/ResizableGrid';
import LayoutPicker from './components/Grid/LayoutPicker';
import StatusBar from './components/StatusBar';
import MarketSummary from './components/MarketSummary/MarketSummary';
import WatchlistPanel from './components/Watchlist/WatchlistPanel';
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

  const { status, ibkrConnected, subscribe, unsubscribe } = useMarketStream({
    onSnapshot:  useCallback((sym: string, bars: Bar[], tf: Timeframe) => routeSnapshot(sym, bars, tf), [routeSnapshot]),
    onBarUpdate: useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barUpdateHandler', sym, bar, tf), [routeBar]),
    onBarClose:  useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barCloseHandler',  sym, bar, tf), [routeBar]),
    onTick:      useCallback((tick: Tick) => routeTick(tick), [routeTick]),
  });

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
  const railItems: RailItem[] = [
    {
      id: 'watchlist',
      title: showWatchlist ? 'Hide watchlist' : 'Show watchlist',
      active: showWatchlist,
      onClick: () => setShowWatchlist((v) => !v),
      icon: (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2.5 4h11M2.5 8h11M2.5 12h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
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
            <span className={styles.brandName}>IBKR Chart</span>
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

        {/* Persistent tool rail on the right edge */}
        <SideRail items={railItems} />
      </div>

      {/* ── Morning summary popup ───────────────────────────────────── */}
      {showSummary && <MarketSummary onClose={() => setShowSummary(false)} />}

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
