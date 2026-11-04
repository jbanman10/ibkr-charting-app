/**
 * chartSettingsStore
 *
 * Behavioural chart settings (as opposed to `themeStore`, which is colour only).
 *
 * Currently just one knob: how the live candle is updated. IBKR's
 * `keepUpToDate` feed reports a new 1m bar roughly SIX SECONDS after the minute
 * boundary (measured: +6.01s, +6.02s, +5.60s on consecutive AAPL bars), so the
 * app has a choice it cannot avoid:
 *
 *  - 'exact'  — show only what IBKR has sent. The candle is always an official
 *               TWS-equivalent bar, but a new one does not appear until ~6s in
 *               and the forming candle steps at IBKR's cadence.
 *  - 'smooth' — paint the forming candle sub-second from the `reqMktData` tick
 *               feed and open the next candle locally on the minute. Responsive,
 *               but everything between the boundary and IBKR's first report is
 *               provisional and gets re-anchored when the real bar lands.
 *
 * Ticks are still received in BOTH modes — price alerts, the daily pre/post
 * price line and the watchlist all depend on them. 'exact' only stops ticks
 * from mutating bar OHLC and from fabricating a rollover.
 *
 * Persistence mirrors `themeStore`: localStorage as the warm cache plus a
 * durable JSON file behind `/api/store/chartSettings`, so the choice survives
 * app updates and cache clears.
 */

const STORAGE_KEY = 'ibkr-chart:chart-settings:v1';
const SAVE_DEBOUNCE_MS = 400;

export type CandleUpdateMode = 'exact' | 'smooth';

export interface ChartSettings {
  candleUpdates: CandleUpdateMode;
}

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  // Default to the feed's own truth. 'smooth' is opt-in because its live edge
  // is provisional for ~6s of every minute.
  candleUpdates: 'exact',
};

type Listener = (settings: ChartSettings) => void;

let current: ChartSettings = DEFAULT_CHART_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();

function isSettings(v: unknown): v is ChartSettings {
  const s = v as ChartSettings;
  return !!s && (s.candleUpdates === 'exact' || s.candleUpdates === 'smooth');
}

/** Load from localStorage, then reconcile with the durable file. */
export function initChartSettings(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isSettings(parsed)) current = parsed;
    }
  } catch { /* corrupt — keep the default */ }

  // The file is authoritative across reinstalls; adopt it if it differs.
  void (async () => {
    try {
      const res = await fetch('/api/store/chartSettings');
      if (!res.ok) return;
      const disk = await res.json();
      if (isSettings(disk) && JSON.stringify(disk) !== JSON.stringify(current)) {
        current = disk;
        for (const l of listeners) l(current);
      }
    } catch { /* backend not up — localStorage still applied */ }
  })();
}

export function getChartSettings(): ChartSettings {
  return current;
}

export function setChartSettings(next: ChartSettings): void {
  current = next;
  persist();
  for (const l of listeners) l(next);
}

/** Subscribe to changes so panels can switch mode without a reload. */
export function subscribeChartSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* quota */ }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fetch('/api/store/chartSettings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(current),
    }).catch(() => { /* transient — next change retries */ });
  }, SAVE_DEBOUNCE_MS);
}
