import { useState, useCallback, useEffect, useRef } from 'react';
import type { Bar, Timeframe } from '@ibkr-chart/types';
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
import styles from './App.module.css';

const AUTOSAVE_MS = 5_000;

export default function App() {
  const [layout, setLayout] = useState<LayoutConfig>(loadLayout);
  const [focusedPanelId, setFocusedPanelId] = useState<string>(
    () => loadLayout().panels[0]?.id ?? ''
  );
  const [activeTool, setActiveTool] = useState<DrawingToolType>('none');
  const [showSummary, setShowSummary] = useState(false);
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

  const { status, ibkrConnected, subscribe, unsubscribe } = useMarketStream({
    onSnapshot:  useCallback((sym: string, bars: Bar[], tf: Timeframe) => routeSnapshot(sym, bars, tf), [routeSnapshot]),
    onBarUpdate: useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barUpdateHandler', sym, bar, tf), [routeBar]),
    onBarClose:  useCallback((sym: string, bar: Bar, tf: Timeframe) => routeBar('__barCloseHandler',  sym, bar, tf), [routeBar]),
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

  return (
    <div className={styles.root}>

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <header className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          <div className={styles.brand}>
            {/* Mallard mascot — green head, white neck ring, yellow bill */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              {/* tail flick */}
              <path d="M19 10.5 L22.6 8 C22.9 11 21.9 13 20 14 Z" fill="#8f99a3"/>
              {/* body (grey) */}
              <path d="M4.5 13.5c0 4.3 3.3 6.8 7.8 6.8s7.9-2.5 7.9-6.6c0-1.7-1.5-3.2-3.5-3.2h-8.7c-2 0-3.5 1.4-3.5 3Z" fill="#9aa4ae"/>
              {/* chestnut breast (front of body, under the head) */}
              <path d="M4.5 13.5c0 2.5 1.1 4.4 3 5.6 1.6-1.5 2.5-3.5 2.5-5.8 0-1-.2-2-.5-2.8H8c-2 0-3.5 1.4-3.5 3Z" fill="#7a4a2b"/>
              {/* white neck ring (arc where head meets body) */}
              <circle cx="8.2" cy="7.4" r="4.35" stroke="#f2efe6" strokeWidth="1.1" fill="none"
                strokeDasharray="7.5 19.8" transform="rotate(52 8.2 7.4)"/>
              {/* head (mallard green) */}
              <circle cx="8.2" cy="7.4" r="4" fill="#1f9d55"/>
              {/* bill (yellow) */}
              <path d="M4.3 6.8 L1.2 8 L4.5 9.4 C4.2 8.5 4.2 7.6 4.3 6.8 Z" fill="#f0c437"/>
              {/* eye */}
              <circle cx="7.4" cy="6.4" r="0.85" fill="#0b0e11"/>
              {/* wing (darker) */}
              <path d="M10.8 14c2.3-.7 4.4-.1 5 1.4-1.7 1.3-4 1.1-5.4-.2Z" fill="rgba(0,0,0,0.22)"/>
            </svg>
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

      {/* ── Resizable panel grid ────────────────────────────────────── */}
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

      {/* ── Morning summary popup ───────────────────────────────────── */}
      {showSummary && <MarketSummary onClose={() => setShowSummary(false)} />}

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <StatusBar
        symbol={focusedPanel?.symbol ?? null}
        streamStatus={status}
        ibkrConnected={ibkrConnected}
      />
    </div>
  );
}
