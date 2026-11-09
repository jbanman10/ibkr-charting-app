/**
 * layout.ts — Layout persistence with flexible grid support
 *
 * Grid layouts define how panels are arranged using a CSS grid template.
 * Each layout preset has named areas; panels are assigned to areas by index.
 * Panel sizes (column/row splits) are stored as percentages and applied
 * as CSS custom properties so drag-resize can update them without re-rendering.
 */

import type { Timeframe, IndicatorConfig, SecType } from '@ibkr-chart/types';
import type { Drawing } from './drawings';

const SCHEMA_VERSION = 3;

// Layout is persisted per window. In the Electron desktop shell each window is
// opened with a `?win=<id>` query param, so its layout is stored under a scoped
// key (`ibkr_chart_layout_v3:win<id>`). Windows share one origin/localStorage,
// so scoping the key is what makes each window's layout independent. In a plain
// browser (no `?win=`) the base key is used, keeping backward compatibility.
const STORAGE_KEY = (() => {
  const base = 'ibkr_chart_layout_v3';
  try {
    const win = new URLSearchParams(window.location.search).get('win');
    return win ? `${base}:win${win}` : base;
  } catch {
    return base;
  }
})();

// ─── Grid layout presets ──────────────────────────────────────────────────────

export type GridPresetId =
  | 'single'
  | 'side-by-side'
  | 'stacked'
  | 'quad'
  | 'grid-6'
  | 'primary-right'
  | 'primary-left';

export interface GridPreset {
  id: GridPresetId;
  label: string;
  icon: string;       // SVG path data for the preview icon
  panelCount: number; // How many panels this layout supports
  // CSS grid-template-areas string (each row is a quoted string)
  areas: string;
  // Default column/row track sizes as fr values
  columns: number[];  // e.g. [1, 1] → "1fr 1fr"
  rows: number[];     // e.g. [1, 1] → "1fr 1fr"
  // Which grid-area name each panel index maps to
  areaNames: string[];
}

export const GRID_PRESETS: Record<GridPresetId, GridPreset> = {
  single: {
    id: 'single',
    label: '1 Panel',
    icon: 'M2 2h20v20H2z',
    panelCount: 1,
    areas: '"a"',
    columns: [1],
    rows: [1],
    areaNames: ['a'],
  },
  'side-by-side': {
    id: 'side-by-side',
    label: '2 Columns',
    icon: 'M2 2h9v20H2zM13 2h9v20h-9z',
    panelCount: 2,
    areas: '"a b"',
    columns: [1, 1],
    rows: [1],
    areaNames: ['a', 'b'],
  },
  stacked: {
    id: 'stacked',
    label: '2 Rows',
    icon: 'M2 2h20v9H2zM2 13h20v9H2z',
    panelCount: 2,
    areas: '"a" "b"',
    columns: [1],
    rows: [1, 1],
    areaNames: ['a', 'b'],
  },
  quad: {
    id: 'quad',
    label: '2×2 Grid',
    icon: 'M2 2h9v9H2zM13 2h9v9h-9zM2 13h9v9H2zM13 13h9v9h-9z',
    panelCount: 4,
    areas: '"a b" "c d"',
    columns: [1, 1],
    rows: [1, 1],
    areaNames: ['a', 'b', 'c', 'd'],
  },
  'grid-6': {
    id: 'grid-6',
    label: '2×3 Grid',
    icon: 'M2 2h6v9H2zM9 2h6v9H9zM16 2h6v9h-6zM2 13h6v9H2zM9 13h6v9H9zM16 13h6v9h-6z',
    panelCount: 6,
    areas: '"a b c" "d e f"',
    columns: [1, 1, 1],
    rows: [1, 1],
    areaNames: ['a', 'b', 'c', 'd', 'e', 'f'],
  },
  'primary-left': {
    id: 'primary-left',
    label: 'Primary Left',
    icon: 'M2 2h13v20H2zM17 2h5v9h-5zM17 13h5v9h-5z',
    panelCount: 3,
    areas: '"a b" "a c"',
    columns: [2, 1],
    rows: [1, 1],
    areaNames: ['a', 'b', 'c'],
  },
  'primary-right': {
    id: 'primary-right',
    label: 'Primary Right',
    icon: 'M2 2h5v9H2zM2 13h5v9H2zM9 2h13v20H9z',
    panelCount: 3,
    areas: '"a c" "b c"',
    columns: [1, 2],
    rows: [1, 1],
    areaNames: ['a', 'b', 'c'],
  },
};

// ─── Panel config ─────────────────────────────────────────────────────────────

