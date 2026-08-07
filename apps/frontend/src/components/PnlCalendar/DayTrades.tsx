/**
 * DayTrades — the drill-down under the calendar.
 *
 * Lists the matched round-trips that CLOSED on one ET date. Clicking a row
 * hands the trade to the chart (1-minute, that session, entry/exit markers).
 */

import { useEffect, useState } from 'react';
import type { MatchedTrade, TradesDayResponse } from '@ibkr-chart/types';
import styles from './PnlCalendar.module.css';

interface Props {
  date: string;
  onOpenChart: (trade: MatchedTrade) => void;
  onClose: () => void;
}

const money = (n: number, dp = 2) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const clock = (unixSec: number) =>
  new Date(unixSec * 1000).toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: false,
  });

/** "NVDA 200C 7/31" for options, plain ticker for stock. */
function contractLabel(t: MatchedTrade): string {
  if (t.strike == null) return t.symbol;
  const exp = t.expiry && /^\d{8}$/.test(t.expiry)
    ? `${Number(t.expiry.slice(4, 6))}/${Number(t.expiry.slice(6, 8))}`
    : '';
  return `${t.symbol} ${t.strike}${t.right ?? ''}${exp ? ` ${exp}` : ''}`;
}

const held = (t: MatchedTrade): string => {
  const s = Math.max(0, t.exitTime - t.entryTime);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${Math.round(s / 86_400)}d`;
};

export default function DayTrades({ date, onOpenChart, onClose }: Props) {
  const [data, setData] = useState<TradesDayResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/trades/day/${date}`);
        if (!res.ok) { if (!cancelled) setError(`Failed to load (${res.status})`); return; }
        const body = (await res.json()) as TradesDayResponse;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError('Backend unreachable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  const pretty = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const s = data?.summary;

  return (
    <div className={styles.drill}>
      <div className={styles.drillHeader}>
        <span className={styles.drillTitle}>{pretty}</span>
        {s && (
          <span className={styles.drillMeta}>
            <b className={s.pnl >= 0 ? styles.up : styles.down}>{money(s.pnl)}</b>
            {' · '}{s.trades} trade{s.trades === 1 ? '' : 's'}
            {' · '}{s.wins}W / {s.losses}L
            {' · '}{s.volume} contracts
            {' · '}{money(s.commissions)} fees
          </span>
        )}
        <button className={styles.iconBtn} onClick={onClose} title="Close day">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {loading && <div className={styles.loading}>Loading trades…</div>}
      {error && <div className={styles.errorBar}>⚠ {error}</div>}

      {!loading && !error && !data?.trades.length && (
        <div className={styles.hint}>
          No matched round-trips on this day. Days from the IBKR statement only carry
          per-trade detail once the Flex query includes execution-level columns.
        </div>
      )}

      {!!data?.trades.length && (
        <table className={styles.tradeTable}>
          <thead>
            <tr>
              <th>Contract</th>
              <th>Side</th>
              <th className={styles.num}>Qty</th>
              <th className={styles.num}>Entry</th>
              <th className={styles.num}>Exit</th>
              <th className={styles.num}>Held</th>
              <th className={styles.num}>Fees</th>
              <th className={styles.num}>Net P&L</th>
            </tr>
          </thead>
          <tbody>
            {data.trades.map((t) => (
              <tr
                key={t.id}
                className={styles.tradeRow}
                onClick={() => onOpenChart(t)}
                title={`Open ${t.symbol} 1-minute chart for ${date} with entry/exit markers`}
              >
                <td className={styles.contractCell}>
                  {contractLabel(t)}
                  {t.pnlSource === 'computed' && (
                    <span className={styles.tag} title="P&L derived from our FIFO price math — IBKR did not report a realized figure for every exit">calc</span>
                  )}
                </td>
                <td>
                  <span className={t.direction === 'long' ? styles.up : styles.down}>
                    {t.direction === 'long' ? 'Long' : 'Short'}
                  </span>
                </td>
                <td className={styles.num}>{t.quantity}</td>
                <td className={styles.num}>
                  {t.entryPrice.toFixed(2)}
                  <span className={styles.subTime}>{clock(t.entryTime)}</span>
                </td>
                <td className={styles.num}>
                  {t.exitPrice.toFixed(2)}
                  <span className={styles.subTime}>{clock(t.exitTime)}</span>
                </td>
                <td className={styles.num}>{held(t)}</td>
                <td className={styles.num}>{money(t.commission)}</td>
                <td className={`${styles.num} ${styles.pnlCell} ${t.pnl >= 0 ? styles.up : styles.down}`}>
                  {money(t.pnl)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
