/**
 * quoteStore
 *
 * The watchlist's live state lives HERE, not inside WatchlistPanel — closing the
 * drawer unmounts the panel, and state that lived in the panel was thrown away
 * with it (every reopen started blank and waited a full poll for prices). The
 * store keeps running whether or not anything is looking at it, so reopening is
 * instant and the numbers are already current.
 *
 * Two sources, merged:
 *  - `GET /api/quotes` every REFRESH_MS — previous close, today's cumulative
 *    volume, RVOL. One serialized IBKR historical request PER SYMBOL, so this is
 *    the expensive half and stays slow.
 *  - The WS 'quote' stream (one reqMktData line per symbol, ref-counted
 *    backend-side) — the last price, live. Change and % are recomputed from it,
 *    so price/percent move in real time between polls.
 *
 * While no component is subscribed the store does no work beyond storing the
 * newest tick: recomputation is lazy (`dirty`) and notifications are skipped
 * when there are no listeners.
 */

import type { QuoteResult } from '@ibkr-chart/types';
import { loadWatchlist, saveWatchlist } from './watchlistStore';

// Slower than the old 30s: with the live stream carrying price, this poll only
// has to keep volume/RVOL/prevClose fresh — and each cycle is one historical
// request per symbol against IBKR's pacing limits.
const REFRESH_MS = 60_000;

// Coalesce live ticks into ~4 renders/sec regardless of how many symbols print.
const NOTIFY_MS = 250;

interface LiveQuote {
  last: number;
  prevClose: number | null;
}

let symbols: string[] = loadWatchlist();
let polled: Record<string, QuoteResult> = {};
let live: Record<string, LiveQuote> = {};
let merged: Record<string, QuoteResult> = {};
let dirty = true;
let loading = false;
let connected = false;
let started = false;

const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let inflight: AbortController | null = null;
let watchSender: ((symbols: string[]) => void) | null = null;

// ─── Merge ────────────────────────────────────────────────────────────────────

const isQuote = (q: QuoteResult | undefined): q is Extract<QuoteResult, { last: number }> =>
  !!q && 'last' in q;

function recompute(): void {
  const out: Record<string, QuoteResult> = {};
  for (const sym of symbols) {
    const base = polled[sym];
    const tick = live[sym];

    if (isQuote(base)) {
      if (!tick) { out[sym] = base; continue; }
      // The poll owns prevClose (derived from bars, and correct pre-market);
      // fall back to IBKR's CLOSE tick only if the poll hasn't landed one.
      const prevClose = base.prevClose || tick.prevClose || 0;
      const change = tick.last - prevClose;
      out[sym] = {
        ...base,
        last: tick.last,
        prevClose,
        change,
        changePct: prevClose ? (change / prevClose) * 100 : 0,
      };
    } else if (tick && tick.prevClose) {
      // Stream arrived first (new symbol, or the poll is still in flight) —
      // show price and % now; volume/RVOL fill in on the next poll.
      const change = tick.last - tick.prevClose;
      out[sym] = {
        symbol: sym,
        last: tick.last,
        prevClose: tick.prevClose,
        change,
        changePct: (change / tick.prevClose) * 100,
        volume: 0,
      };
    } else if (base) {
      out[sym] = base; // error entry (bad symbol, no data) — surface it as-is
    }
  }
  merged = out;
}

function markDirty(): void {
  dirty = true;
  if (notifyTimer || listeners.size === 0) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    for (const l of listeners) l();
  }, NOTIFY_MS);
}

// ─── Polling ──────────────────────────────────────────────────────────────────

async function poll(): Promise<void> {
  if (!symbols.length) {
    if (Object.keys(polled).length) { polled = {}; markDirty(); }
    return;
  }
  if (!connected) return;

  inflight?.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  loading = true;
  markDirty();

  try {
    const res = await fetch(`/api/quotes?symbols=${encodeURIComponent(symbols.join(','))}`, { signal: ctrl.signal });
    if (!res.ok) return;
    const body = (await res.json()) as { quotes?: QuoteResult[] };
    const map: Record<string, QuoteResult> = {};
    for (const q of body.quotes ?? []) map[q.symbol] = q;
    polled = map;
  } catch {
    /* transient / aborted — the next cycle retries */
  } finally {
    if (inflight === ctrl) { inflight = null; loading = false; }
    markDirty();
  }
}

function pushWatch(): void {
  watchSender?.(symbols);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Start the always-on refresh loop. Idempotent (StrictMode double-mounts). */
export function startQuoteStore(): void {
  if (started) return;
  started = true;
  pollTimer = setInterval(() => void poll(), REFRESH_MS);
  void poll();
}

export function stopQuoteStore(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  started = false;
}

/** Wire the WS 'watch' sender. Passing null detaches it (on unmount). */
export function setWatchSender(send: ((symbols: string[]) => void) | null): void {
  watchSender = send;
  pushWatch();
}

/** IBKR connection state — polling is pointless while it's down. */
export function setQuotesConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  if (value) { pushWatch(); void poll(); }
}

/** Apply a live price from the WS 'quote' stream. */
export function applyLiveQuote(q: { symbol: string; last: number; prevClose: number | null }): void {
  const cur = live[q.symbol];
  if (cur && cur.last === q.last && cur.prevClose === q.prevClose) return;
  live = { ...live, [q.symbol]: { last: q.last, prevClose: q.prevClose } };
  markDirty();
}

export function getWatchSymbols(): string[] {
  return symbols;
}

export function getQuotes(): Record<string, QuoteResult> {
  if (dirty) { recompute(); dirty = false; }
  return merged;
}

export function isQuotesLoading(): boolean {
  return loading;
}

export function addWatchSymbol(symbol: string): void {
  const s = symbol.trim().toUpperCase();
  if (!s || symbols.includes(s)) return;
  symbols = [...symbols, s];
  saveWatchlist(symbols);
  pushWatch();
  markDirty();
  void poll(); // don't make a just-added ticker wait a full cycle for its volume
}

export function removeWatchSymbol(symbol: string): void {
  if (!symbols.includes(symbol)) return;
  symbols = symbols.filter((x) => x !== symbol);
  saveWatchlist(symbols);
  const { [symbol]: _p, ...restPolled } = polled;
  const { [symbol]: _l, ...restLive } = live;
  polled = restPolled;
  live = restLive;
  pushWatch();
  markDirty();
}

export function refreshQuotes(): void {
  void poll();
}

export function subscribeQuotes(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
