import { useEffect, useReducer } from 'react';
import type { QuoteResult } from '@ibkr-chart/types';
import {
  getWatchSymbols,
  getQuotes,
  isQuotesLoading,
  addWatchSymbol,
  removeWatchSymbol,
  refreshQuotes,
  subscribeQuotes,
} from '../lib/quoteStore';

// A thin view onto the global quoteStore. The data itself lives outside React
// so it keeps updating while the watchlist drawer is closed (see quoteStore).

export interface UseWatchlistReturn {
  symbols: string[];
  quotes: Record<string, QuoteResult>;
  loading: boolean;
  add: (symbol: string) => void;
  remove: (symbol: string) => void;
  refresh: () => void;
}

export function useWatchlist(): UseWatchlistReturn {
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => subscribeQuotes(rerender), []);

  return {
    symbols: getWatchSymbols(),
    quotes: getQuotes(),
    loading: isQuotesLoading(),
    add: addWatchSymbol,
    remove: removeWatchSymbol,
    refresh: refreshQuotes,
  };
}
