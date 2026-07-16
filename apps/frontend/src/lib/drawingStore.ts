/**
 * drawingStore
 *
 * Drawings are stored per-SYMBOL (not per-panel) so the same drawing appears on
 * every chart of that symbol — any timeframe, any panel — lined up by absolute
 * time. localStorage is the fast warm cache; the DURABLE copy is a JSON file on
 * disk behind the backend (`/api/store/drawings` → drawings.json in userData /
 * .data), hydrated at boot and saved (debounced) on every change — so drawings
 * survive app updates, cache clears, and origin/port changes.
 */

import type { Drawing } from './drawings';

const STORAGE_KEY = 'ibkr-chart:drawings:v1';
const SAVE_DEBOUNCE_MS = 600;

type Store = Record<string, Drawing[]>;
type Listener = (symbol: string) => void;

let cache: Store | null = null;
const listeners = new Set<Listener>();

function load(): Store {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as Store) : {};
  } catch {
    cache = {};
  }
  hydrateFromDisk(); // async — merges the durable file copy when it arrives
  return cache;
}

// ─── Durable file persistence (backend /api/store/drawings) ─────────────────

let hydrateStarted = false;

function hydrateFromDisk(): void {
  if (hydrateStarted) return;
  hydrateStarted = true;
  void (async () => {
    try {
      const res = await fetch('/api/store/drawings');
      if (!res.ok) return;
      const disk = (await res.json()) as Store;
      if (!disk || typeof disk !== 'object') return;
      const store = cache ?? (cache = {});
      // Union per symbol by drawing id: disk restores anything the browser
      // profile lost; drawings created before hydration finished are kept.
      let changed = false;
      const localHasData = Object.values(store).some((a) => a?.length);
      for (const [symbol, diskDrawings] of Object.entries(disk)) {
        if (!Array.isArray(diskDrawings) || !diskDrawings.length) continue;
        const local = store[symbol] ?? [];
        const have = new Set(local.map((d) => d.id));
        const merged = [...local, ...diskDrawings.filter((d) => d && !have.has(d.id))];
        if (merged.length !== local.length) {
          store[symbol] = merged;
          changed = true;
          for (const l of listeners) l(symbol);
        }
      }
      if (changed) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch { /* quota */ }
      } else if (localHasData) {
        saveToDisk(); // first run after update: seed the file from localStorage
      }
    } catch { /* backend not up yet — localStorage still works; next boot retries */ }
  })();
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function saveToDisk(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void fetch('/api/store/drawings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cache ?? {}),
    }).catch(() => { /* transient — next change retries */ });
  }, SAVE_DEBOUNCE_MS);
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache ?? {}));
  } catch { /* quota */ }
  saveToDisk();
}

export function getDrawings(symbol: string): Drawing[] {
  return load()[symbol] ?? [];
}

export function setDrawings(symbol: string, drawings: Drawing[]): void {
  const store = load();
  store[symbol] = drawings;
  persist();
  for (const l of listeners) l(symbol);
}

/** Seed a symbol's drawings only if it has none yet (used to migrate legacy per-panel drawings). */
export function seedDrawings(symbol: string, drawings: Drawing[]): void {
  if (!drawings.length) return;
  const store = load();
  if (store[symbol]?.length) return;
  store[symbol] = drawings;
  persist();
  for (const l of listeners) l(symbol);
}

export function subscribeDrawings(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
