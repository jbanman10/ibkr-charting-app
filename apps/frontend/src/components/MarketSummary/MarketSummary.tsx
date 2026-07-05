/**
 * MarketSummary — "morning briefing" popup.
 *
 * Opened from the app toolbar. Fetches GET /api/summary and shows, vertically:
 *   1. SPY / QQQ last price + change vs previous close (IBKR data)
 *   2. Today's US economic calendar (reports + Fed speakers, ET times)
 *   3. Latest market headlines
 *
 * Closes on ✕, backdrop click, or Escape.
 */

import { useEffect, useState, useCallback } from 'react';
import styles from './MarketSummary.module.css';

interface Quote {
  symbol: string;
  last?: number;
  prevClose?: number;
  change?: number;
  changePct?: number;
  error?: string;
}

interface CalendarEvent {
  time: string | null;
  timestamp: number | null;
  title: string;
  impact: string;
  forecast: string;
  previous: string;
}

interface NewsItem {
  title: string;
  link: string;
  publishedAt: string;
}

interface SummaryData {
  asOf: number;
  quotes: Quote[];
  calendar: CalendarEvent[] | { error: string };
  news: NewsItem[] | { error: string };
}

const IMPACT_CLASS: Record<string, string> = {
  High: styles.impactHigh,
  Medium: styles.impactMedium,
  Low: styles.impactLow,
};

const fmtPrice = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function newsAge(pubDate: string): string {
  const t = new Date(pubDate).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export default function MarketSummary({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SummaryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch('/api/summary')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d: SummaryData) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/New_York',
  });

  const calendar = data && Array.isArray(data.calendar) ? data.calendar : null;
  const calendarErr = data && !Array.isArray(data.calendar) ? data.calendar.error : null;
  const news = data && Array.isArray(data.news) ? data.news : null;
  const newsErr = data && !Array.isArray(data.news) ? data.news.error : null;

  return (
    <div className={styles.backdrop} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.card} role="dialog" aria-label="Morning market summary">

        {/* ── Header ── */}
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Morning Summary</div>
            <div className={styles.date}>{today} · ET</div>
          </div>
          <div className={styles.headerBtns}>
            <button className={styles.iconBtn} onClick={load} title="Refresh" disabled={loading}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M2 7a5 5 0 1 0 1-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
                <path d="M2 3v4h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button className={styles.iconBtn} onClick={onClose} title="Close">
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
          </div>
        </div>

        <div className={styles.body}>
          {loading && !data && <div className={styles.loading}>Loading…</div>}
          {error && <div className={styles.error}>Couldn't load summary: {error}</div>}

          {data && (
            <>
              {/* ── Index ETFs ── */}
              <div className={styles.quotes}>
                {data.quotes.map((q) => (
                  <div key={q.symbol} className={styles.quoteCard}>
                    <div className={styles.quoteSymbol}>{q.symbol}</div>
                    {q.error != null || q.last == null ? (
                      <div className={styles.quoteError}>{q.error ?? 'unavailable'}</div>
                    ) : (
                      <>
                        <div className={styles.quotePrice}>{fmtPrice(q.last)}</div>
                        <div className={(q.change ?? 0) >= 0 ? styles.chgUp : styles.chgDown}>
                          {(q.change ?? 0) >= 0 ? '+' : ''}{fmtPrice(q.change ?? 0)}
                          {' '}({(q.change ?? 0) >= 0 ? '+' : ''}{(q.changePct ?? 0).toFixed(2)}%)
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>

              {/* ── Economic calendar ── */}
              <div className={styles.section}>
                <div className={styles.sectionTitle}>Economic Calendar</div>
                {calendarErr && <div className={styles.sectionError}>Unavailable ({calendarErr})</div>}
                {calendar && calendar.length === 0 && (
                  <div className={styles.empty}>No US events scheduled today.</div>
                )}
                {calendar && calendar.map((ev, i) => (
                  <div key={i} className={styles.calRow}>
                    <span className={styles.calTime}>{ev.time ?? 'All day'}</span>
                    <span className={`${styles.impactDot} ${IMPACT_CLASS[ev.impact] ?? styles.impactLow}`}
                      title={`${ev.impact} impact`} />
                    <span className={styles.calTitle}>{ev.title}</span>
                    {(ev.forecast || ev.previous) && (
                      <span className={styles.calNums}>
                        {ev.forecast && <>F {ev.forecast}</>}
                        {ev.forecast && ev.previous && ' · '}
                        {ev.previous && <>P {ev.previous}</>}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* ── News ── */}
              <div className={styles.section}>
                <div className={styles.sectionTitle}>Market News</div>
                {newsErr && <div className={styles.sectionError}>Unavailable ({newsErr})</div>}
                {news && news.length === 0 && <div className={styles.empty}>No headlines.</div>}
                {news && news.map((n, i) => (
                  <a key={i} className={styles.newsRow} href={n.link} target="_blank" rel="noreferrer">
                    <span className={styles.newsTitle}>{n.title}</span>
                    <span className={styles.newsAge}>{newsAge(n.publishedAt)}</span>
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
