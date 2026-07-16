/**
 * AlertToasts — bottom-right notification stack for triggered price alerts.
 *
 * ChartPanel dispatches an 'ibkr:alert-toast' CustomEvent when an alert fires
 * (already de-duped per alert id by the quack module), so this component has no
 * coupling to the chart internals. Toasts auto-dismiss; click to dismiss early.
 */

import { useState, useEffect } from 'react';
import MallardIcon from '../MallardIcon';
import styles from './AlertToasts.module.css';

export interface AlertToastDetail {
  symbol: string;
  price: number;
}

interface Toast extends AlertToastDetail {
  id: number;
  at: number;
}

const TOAST_MS = 8000;
const MAX_TOASTS = 4;

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

let nextId = 1;

export default function AlertToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const onAlert = (e: Event) => {
      const detail = (e as CustomEvent<AlertToastDetail>).detail;
      if (!detail?.symbol) return;
      const toast: Toast = { ...detail, id: nextId++, at: Date.now() };
      setToasts((t) => [...t, toast].slice(-MAX_TOASTS));
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== toast.id)), TOAST_MS);
    };
    window.addEventListener('ibkr:alert-toast', onAlert);
    return () => window.removeEventListener('ibkr:alert-toast', onAlert);
  }, []);

  if (!toasts.length) return null;

  return (
    <div className={styles.stack}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className={styles.toast}
          onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
          title="Dismiss"
        >
          <div className={styles.duck}><MallardIcon size={30} /></div>
          <div className={styles.body}>
            <div className={styles.headline}>
              <span className={styles.symbol}>{t.symbol}</span>
              <span className={styles.label}>alert</span>
            </div>
            <div className={styles.detail}>
              crossed <span className={styles.price}>{t.price.toFixed(2)}</span>
              <span className={styles.time}> · {TIME_FMT.format(t.at)} ET</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
