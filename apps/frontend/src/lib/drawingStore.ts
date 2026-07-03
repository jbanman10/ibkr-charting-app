/**
 * drawingStore
 *
 * Drawings are stored per-SYMBOL (not per-panel) so the same drawing appears on
 * every chart of that symbol — any timeframe, any panel — lined up by absolute
 * time. Backed by localStorage, with a listener set so all panels showing a
 * symbol re-render when its drawings change.
 */

import type { Drawing } from './drawings';

const STORAGE_KEY = 'ibkr-chart:drawings:v1';

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
  return cache;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache ?? {}));
  } catch { /* quota */ }
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
