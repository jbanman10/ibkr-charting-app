/**
 * Morning market summary endpoint.
 *
 * GET /api/summary → {
 *   quotes:   SPY/QQQ last price + change vs previous RTH close (via IBKR),
 *   calendar: today's US economic events / Fed speakers (ForexFactory free feed),
 *   news:     latest market headlines (CNBC Markets RSS),
 * }
 *
 * Each section fails independently — a dead news feed never blocks quotes.
 * Calendar and news are cached briefly so reopening the popup doesn't hammer
 * the external feeds; quotes are cached for one minute to respect IBKR pacing.
 */

import type { FastifyInstance } from 'fastify';
import { MarketDataService } from '../services/market-data.service.js';
import { IBKRService } from '../services/ibkr.service.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface SummaryQuote {
  symbol: string;
  last: number;
  prevClose: number;
  change: number;
  changePct: number;
}

export interface CalendarEvent {
  time: string | null;      // "8:30 AM" ET, null for all-day
  timestamp: number | null; // unix seconds
  title: string;
  impact: 'High' | 'Medium' | 'Low' | 'Holiday' | string;
  forecast: string;
  previous: string;
}

export interface NewsItem {
  title: string;
  link: string;
  publishedAt: string; // RFC date from the feed
}

// ─── ET time helpers ───────────────────────────────────────────────────────────

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
});
const ET_MIN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
});

const etDate = (unixSec: number) => ET_DATE.format(new Date(unixSec * 1000));
const etMinuteOfDay = (unixSec: number) => {
  const [h, m] = ET_MIN.format(new Date(unixSec * 1000)).split(':').map(Number);
  return h * 60 + m;
};

// ─── Simple TTL cache ──────────────────────────────────────────────────────────

interface CacheSlot<T> { at: number; value: T }
const cache = new Map<string, CacheSlot<unknown>>();

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const slot = cache.get(key) as CacheSlot<T> | undefined;
  if (slot && Date.now() - slot.at < ttlMs) return slot.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ─── Quotes (IBKR) ─────────────────────────────────────────────────────────────

const RTH_CLOSE_MIN = 16 * 60;

async function fetchQuote(marketData: MarketDataService, symbol: string): Promise<SummaryQuote> {
  // 2 days of 1-min extended-hours bars: the final bar is the latest print
  // (pre/post-market included); the previous session's ~16:00 bar is prevClose.
  const contract = MarketDataService.toIBContract(symbol, 'STK', 'SMART', 'USD');
  const bars = await marketData.fetchHistoricalBars(contract, '1m', 0);
  if (!bars.length) throw new Error(`no bars for ${symbol}`);

  const lastBar = bars[bars.length - 1];
  const last = lastBar.close;
  const lastDate = etDate(Number(lastBar.time));

  // Previous RTH close: last bar before 16:00 ET on the most recent session
  // strictly before the day of the latest print.
  let prevClose: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const t = Number(bars[i].time);
    if (etDate(t) < lastDate && etMinuteOfDay(t) < RTH_CLOSE_MIN) {
      prevClose = bars[i].close;
      break;
    }
  }
  if (prevClose == null) throw new Error(`no previous session found for ${symbol}`);

  const change = last - prevClose;
  return {
    symbol,
    last,
    prevClose,
    change,
    changePct: (change / prevClose) * 100,
  };
}

// ─── Economic calendar (ForexFactory weekly JSON, free, includes Fed speakers) ─

const FF_CALENDAR_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

interface FFEvent {
  title: string; country: string; date: string; impact: string;
  forecast: string; previous: string;
}

async function fetchCalendar(): Promise<CalendarEvent[]> {
  const res = await fetch(FF_CALENDAR_URL, { headers: { 'user-agent': 'ibkr-chart/1.0' } });
  if (!res.ok) throw new Error(`calendar feed ${res.status}`);
  const events = (await res.json()) as FFEvent[];

  const today = ET_DATE.format(new Date());
  return events
    .filter((e) => e.country === 'USD')
    .map((e) => {
      const ts = Math.floor(new Date(e.date).getTime() / 1000);
      return { e, ts };
    })
    .filter(({ ts }) => Number.isFinite(ts) && etDate(ts) === today)
    .sort((a, b) => a.ts - b.ts)
    .map(({ e, ts }) => {
      const allDay = e.impact === 'Holiday' || etMinuteOfDay(ts) === 0;
      return {
        time: allDay ? null : ET_TIME.format(new Date(ts * 1000)),
        timestamp: ts,
        title: e.title,
        impact: e.impact,
        forecast: e.forecast ?? '',
        previous: e.previous ?? '',
      };
    });
}

// ─── Market news (CNBC Markets RSS) ────────────────────────────────────────────

const NEWS_URL = 'https://www.cnbc.com/id/100003114/device/rss/rss.html';
const MAX_NEWS = 12;

const XML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
};

const decodeEntities = (s: string) =>
  s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[ent] ?? whole;
  });

const stripCdata = (s: string) =>
  decodeEntities(s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim());

async function fetchNews(): Promise<NewsItem[]> {
  const res = await fetch(NEWS_URL, { headers: { 'user-agent': 'ibkr-chart/1.0' } });
  if (!res.ok) throw new Error(`news feed ${res.status}`);
  const xml = await res.text();

  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag: string) =>
      stripCdata(block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '');
    const title = pick('title');
    const link = pick('link');
    if (!title || !link) continue;
    items.push({ title, link, publishedAt: pick('pubDate') });
    if (items.length >= MAX_NEWS) break;
  }
  return items;
}

// ─── Route ─────────────────────────────────────────────────────────────────────

const QUOTE_SYMBOLS = ['SPY', 'QQQ'];

export async function registerSummaryRoutes(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const marketData = MarketDataService.getInstance(ibkr, app.log as any);

  app.get('/api/summary', async () => {
    const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'failed');

    const quotesP = ibkr.isConnected
      ? cached('summary:quotes', 60_000, async () => {
          // Serialized internally by the hist request queue — no pacing risk.
          const out: (SummaryQuote | { symbol: string; error: string })[] = [];
          for (const sym of QUOTE_SYMBOLS) {
            try { out.push(await fetchQuote(marketData, sym)); }
            catch (e) { out.push({ symbol: sym, error: errMsg(e) }); }
          }
          return out;
        })
      : Promise.resolve(QUOTE_SYMBOLS.map((symbol) => ({ symbol, error: 'IBKR not connected' })));

    const [quotes, calendar, news] = await Promise.all([
      quotesP,
      cached('summary:calendar', 10 * 60_000, fetchCalendar).catch((e) => ({ error: errMsg(e) })),
      cached('summary:news', 5 * 60_000, fetchNews).catch((e) => ({ error: errMsg(e) })),
    ]);

    return { asOf: Date.now(), quotes, calendar, news };
  });
}
