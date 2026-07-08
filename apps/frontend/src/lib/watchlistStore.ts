// A single global watchlist, persisted to localStorage. It is shared across all
// panels/windows: clicking a ticker loads it into the focused chart.

const KEY = 'ibkr_watchlist_v1';
const DEFAULT: string[] = ['SPY', 'QQQ', 'AAPL', 'TSLA', 'NVDA'];

export function loadWatchlist(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch { /* corrupt/absent — fall through to default */ }
  return [...DEFAULT];
}

export function saveWatchlist(list: string[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota/private mode */ }
}
