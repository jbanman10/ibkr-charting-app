import { useState, useCallback } from 'react';
import type { QuoteResult } from '@ibkr-chart/types';
import { useWatchlist } from '../../hooks/useWatchlist';
import styles from './WatchlistPanel.module.css';

interface Props {
  ibkrConnected: boolean;
  focusedSymbol?: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}

const fmtPrice = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

function fmtVol(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const hasQuote = (q: QuoteResult | undefined): q is Extract<QuoteResult, { last: number }> =>
  !!q && 'last' in q;

/** Heat color for the RVOL badge (same thresholds as the scanner). */
function rvolClass(rvol: number): string {
  if (rvol >= 3) return styles.rvolHot;
  if (rvol >= 1.5) return styles.rvolWarm;
  return styles.rvolCool;
}

export default function WatchlistPanel({ ibkrConnected, focusedSymbol, onSelect, onClose }: Props) {
  const { symbols, quotes, loading, add, remove } = useWatchlist(true, ibkrConnected);
  const [draft, setDraft] = useState('');

  const submitAdd = useCallback(() => {
    add(draft);
    setDraft('');
  }, [add, draft]);

  return (
    <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
      <div className={styles.header}>
        <span className={styles.title}>Watchlist</span>
        {loading && <span className={styles.spinner} aria-label="refreshing" />}
        <button className={styles.closeBtn} onClick={onClose} title="Close watchlist">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className={styles.addRow}>
        <input
          className={styles.addInput}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
          placeholder="Add symbol…"
          spellCheck={false}
          autoCapitalize="characters"
        />
        <button className={styles.addBtn} onClick={submitAdd} disabled={!draft.trim()} title="Add to watchlist">
          +
        </button>
      </div>

      <div className={styles.list}>
        {!ibkrConnected && <div className={styles.empty}>IBKR disconnected</div>}
        {ibkrConnected && symbols.length === 0 && (
          <div className={styles.empty}>No symbols yet — add one above.</div>
        )}
        {symbols.map((sym) => {
          const q = quotes[sym];
          const quote = hasQuote(q) ? q : null;
          const up = quote ? quote.change >= 0 : false;
          return (
            <div
              key={sym}
              className={`${styles.row} ${focusedSymbol === sym ? styles.rowActive : ''}`}
              onClick={() => onSelect(sym)}
              title={`Load ${sym} into the focused chart`}
            >
              <div className={styles.rowMain}>
                <span className={styles.symbol}>{sym}</span>
                <span className={styles.volume}>Vol {quote ? fmtVol(quote.volume) : '—'}</span>
              </div>
              {quote?.rvol != null && (
                <span
                  className={`${styles.rvol} ${rvolClass(quote.rvol)}`}
                  title="Relative volume vs normal pace for this time of day"
                >
                  {quote.rvol.toFixed(1)}×
                </span>
              )}
              <div className={styles.rowStats}>
                <span className={styles.price}>{quote ? fmtPrice(quote.last) : (q ? 'n/a' : '—')}</span>
                <span className={`${styles.pct} ${quote ? (up ? styles.up : styles.down) : ''}`}>
                  {quote ? fmtPct(quote.changePct) : ''}
                </span>
              </div>
              <button
                className={styles.removeBtn}
                onClick={(e) => { e.stopPropagation(); remove(sym); }}
                title={`Remove ${sym}`}
              >
                <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                  <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
