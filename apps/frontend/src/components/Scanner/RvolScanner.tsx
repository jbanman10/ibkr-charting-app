/**
 * RvolScanner — mid/large-cap US stocks ranked by session-adjusted relative
 * volume (IBKR HOT_BY_VOLUME scan + exact RVOL from daily bars). Docked like
 * the watchlist; clicking a row loads the symbol into the focused chart.
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './RvolScanner.module.css';

interface RvolRow {
  symbol: string;
  rvol: number;
  price: number;
  changePct: number;
  volume: number;
}

interface Props {
  ibkrConnected: boolean;
  focusedSymbol?: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}

const REFRESH_MS = 60_000;

const fmtPrice = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
function fmtVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return String(Math.round(n));
}

/** Heat color for the RVOL badge: hotter = greener. */
function rvolClass(rvol: number): string {
  if (rvol >= 3) return styles.rvolHot;
  if (rvol >= 1.5) return styles.rvolWarm;
  return styles.rvolCool;
}

export default function RvolScanner({ ibkrConnected, focusedSymbol, onSelect, onClose }: Props) {
  const [rows, setRows] = useState<RvolRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const res = await fetch('/api/scanner/rvol', { signal });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        setError(body?.error ?? `scan failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { rows?: RvolRow[] };
      setRows(body.rows ?? []);
      setError(null);
    } catch { /* aborted / transient — keep last rows */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!ibkrConnected) return;
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    const t = setInterval(() => void refresh(ctrl.signal), REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [ibkrConnected, refresh]);

  return (
    <aside className={styles.drawer} onClick={(e) => e.stopPropagation()}>
      <div className={styles.header}>
        <span className={styles.title}>RVOL Scanner</span>
        {loading && <span className={styles.spinner} aria-label="scanning" />}
        <button className={styles.closeBtn} onClick={onClose} title="Close scanner">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className={styles.subhead}>US mega caps ≥ $90B · vol pace vs normal for this time of day</div>

      <div className={styles.list}>
        {!ibkrConnected && <div className={styles.empty}>IBKR disconnected</div>}
        {ibkrConnected && error && <div className={styles.empty}>⚠ {error}</div>}
        {ibkrConnected && !error && !rows.length && !loading && (
          <div className={styles.empty}>No results — scanner warms up shortly after the open.</div>
        )}
        {ibkrConnected && !error && !rows.length && loading && (
          <div className={styles.empty}>Scanning…</div>
        )}
        {rows.map((r) => (
          <div
            key={r.symbol}
            className={`${styles.row} ${focusedSymbol === r.symbol ? styles.rowActive : ''}`}
            onClick={() => onSelect(r.symbol)}
            title={`Load ${r.symbol} into the focused chart`}
          >
            <div className={styles.rowMain}>
              <span className={styles.symbol}>{r.symbol}</span>
              <span className={styles.volume}>Vol {fmtVol(r.volume)}</span>
            </div>
            <div className={styles.rowStats}>
              <span className={`${styles.rvol} ${rvolClass(r.rvol)}`}>{r.rvol.toFixed(1)}×</span>
              <span className={styles.priceLine}>
                {fmtPrice(r.price)}
                <span className={r.changePct >= 0 ? styles.up : styles.down}> {fmtPct(r.changePct)}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
