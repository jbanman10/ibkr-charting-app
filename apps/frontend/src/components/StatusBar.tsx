import { useEffect, useState } from 'react';
import type { StreamStatus } from '../hooks/useMarketStream';
import { currentSession } from '../lib/sessions';
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

const SESSION_LABEL: Record<string, string> = {
  pre:    'Pre-market',
  rth:    'Open',
  post:   'After hours',
  closed: 'Closed',
};

const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** ET minute-of-day + weekday, for the session countdown. */
function etNow(now: Date): { minute: number; weekday: string } {
  const o: Record<string, string> = {};
  for (const p of ET_PARTS.formatToParts(now)) if (p.type !== 'literal') o[p.type] = p.value;
  return { minute: (Number(o.hour) % 24) * 60 + Number(o.minute), weekday: o.weekday };
}

/**
 * "closes in 3h 12m" / "opens in 48m" — the next session boundary that matters.
 * Weekends just read "Closed" with no countdown: the next open is days away and
 * a running figure there is noise rather than information.
 */
function countdown(now: Date): string | null {
  const { minute, weekday } = etNow(now);
  if (weekday === 'Sat' || weekday === 'Sun') return null;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  let mins: number;
  let verb: string;
  if (minute < OPEN) { mins = OPEN - minute; verb = 'opens'; }
  else if (minute < CLOSE) { mins = CLOSE - minute; verb = 'closes'; }
  else return null; // after the bell — nothing useful left today
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${verb} in ${h > 0 ? `${h}h ${m}m` : `${m}m`}`;
}

export default function StatusBar({ symbol, streamStatus, ibkrConnected }: Props) {
  const isLive = streamStatus === 'connected' && ibkrConnected;
  const [now, setNow] = useState(() => new Date());

  // The clock is the point of the bar, so tick it every second.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const session = currentSession(now.getTime());
  const left = countdown(now);

  return (
    <div className={styles.bar}>
      {/* Left — connection */}
      <div className={styles.group}>
        <span className={`${styles.dot} ${isLive ? styles.live : styles.offline}`} />
        <span className={styles.label}>{STATUS_LABEL[streamStatus]}</span>
        {streamStatus === 'connected' && !ibkrConnected && (
          <span className={styles.dim}>· IBKR waiting</span>
        )}
      </div>

      {/* Right — session, countdown, ET clock */}
      <div className={`${styles.group} ${styles.right}`}>
        {symbol && <span className={styles.sym}>{symbol}</span>}
        <span className={`${styles.badge} ${styles[session] ?? ''}`}>{SESSION_LABEL[session] ?? session}</span>
        {left && <span className={styles.dim}>NY {left}</span>}
        <span className={styles.sep} />
        <span className={styles.clock}>{ET_TIME.format(now)}</span>
        <span className={styles.tz}>ET</span>
      </div>
    </div>
  );
}
