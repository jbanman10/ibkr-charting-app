/**
 * TradeStats — the analytics tab of the journal.
 *
 * Win rate against average win/loss size, P&L by day of week, by hour of the
 * session, and by underlying, plus consecutive-day streaks. Bars are plain divs
 * scaled to the largest magnitude in each group — no chart library needed for
 * one-dimensional comparisons.
 */

import { useEffect, useState } from 'react';
import type { TradeStatsResponse } from '@ibkr-chart/types';
import styles from './PnlCalendar.module.css';

interface Props {
  from: string;
  to: string;
}

const money = (n: number, dp = 2) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const compact = (n: number) =>
  Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k` : money(n, 0);

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "09:00" for an ET hour bucket. */
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

interface Row { key: string; label: string; pnl: number; trades: number; wins: number; extra?: string }

/** Horizontal diverging bars, scaled to the biggest absolute value in the set. */
function BarGroup({ title, rows, empty }: { title: string; rows: Row[]; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.pnl)));
  return (
    <section className={styles.statSection}>
      <h4 className={styles.statSectionTitle}>{title}</h4>
      {!rows.length && <div className={styles.hint}>{empty}</div>}
      {rows.map((r) => {
        const up = r.pnl >= 0;
        const pct = (Math.abs(r.pnl) / max) * 100;
        return (
          <div key={r.key} className={styles.barRow}>
            <span className={styles.barLabel}>{r.label}</span>
            <div className={styles.barTrack}>
              <div
                className={styles.barFill}
                style={{ width: `${pct}%`, background: up ? 'rgba(11,217,162,0.55)' : 'rgba(249,112,102,0.55)' }}
              />
            </div>
            <span className={`${styles.barValue} ${up ? styles.up : styles.down}`}>{compact(r.pnl)}</span>
            <span className={styles.barMeta}>
              {r.trades}t · {r.trades ? Math.round((r.wins / r.trades) * 100) : 0}%
              {r.extra ? ` · ${r.extra}` : ''}
            </span>
          </div>
        );
      })}
    </section>
  );
}

export default function TradeStats({ from, to }: Props) {
  const [data, setData] = useState<TradeStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/trades/stats?from=${from}&to=${to}`);
        if (!res.ok) { if (!cancelled) setError(`Failed to load (${res.status})`); return; }
        const body = (await res.json()) as TradeStatsResponse;
        if (!cancelled) setData(body);
      } catch {
        if (!cancelled) setError('Backend unreachable');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [from, to]);

  if (loading) return <div className={styles.loading}>Loading stats…</div>;
  if (error) return <div className={styles.errorBar}>⚠ {error}</div>;
  if (!data) return null;

  const t = data.totals;
  // Win rate alone is meaningless without size: a 40% hit rate is excellent when
  // the average win is 3× the average loss. Show the ratio next to it.
  const rr = t.avgWin != null && t.avgLoss ? t.avgWin / t.avgLoss : null;

  return (
    <div className={styles.statsTab}>
      <div className={styles.stats}>
        <Stat label="Net P&L" value={money(t.pnl)} tone={t.pnl > 0 ? 'up' : t.pnl < 0 ? 'down' : undefined} big />
        <Stat label="Trades" value={String(t.trades)} />
        <Stat label="Win rate" value={t.winRate != null ? `${t.winRate.toFixed(1)}%` : '—'} />
        <Stat label="Avg win" value={t.avgWin != null ? money(t.avgWin) : '—'} tone="up" />
        <Stat label="Avg loss" value={t.avgLoss != null ? money(t.avgLoss) : '—'} tone="down" />
        <Stat label="Win / loss size" value={rr != null ? `${rr.toFixed(2)}×` : '—'} />
        <Stat label="Expectancy" value={t.expectancy != null ? money(t.expectancy) : '—'}
          tone={(t.expectancy ?? 0) > 0 ? 'up' : (t.expectancy ?? 0) < 0 ? 'down' : undefined} />
        <Stat label="Profit factor" value={t.profitFactor != null ? t.profitFactor.toFixed(2) : '—'} />
        <Stat label="Commissions" value={money(t.commissions)} />
      </div>

      <div className={styles.stats}>
        <Stat label="Max losing streak" value={`${data.maxConsecutiveLosingDays}d`} tone={data.maxConsecutiveLosingDays > 0 ? 'down' : undefined} />
        <Stat label="Max winning streak" value={`${data.maxConsecutiveWinningDays}d`} tone={data.maxConsecutiveWinningDays > 0 ? 'up' : undefined} />
        <Stat label="Best day" value={data.bestDay ? `${money(data.bestDay.pnl)} · ${data.bestDay.date.slice(5)}` : '—'} tone="up" />
        <Stat label="Worst day" value={data.worstDay ? `${money(data.worstDay.pnl)} · ${data.worstDay.date.slice(5)}` : '—'} tone="down" />
      </div>

      <div className={styles.statGrid}>
        <BarGroup
          title="P&L by day of week"
          empty="No trades in range."
          rows={data.byDayOfWeek
            .filter((d) => d.trades > 0)
            .map((d) => ({ key: `d${d.day}`, label: DOW_LABEL[d.day], pnl: d.pnl, trades: d.trades, wins: d.wins }))}
        />
        <BarGroup
          title="P&L by time of day (entry, ET)"
          empty="No trades in range."
          rows={data.byHour.map((h) => ({
            key: `h${h.hour}`, label: hourLabel(h.hour), pnl: h.pnl, trades: h.trades, wins: h.wins,
          }))}
        />
      </div>

      <BarGroup
        title="P&L by symbol"
        empty="No trades in range."
        rows={data.bySymbol.map((s) => ({
          key: s.symbol, label: s.symbol, pnl: s.pnl, trades: s.trades, wins: s.wins,
          extra: `${s.volume} qty`,
        }))}
      />
    </div>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: string; tone?: 'up' | 'down'; big?: boolean }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${big ? styles.statBig : ''} ${tone === 'up' ? styles.up : tone === 'down' ? styles.down : ''}`}>
        {value}
      </span>
    </div>
  );
}
