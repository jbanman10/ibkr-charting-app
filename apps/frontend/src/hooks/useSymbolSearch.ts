import { useState, useEffect, useRef } from 'react';
import type { ContractSearchResult } from '@ibkr-chart/types';

export function useSymbolSearch(query: string, debounceMs = 300) {
  const [results, setResults] = useState<ContractSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim() || query.length < 1) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    timerRef.current = setTimeout(() => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      fetch(`/api/search?q=${encodeURIComponent(query)}`, { signal: controller.signal })
        .then((r) => r.json() as Promise<{ results: ContractSearchResult[] }>)
        .then(({ results }) => {
          setResults(results.slice(0, 12)); // Cap to 12 suggestions
          setLoading(false);
        })
        .catch((err) => {
          if (err?.name === 'AbortError') return;
          setResults([]);
          setLoading(false);
        });
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, debounceMs]);

  return { results, loading };
}
