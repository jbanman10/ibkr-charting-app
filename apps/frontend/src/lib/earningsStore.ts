/**
 * earningsStore
 *
 * Per-symbol earnings info (next date + last 4 reported quarters) fetched once
 * from GET /api/earnings and cached for the session — the backend already
 * caches upstream for hours, this just avoids refetching as panels re-render or
 * several panels show the same symbol.
 */

import type { EarningsInfo } from '@ibkr-chart/types';

type Listener = (symbol: string) => void;

const cache = new Map<string, EarningsInfo>();
const inflight = new Set<string>();
const listeners = new Set<Listener>();

/** Cached earnings for a symbol; kicks off a fetch on first miss. */
export function getEarnings(symbol: string): EarningsInfo | null {
  if (!symbol) return null;
  const hit = cache.get(symbol);
  if (hit) return hit;
  if (!inflight.has(symbol)) {
    inflight.add(symbol);
    void (async () => {
      try {
        const res = await fetch(`/api/earnings?symbol=${encodeURIComponent(symbol)}`);
        if (res.ok) {
          const info = (await res.json()) as EarningsInfo;
          cache.set(symbol, info);
          for (const l of listeners) l(symbol);
        }
      } catch { /* offline / upstream down — retried next mount */ }
      finally { inflight.delete(symbol); }
    })();
  }
  return null;
}

export function subscribeEarnings(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
