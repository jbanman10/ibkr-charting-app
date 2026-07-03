import { useState, useEffect, useRef } from 'react';
import type { Bar, Timeframe, SecType } from '@ibkr-chart/types';

export interface HistoricalState {
  bars: Bar[];
  loading: boolean;
  error: string | null;
}

export function useHistoricalBars(
  symbol: string | null,
  secType: SecType,
  exchange: string,
  currency: string,
  timeframe: Timeframe,
  useRTH: 0 | 1 = 0
): HistoricalState {
  const [state, setState] = useState<HistoricalState>({
    bars: [],
    loading: false,
    error: null,
  });

  // Use a ref to track the current request key — only cancel if key actually changes
  const keyRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!symbol) {
      setState({ bars: [], loading: false, error: null });
      return;
    }

    const key = `${symbol}|${secType}|${exchange}|${currency}|${timeframe}|${useRTH}`;

    // Don't re-fetch if nothing changed
    if (key === keyRef.current) return;
    keyRef.current = key;

    // Cancel previous request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setState({ bars: [], loading: true, error: null });

    const params = new URLSearchParams({
      symbol,
      secType,
      exchange,
      currency,
      timeframe,
      useRTH: String(useRTH),
    });

    const url = `/api/bars?${params}`;
    console.log('[useHistoricalBars] fetching:', url);

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        const text = await res.text();
        console.log('[useHistoricalBars] raw response:', text.slice(0, 200));

        if (!text || text.trim() === '') {
          throw new Error('Empty response from server');
        }

        let body: { bars?: Bar[]; error?: string };
        try {
          body = JSON.parse(text);
        } catch {
          throw new Error(`Invalid JSON: ${text.slice(0, 100)}`);
        }

        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body.bars ?? [];
      })
      .then((bars) => {
        console.log('[useHistoricalBars] got bars:', bars.length, bars[0]);
        setState({ bars, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') {
          console.log('[useHistoricalBars] aborted for:', key);
          return;
        }
        console.error('[useHistoricalBars] error:', err.message);
        setState({ bars: [], loading: false, error: err.message });
      });

    return () => {
      // Don't abort on cleanup — let the request finish
      // Only abort if the key changes (handled above)
    };
  }, [symbol, secType, exchange, currency, timeframe, useRTH]);

  return state;
}
