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
  /** The bar to describe — the hovered one, else the latest. */
  data: OHLCVData | null;
  /** True when `data` is the bar under the crosshair rather than the live one. */
  hovering?: boolean;
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const fmtVol = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
};

/**
 * On-chart OHLC legend, pinned to the top-left of the pane — the way TradingView
 * and openmarket present it, rather than competing for room in the toolbar.
 *
 * Always visible and crosshair-driven: it describes the bar under the cursor,
 * falling back to the newest bar when the pointer is off the chart. Keys are
 * muted micro-labels so the numbers carry the emphasis, and every colour comes
 * from the theme tokens so it follows a pasted theme like everything else.
 */
export default function PriceDisplay({ symbol, data, hovering = false }: Props) {
  if (!data) return null;

  const isUp = data.close >= data.open;
  const change = data.close - data.open;
  const changePct = data.open ? (change / data.open) * 100 : 0;
  const dir = isUp ? styles.up : styles.down;

  const cell = (key: string, value: number) => (
    <span className={styles.cell}>
      <span className={styles.key}>{key}</span>
      <span className={`${styles.val} ${dir}`}>{fmt(value)}</span>
    </span>
  );

  return (
    <div className={`${styles.legend} ${hovering ? styles.legendHover : ''}`} title={symbol ?? undefined}>
      {cell('O', data.open)}
      {cell('H', data.high)}
      {cell('L', data.low)}
      {cell('C', data.close)}
      <span className={`${styles.change} ${dir}`}>
        {isUp ? '+' : ''}{fmt(change)} ({isUp ? '+' : ''}{changePct.toFixed(2)}%)
      </span>
      <span className={styles.cell}>
        <span className={styles.key}>Vol</span>
        <span className={styles.val}>{fmtVol(data.volume)}</span>
      </span>
    </div>
  );
}