export interface SessionOverlays {
  openingRange: boolean; // first-5min high & low
  // First-15min high & low. Optional for the same reason as extendedPrice:
  // panels saved before it existed must read as ON, not off.
  openingRange15?: boolean;
  prevDayHL: boolean;    // previous day high & low
  premarketHL: boolean;  // pre-market high & low
  shading: boolean;      // pre/post-market background tint
  // Live pre/post-market price line on the DAILY chart. Optional so panels
  // saved before it existed still read as ON — absence means "not yet chosen",
  // and only an explicit `false` turns it off.
  extendedPrice?: boolean;
}

export const DEFAULT_SESSION_OVERLAYS: SessionOverlays = {
  openingRange: true,
  openingRange15: true,
  prevDayHL: true,
  premarketHL: true,
  shading: true,
  extendedPrice: true,
};

/** Style overrides for one session level line (PDH/PDL/PMH/PML/ORH/ORL/OR15H/OR15L). */
export interface SessionLevelStyle {
  color?: string;
  lineWidth?: number; // 1–4
  dashed?: boolean;
}

export interface PanelConfig {
  id: string;
  symbol: string;
  secType: SecType;
  exchange: string;          // data/routing exchange — SMART for consolidated tape
  currency: string;
  primaryExchange?: string;  // listing exchange (disambiguation only)
  timeframe: Timeframe;
  indicators: IndicatorConfig[];
  drawings: Drawing[];
  useRTH: 0 | 1;
  sessionOverlays: SessionOverlays;
  // Keyed by level ('PDH', 'PML', …); absent = theme defaults.
  sessionLevelStyles?: Record<string, SessionLevelStyle>;
  // Trade-journal review mode: unix seconds to load history UP TO, instead of
  // the live window. Set when a journal trade is opened so a session months in
  // the past can be inspected; the panel stops streaming while it's set.
  sessionEnd?: number;
  // ET date being reviewed ('YYYY-MM-DD'), for the review banner.
  sessionLabel?: string;
}

// ─── Layout config ────────────────────────────────────────────────────────────

export interface LayoutConfig {
  version: number;
  presetId: GridPresetId;
  // Current column sizes as percentage (0–100), length = preset.columns.length - 1
  // e.g. for 2 columns: [50] means 50/50 split
  columnSizes: number[];
  // Current row sizes as percentage, length = preset.rows.length - 1
  rowSizes: number[];
  panels: PanelConfig[];
  savedAt: number;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

// Daily (multi-timeframe) MAs shown on every panel by default: 5/20/200-day
// levels projected onto whatever timeframe the panel is on.
const DEFAULT_DAILY_MAS: IndicatorConfig[] = [
  { type: 'SMA', period: 5,   color: '#38bdf8', visible: true, source: 'daily' },
  { type: 'SMA', period: 20,  color: '#f59e0b', visible: true, source: 'daily' },
  { type: 'SMA', period: 200, color: '#e5e7eb', visible: true, source: 'daily' },
];

export function defaultPanel(id: string, symbol = 'AAPL'): PanelConfig {
  return {
    id,
    symbol,
    secType: 'STK',
    exchange: 'SMART',
    currency: 'USD',
    timeframe: '1d',
    useRTH: 0 as 0 | 1,
    indicators: [
      { type: 'SMA', period: 20,  color: '#f0b429', visible: true },
      { type: 'EMA', period: 50,  color: '#60a5fa', visible: true },
      ...DEFAULT_DAILY_MAS.map((m) => ({ ...m })),
    ],
    drawings: [],
    sessionOverlays: { ...DEFAULT_SESSION_OVERLAYS },
  };
}

const PRESET_SYMBOLS: Record<GridPresetId, string[]> = {
  single:         ['AAPL'],
  'side-by-side': ['AAPL', 'TSLA'],
  stacked:        ['AAPL', 'SPY'],
  quad:           ['AAPL', 'TSLA', 'SPY', 'QQQ'],
  'grid-6':       ['AAPL', 'TSLA', 'SPY', 'QQQ', 'NVDA', 'META'],
  'primary-left': ['AAPL', 'SPY', 'QQQ'],
  'primary-right':['AAPL', 'SPY', 'QQQ'],
};

export function defaultLayout(presetId: GridPresetId = 'quad'): LayoutConfig {
  const preset = GRID_PRESETS[presetId];
  const symbols = PRESET_SYMBOLS[presetId];
  return {
    version: SCHEMA_VERSION,
    presetId,
    columnSizes: preset.columns.length > 1 ? [50] : [],
    rowSizes: preset.rows.length > 1 ? [50] : [],
    panels: Array.from({ length: preset.panelCount }, (_, i) =>
      defaultPanel(`panel-${i + 1}`, symbols[i] ?? 'AAPL')
    ),
    savedAt: Date.now(),
  };
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function saveLayout(layout: LayoutConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...layout, savedAt: Date.now() }));
  } catch { /* quota exceeded */ }
}

