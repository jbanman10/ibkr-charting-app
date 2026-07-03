import type { StreamStatus } from '../../hooks/useMarketStream';
import styles from './StatusBar.module.css';

interface Props {
  symbol: string | null;
  streamStatus: StreamStatus;
  ibkrConnected: boolean;
}

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting:   'Connecting…',
  connected:    'Connected',
  disconnected: 'Disconnected',
  ibkr_down:    'IBKR offline',
};

export default function StatusBar({ symbol, streamStatus, ibkrConnected }: Props) {
  const isLive = streamStatus === 'connected' && ibkrConnected;

  return (
    <div className={styles.bar}>
      {/* Left — IBKR status */}
      <div className={styles.group}>
        <span className={`${styles.dot} ${isLive ? styles.live : styles.offline}`} />
        <span className={styles.label}>{STATUS_LABEL[streamStatus]}</span>
        {streamStatus === 'connected' && (
          <span className={`${styles.label} ${styles.dim}`}>
            · IBKR {ibkrConnected ? 'ready' : 'waiting'}
          </span>
        )}
      </div>

      {/* Right — symbol + timestamp */}
      <div className={`${styles.group} ${styles.right}`}>
        {symbol && <span className={`${styles.label} ${styles.mono}`}>{symbol}</span>}
        <span className={styles.dim}>
          {new Date().toLocaleTimeString('en-US', { hour12: false })}
        </span>
      </div>
    </div>
  );
}
