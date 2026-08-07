/**
 * PnlCalendar — a TradeZella-style monthly P&L calendar and trade journal.
 *
 * Month grid of trading days coloured by realized P&L (net of commissions),
 * with per-day trade count and win rate, weekly totals down the right, and a
 * month stats header. Clicking a day drills into its matched round-trips; a
 * second tab holds the analytics.
 *
 * Days come from /api/trades/summary, which is built from FIFO-matched trades
 * (lib/tradeMatcher on the backend) rather than raw fills — history from IBKR's
 * Flex statement, the current session from locally collected executions.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import type { MatchedTrade, TradeDaySummary, TradesSummaryResponse } from '@ibkr-chart/types';
import DayTrades from './DayTrades';
import TradeStats from './TradeStats';
import styles from './PnlCalendar.module.css';

interface Props {
  onClose: () => void;
  /** Load this trade's session onto the focused 1-minute chart. */
  onOpenTradeOnChart: (trade: MatchedTrade) => void;
}

type Tab = 'calendar' | 'stats';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const money = (n: number, dp = 2) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const compact = (n: number) =>
  Math.abs(n) >= 1000 ? `${n < 0 ? '-' : ''}$${(Math.abs(n) / 1000).toFixed(1)}k` : money(n, 0);

/** Local calendar date key, matching the backend's ET trade dates. */
const dateKey = (y: number, m: number, d: number) =>
  `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

export default function PnlCalendar({ onClose, onOpenTradeOnChart }: Props) {
  const now = new Date();
  const [tab, setTab] = useState<Tab>('calendar');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [data, setData] = useState<TradesSummaryResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [token, setToken] = useState('');
  const [queryId, setQueryId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/trades/summary');
      if (!res.ok) { setError(`Failed to load (${res.status})`); return; }
      const body = (await res.json()) as TradesSummaryResponse;
      setData(body);
      setError(null);
      if (!body.flexConfigured) setShowSetup(true);
    } catch {
      setError('Backend unreachable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Esc closes the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const sync = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/pnl/sync', { method: 'POST' });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!body.ok) setError(body.error ?? 'Sync failed');
      else await load();
    } catch {
      setError('Sync failed');
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const saveFlex = useCallback(async () => {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch('/api/pnl/flex', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.trim(), queryId: queryId.trim() }),
      });
      const body = await res.json() as { ok?: boolean; error?: string };
      if (!body.ok) { setError(body.error ?? 'Could not reach IBKR with those details'); return; }
      setShowSetup(false);
      setToken(''); setQueryId('');
      await load();
    } catch {
      setError('Could not save');
    } finally {
      setSyncing(false);
    }
  }, [token, queryId, load]);

  const byDate = useMemo(() => {
    const m = new Map<string, TradeDaySummary>();
    for (const d of data?.days ?? []) m.set(d.date, d);
    return m;
  }, [data]);

  // The stats tab covers the displayed month, so switching months re-scopes it.
  const monthRange = useMemo(() => {
    const mm = String(month + 1).padStart(2, '0');
    const last = new Date(year, month + 1, 0).getDate();
    return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
  }, [year, month]);

  // Weeks of the displayed month, padded to whole Sun–Sat rows.
  const weeks = useMemo(() => {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells: Array<{ day: number | null; key: string | null }> = [];
    for (let i = 0; i < first.getDay(); i++) cells.push({ day: null, key: null });
    for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: dateKey(year, month, d) });
    while (cells.length % 7 !== 0) cells.push({ day: null, key: null });
    const rows: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [year, month]);

  // Month totals across the days actually in this month.
  const stats = useMemo(() => {
    const days = (data?.days ?? []).filter((d) => d.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`));
    const pnl = days.reduce((a, d) => a + d.pnl, 0);
    const trades = days.reduce((a, d) => a + d.trades, 0);
    const wins = days.reduce((a, d) => a + d.wins, 0);
    const grossWin = days.reduce((a, d) => a + d.grossWin, 0);
    const grossLoss = Math.abs(days.reduce((a, d) => a + d.grossLoss, 0));
    const losses = trades - wins;
    return {
      pnl, trades, wins,
      winRate: trades ? (wins / trades) * 100 : null,
      avgWin: wins ? grossWin / wins : null,
      avgLoss: losses ? grossLoss / losses : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      greenDays: days.filter((d) => d.pnl > 0).length,
      redDays: days.filter((d) => d.pnl < 0).length,
    };
  }, [data, year, month]);

  const shiftMonth = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
    setSelectedDate(null); // the open drill-down belongs to the month we left
  };

  // Picking a trade hands it to the chart and gets the modal out of the way.
  const openTrade = useCallback((trade: MatchedTrade) => {
    onOpenTradeOnChart(trade);
    onClose();
  }, [onOpenTradeOnChart, onClose]);

  // Colour intensity scales with the day's size relative to the month's best.
  const maxAbs = useMemo(() => {
    const vals = (data?.days ?? [])
      .filter((d) => d.date.startsWith(`${year}-${String(month + 1).padStart(2, '0')}`))
      .map((d) => Math.abs(d.pnl));
    return Math.max(1, ...vals);
  }, [data, year, month]);

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.window} onClick={(e) => e.stopPropagation()}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className={styles.header}>
          <div className={styles.nav}>
            <button className={styles.navBtn} onClick={() => shiftMonth(-1)} title="Previous month">‹</button>
            <span className={styles.monthLabel}>{MONTHS[month]} {year}</span>
            <button className={styles.navBtn} onClick={() => shiftMonth(1)} title="Next month">›</button>
            <button
              className={styles.todayBtn}
              onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}
            >
              Today
            </button>
          </div>
          <div className={styles.headerRight}>
            {data?.syncedAt && (
              <span className={styles.syncedAt}>
                synced {new Date(data.syncedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
            <button className={styles.syncBtn} onClick={sync} disabled={syncing || !data?.flexConfigured}>
              {syncing ? 'Syncing…' : 'Sync'}
            </button>
            <button className={styles.iconBtn} onClick={() => setShowSetup((v) => !v)} title="Flex settings">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <circle cx="7" cy="7" r="2.4" stroke="currentColor" strokeWidth="1.3"/>
                <path d="M7 1v1.6M7 11.4V13M13 7h-1.6M2.6 7H1M11.2 2.8l-1.1 1.1M3.9 10.1l-1.1 1.1M11.2 11.2l-1.1-1.1M3.9 3.9L2.8 2.8"
                  stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </button>
            <button className={styles.iconBtn} onClick={onClose} title="Close (Esc)">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        {/* ── Tabs ───────────────────────────────────────────────── */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'calendar' ? styles.tabActive : ''}`}
            onClick={() => setTab('calendar')}
          >
            Calendar
          </button>
          <button
            className={`${styles.tab} ${tab === 'stats' ? styles.tabActive : ''}`}
            onClick={() => setTab('stats')}
          >
            Stats
          </button>
        </div>

        {error && <div className={styles.errorBar}>⚠ {error}</div>}

        {/* ── Flex setup ─────────────────────────────────────────── */}
        {showSetup && (
          <div className={styles.setup}>
            <div className={styles.setupTitle}>Connect your IBKR trade history</div>
            <ol className={styles.setupSteps}>
              <li>IBKR Account Management → <b>Settings → Account Reporting → Flex Web Service</b>, and enable it to get a <b>token</b>.</li>
              <li>Under <b>Performance &amp; Reports → Flex Queries</b>, create an <b>Activity</b> query with the <b>Trades</b> section, including <i>Realized P&amp;L</i> and <i>Commission</i>. Note its <b>Query ID</b>.</li>
              <li>Paste both below. They're stored locally on this machine only.</li>
            </ol>
            <div className={styles.setupRow}>
              <input
                className={styles.setupInput}
                placeholder="Flex token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                spellCheck={false}
              />
              <input
                className={`${styles.setupInput} ${styles.setupInputSm}`}
                placeholder="Query ID"
                value={queryId}
                onChange={(e) => setQueryId(e.target.value)}
                spellCheck={false}
              />
              <button
                className={styles.saveBtn}
                onClick={saveFlex}
                disabled={!token.trim() || !queryId.trim() || syncing}
              >
                {syncing ? 'Checking…' : 'Save & sync'}
              </button>
            </div>
          </div>
        )}

        {tab === 'stats' && <TradeStats from={monthRange.from} to={monthRange.to} />}

        {tab === 'calendar' && <>
        {/* ── Month stats ────────────────────────────────────────── */}
        <div className={styles.stats}>
          <Stat label="Net P&L" value={money(stats.pnl)} tone={stats.pnl > 0 ? 'up' : stats.pnl < 0 ? 'down' : undefined} big />
          <Stat label="Win rate" value={stats.winRate != null ? `${stats.winRate.toFixed(1)}%` : '—'} />
          <Stat label="Trades" value={String(stats.trades)} />
          <Stat label="Avg win" value={stats.avgWin != null ? money(stats.avgWin) : '—'} tone="up" />
          <Stat label="Avg loss" value={stats.avgLoss != null ? money(stats.avgLoss) : '—'} tone="down" />
          <Stat label="Profit factor" value={stats.profitFactor != null ? stats.profitFactor.toFixed(2) : '—'} />
          <Stat label="Green / red days" value={`${stats.greenDays} / ${stats.redDays}`} />
        </div>

        {/* ── Calendar grid ──────────────────────────────────────── */}
        <div className={styles.grid}>
          {DOW.map((d) => <div key={d} className={styles.dowCell}>{d}</div>)}
          <div className={`${styles.dowCell} ${styles.weekCol}`}>Week</div>

          {weeks.map((row, ri) => {
            const rowDays = row
              .map((c) => (c.key ? byDate.get(c.key) : undefined))
              .filter((d): d is TradeDaySummary => !!d);
            const weekPnl = rowDays.reduce((a, d) => a + d.pnl, 0);
            const weekTrades = rowDays.reduce((a, d) => a + d.trades, 0);
            return (
              <div key={ri} className={styles.weekRow}>
                {row.map((c, ci) => {
                  if (c.day == null) return <div key={ci} className={styles.emptyCell} />;
                  const d = byDate.get(c.key!);
                  const isToday = c.key === dateKey(now.getFullYear(), now.getMonth(), now.getDate());
                  if (!d || d.trades === 0) {
                    return (
                      <div key={ci} className={`${styles.cell} ${isToday ? styles.today : ''}`}>
                        <span className={styles.dayNum}>{c.day}</span>
                      </div>
                    );
                  }
                  const up = d.pnl >= 0;
                  const intensity = Math.min(0.34, 0.08 + (Math.abs(d.pnl) / maxAbs) * 0.26);
                  const winRate = d.trades ? Math.round((d.wins / d.trades) * 100) : 0;
                  return (
                    <div
                      key={ci}
                      className={`${styles.cell} ${styles.cellActive} ${isToday ? styles.today : ''} ${
                        selectedDate === d.date ? styles.cellSelected : ''
                      }`}
                      onClick={() => setSelectedDate((cur) => (cur === d.date ? null : d.date))}
                      style={{
                        background: up
                          ? `rgba(8,153,129,${intensity})`
                          : `rgba(242,54,69,${intensity})`,
                        borderColor: up ? 'rgba(8,153,129,0.45)' : 'rgba(242,54,69,0.45)',
                      }}
                      title={`${d.date} · ${money(d.pnl)} · ${d.trades} trade${d.trades === 1 ? '' : 's'} · ${winRate}% win${
                        d.source === 'local' ? ' · live (not yet in the IBKR statement)' : ''
                      }`}
                    >
                      <span className={styles.dayNum}>{c.day}</span>
                      <span className={`${styles.cellPnl} ${up ? styles.up : styles.down}`}>{compact(d.pnl)}</span>
                      <span className={styles.cellMeta}>{d.trades}t · {winRate}%</span>
                    </div>
                  );
                })}
                <div className={`${styles.cell} ${styles.weekCell}`}>
                  {rowDays.length > 0 ? (
                    <>
                      <span className={`${styles.cellPnl} ${weekPnl >= 0 ? styles.up : styles.down}`}>{compact(weekPnl)}</span>
                      <span className={styles.cellMeta}>{weekTrades}t</span>
                    </>
                  ) : <span className={styles.cellMeta}>—</span>}
                </div>
              </div>
            );
          })}
        </div>

        {selectedDate && (
          <DayTrades
            date={selectedDate}
            onOpenChart={openTrade}
            onClose={() => setSelectedDate(null)}
          />
        )}

        {loading && <div className={styles.loading}>Loading…</div>}
        {!loading && !data?.flexConfigured && !showSetup && (
          <div className={styles.hint}>
            Only today's trades are shown until you connect Flex — click the ⚙ to set it up.
          </div>
        )}
        {!loading && data?.flexConfigured && !data.detailAvailable && (
          <div className={styles.hint}>
            Your Flex statement has no execution-level detail, so historical days show P&L
            only and can't be drilled into. Add <b>Quantity</b>, <b>Trade Price</b>,
            {' '}<b>Buy/Sell</b> and <b>Date/Time</b> to the Trades section of your Flex query,
            then hit Sync.
          </div>
        )}
        </>}
      </div>
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