export function loadLayout(): LayoutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultLayout();
    const parsed = JSON.parse(raw) as LayoutConfig;
    if (parsed.version !== SCHEMA_VERSION) return defaultLayout();
    // Validate preset still exists
    if (!GRID_PRESETS[parsed.presetId]) return defaultLayout();
    // Backfill fields added after this layout was first saved.
    parsed.panels = parsed.panels.map((p) => {
      const next = {
        ...p,
        sessionOverlays: p.sessionOverlays ?? { ...DEFAULT_SESSION_OVERLAYS },
      };
      // Migrate stock panels saved with a single-venue exchange (old symbol
      // search filled in the primary exchange, e.g. NASDAQ): market data must
      // come from SMART (consolidated tape) or highs/lows differ from TWS/TV
      // by pennies and candles show single-venue gaps.
      if (next.secType === 'STK' && next.exchange && next.exchange !== 'SMART') {
        next.primaryExchange = next.exchange;
        next.exchange = 'SMART';
      }
      // Backfill the default daily (MTF) MAs onto panels saved before they
      // existed, so they appear without a layout reset.
      if (!(next.indicators ?? []).some((i) => i.source === 'daily')) {
        next.indicators = [...(next.indicators ?? []), ...DEFAULT_DAILY_MAS.map((m) => ({ ...m }))];
      }
      return next;
    });
    return parsed;
  } catch {
    return defaultLayout();
  }
}

export function clearLayout(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// ─── Mutation helpers (all pure) ──────────────────────────────────────────────

export function switchPreset(layout: LayoutConfig, presetId: GridPresetId): LayoutConfig {
  const preset = GRID_PRESETS[presetId];
  const newPanelCount = preset.panelCount;
  const oldPanels = layout.panels;

  // Reuse existing panels where possible, create new ones for extra slots
  const panels: PanelConfig[] = Array.from({ length: newPanelCount }, (_, i) => {
    if (i < oldPanels.length) return { ...oldPanels[i] };
    const symbols = PRESET_SYMBOLS[presetId];
    return defaultPanel(`panel-${Date.now()}-${i}`, symbols[i] ?? 'AAPL');
  });

  return {
    ...layout,
    presetId,
    columnSizes: preset.columns.length > 1 ? [50] : [],
    rowSizes: preset.rows.length > 1 ? [50] : [],
    panels,
  };
}

export function updatePanel(
  layout: LayoutConfig,
  id: string,
  updates: Partial<PanelConfig>
): LayoutConfig {
  return {
    ...layout,
    panels: layout.panels.map((p) => (p.id === id ? { ...p, ...updates } : p)),
  };
}

export function swapPanels(layout: LayoutConfig, idA: string, idB: string): LayoutConfig {
  const panels = layout.panels.map((p) => {
    if (p.id === idA) return { ...layout.panels.find((x) => x.id === idB)!, id: idA };
    if (p.id === idB) return { ...layout.panels.find((x) => x.id === idA)!, id: idB };
    return p;
  });
  return { ...layout, panels };
}

// ─── CSS grid string builders ─────────────────────────────────────────────────

/** Build grid-template-columns CSS value from preset + current sizes */
export function buildGridColumns(preset: GridPreset, columnSizes: number[]): string {
  if (preset.columns.length === 1) return '1fr';
  if (columnSizes.length === 0) return preset.columns.map(() => '1fr').join(' ');

  // For 2 columns: columnSizes[0] is left% → right% = 100 - left%
  if (preset.columns.length === 2) {
    const left = columnSizes[0] ?? 50;
    return `${left}fr ${100 - left}fr`;
  }
  // Extend for more columns if needed
  return preset.columns.map(() => '1fr').join(' ');
}

export function buildGridRows(preset: GridPreset, rowSizes: number[]): string {
  if (preset.rows.length === 1) return '1fr';
  if (rowSizes.length === 0) return preset.rows.map(() => '1fr').join(' ');

  if (preset.rows.length === 2) {
    const top = rowSizes[0] ?? 50;
    return `${top}fr ${100 - top}fr`;
  }
  return preset.rows.map(() => '1fr').join(' ');
}
