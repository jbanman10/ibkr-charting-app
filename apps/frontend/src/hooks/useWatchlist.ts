import { useState, useEffect, useRef, useCallback } from 'react';
import type { QuoteResult } from '@ibkr-chart/types';
import { loadWatchlist, saveWatchlist } from '../lib/watchlistStore';

// Poll the batch-quote endpoint while the watchlist is open. Each poll is one
// `/api/quotes` request (serialized backend-side), so keep it gentle.
const REFRESH_MS = 30_000;

export interface UseWatchlistReturn {
  symbols: string[];
  quotes: Record<string, QuoteResult>;
  loading: boolean;
  add: (symbol: string) => void;
  remove: (symbol: string) => void;
  refresh: () => void;
}

export function useWatchlist(enabled: boolean, ibkrConnected: boolean): UseWatchlistReturn {
  const [symbols, setSymbols] = useState<string[]>(loadWatchlist);
  const [quotes, setQuotes] = useState<Record<string, QuoteResult>>({});
  const [loading, setLoading] = useState(false);

  const symbolsRef = useRef(symbols);
  useEffect(() => { symbolsRef.current = symbols; saveWatchlist(symbols); }, [symbols]);

  const add = useCallback((symbol: string) => {
    const s = symbol.trim().toUpperCase();
    if (!s) return;
    setSymbols((prev) => (prev.includes(s) ? prev : [...prev, s]));
  }, []);

  const remove = useCallback((symbol: string) => {
    setSymbols((prev) => prev.filter((x) => x !== symbol));
    setQuotes((prev) => { const { [symbol]: _drop, ...rest } = prev; return rest; });
  }, []);

  const fetchQuotes = useCallback(async (signal?: AbortSignal) => {
    const syms = symbolsRef.current;
    if (!syms.length) { setQuotes({}); return; }
    setLoading(true);
    try {
      const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(','))}`, { signal });
      if (!res.ok) return;
      const body = (await res.json()) as { quotes?: QuoteResult[] };
      const map: Record<string, QuoteResult> = {};
      for (const q of body.quotes ?? []) map[q.symbol] = q;
      setQuotes(map);
    } catch { /* transient / aborted — next cycle retries */ }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(() => { void fetchQuotes(); }, [fetchQuotes]);

  // Poll only while open + connected. Re-fetch immediately when the list changes
  // (add/remove) so a new ticker shows a price without waiting a full cycle.
  useEffect(() => {
    if (!enabled || !ibkrConnected) return;
    const ctrl = new AbortController();
    void fetchQuotes(ctrl.signal);
    const t = setInterval(() => void fetchQuotes(ctrl.signal), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [enabled, ibkrConnected, symbols, fetchQuotes]);

  return { symbols, quotes, loading, add, remove, refresh };
}
