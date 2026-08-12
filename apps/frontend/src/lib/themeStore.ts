/**
 * themeStore
 *
 * Holds the active theme, writes its derived palette onto <html> as CSS custom
 * properties, and tells the charts to re-apply their options.
 *
 * The UI recolours purely through the CSS variables it already uses, so nothing
 * in the components needs to know a theme exists. lightweight-charts can't read
 * CSS variables, so chart instances subscribe here and call applyOptions —
 * that's what `subscribeTheme` is for.
 *
 * Persistence mirrors drawingStore: localStorage as the warm cache, plus a
 * durable JSON file behind /api/store/theme so a theme survives app updates and
 * cache clears.
 */

import { DEFAULT_THEME, deriveCssVars, type ChartTheme } from './theme';

const STORAGE_KEY = 'ibkr-chart:theme:v1';
const SAVE_DEBOUNCE_MS = 400;

type Listener = (theme: ChartTheme) => void;

let current: ChartTheme = DEFAULT_THEME;
let loaded = false;
const listeners = new Set<Listener>();

function isTheme(v: unknown): v is ChartTheme {
  const t = v as ChartTheme;
  return !!t && typeof t.background === 'string' && typeof t.bullBody === 'string'
    && typeof t.bearBody === 'string' && typeof t.text === 'string';
}

/** Write the derived palette onto the document root. */
function applyToDocument(theme: ChartTheme): void {
  const vars = deriveCssVars(theme);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  // Lets native widgets (scrollbars, colour inputs, form controls) follow.
  root.style.colorScheme = luminanceIsLight(theme.background) ? 'light' : 'dark';
}

function luminanceIsLight(bg: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
}

/** Load from localStorage and apply, then reconcile with the durable file. */
export function initTheme(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (isTheme(parsed)) current = parsed;
    }
  } catch { /* corrupt — keep the default */ }
  applyToDocument(current);

  // The file is authoritative across reinstalls; adopt it if it differs.
  void (async () => {
    try {
      const res = await fetch('/api/store/theme');
      if (!res.ok) return;
      const disk = await res.json();
      if (isTheme(disk) && JSON.stringify(disk) !== JSON.stringify(current)) {
        current = disk;
        applyToDocument(current);
        for (const l of listeners) l(current);
      }
    } catch { /* backend not up — localStorage still applied */ }
  })();
}

export function getTheme(): ChartTheme {
  return current;
}

export function setTheme(theme: ChartTheme): void {
  current = theme;
  applyToDocument(theme);
  persist();
  for (const l of listeners) l(theme);
}

/** Subscribe to theme changes (chart instances re-apply their options). */
export function subscribeTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function persist(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(current)); } catch { /* quota */ }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fetch('/api/store/theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(current),
    }).catch(() => { /* transient — next change retries */ });
  }, SAVE_DEBOUNCE_MS);
}
