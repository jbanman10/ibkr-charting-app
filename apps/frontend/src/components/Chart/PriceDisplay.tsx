import { useState } from 'react';
import type { Time } from 'lightweight-charts';
import { etCrosshairFormatter } from '../../lib/chartTime';
import styles from './PriceDisplay.module.css';

interface OHLCVData {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  time?: string | number;
}

interface Props {
  symbol: string | null;
  data: OHLCVData | null;
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const fmtVol = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
};

/**
 * Collapsed by default: a small ⓘ chip in the chart's top-left corner.
 * Clicking it drops down a compact OHLCV card so the numbers are available on
 * demand without permanently covering the candles.
 */
export default function PriceDisplay({ symbol, data }: Props) {
  const [open, setOpen] = useState(false);
  if (!data) return null;

  const isUp = data.close >= data.open;
  const change = data.close - data.open;
  const changePct = (change / data.open) * 100;

  return (
    <div className={styles.root}>
      <button
        className={`${styles.infoBtn} ${open ? styles.infoBtnActive : ''}`}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={open ? 'Hide bar info' : 'Show bar info (OHLCV)'}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="8" cy="4.9" r="0.9" fill="currentColor"/>
        </svg>
        <span className={`${styles.chipPrice} ${isUp ? styles.up : styles.down}`}>{fmt(data.close)}</span>
      </button>

      {open && (
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span className={styles.symbol}>{symbol}</span>
            {data.time != null && (
              <span className={styles.time}>{etCrosshairFormatter(data.time as Time)} ET</span>
            )}
          </div>
          <div className={styles.rows}>
            <div className={styles.row}><span className={styles.key}>Open</span><span className={`${styles.val} ${isUp ? styles.up : styles.down}`}>{fmt(data.open)}</span></div>
            <div className={styles.row}><span className={styles.key}>High</span><span className={`${styles.val} ${isUp ? styles.up : styles.down}`}>{fmt(data.high)}</span></div>
            <div className={styles.row}><span className={styles.key}>Low</span><span className={`${styles.val} ${isUp ? styles.up : styles.down}`}>{fmt(data.low)}</span></div>
            <div className={styles.row}><span className={styles.key}>Close</span><span className={`${styles.val} ${isUp ? styles.up : styles.down}`}>{fmt(data.close)}</span></div>
            <div className={styles.row}>
              <span className={styles.key}>Change</span>
              <span className={`${styles.val} ${isUp ? styles.up : styles.down}`}>
                {isUp ? '+' : ''}{fmt(change)} ({isUp ? '+' : ''}{changePct.toFixed(2)}%)
              </span>
            </div>
            <div className={styles.row}><span className={styles.key}>Volume</span><span className={styles.val}>{fmtVol(data.volume)}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
