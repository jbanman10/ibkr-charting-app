import type { Timeframe } from '@ibkr-chart/types';
import { TIMEFRAMES } from '@ibkr-chart/types';
import styles from './TimeframeSelector.module.css';

const ORDERED: Timeframe[] = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'];

interface Props {
  value: Timeframe;
  onChange: (tf: Timeframe) => void;
}

export default function TimeframeSelector({ value, onChange }: Props) {
  return (
    <div className={styles.root} role="group" aria-label="Timeframe">
      {ORDERED.map((tf) => (
        <button
          key={tf}
          className={`${styles.btn} ${tf === value ? styles.active : ''}`}
          onClick={() => onChange(tf)}
          aria-pressed={tf === value}
        >
          {TIMEFRAMES[tf].label}
        </button>
      ))}
    </div>
  );
}
