/**
 * QuoteStreamService
 *
 * Real-time last-price feed for watchlist symbols — one `reqMktData` line per
 * distinct symbol, ref-counted across every WS client/window, so five windows
 * watching SPY still cost a single market-data line.
 *
 * Deliberately price-only. Today's cumulative volume and RVOL keep coming from
 * the `/api/quotes` historical poll: IBKR's VOLUME tick is RTH-biased and the
 * RVOL average needs daily bars regardless, whereas price and % change are the
 * numbers that actually need to move between polls.
 *
 * Unlike historical requests this needs no pacing queue (reqMktData is a
 * streaming subscription, not a paced request), but market-data LINES are
 * finite — the gateway caps how many symbols one client may watch.
 */

import { EventName } from '@stoqey/ib';
import type { Logger } from 'pino';
import { IBKRService } from './ibkr.service.js';
import { MarketDataService } from './market-data.service.js';
import { config } from '../config.js';

export interface LiveQuote {
  symbol: string;
  last: number;
  prevClose: number | null;
}

type QuoteListener = (quote: LiveQuote) => void;

// Coalesce bursts of prints into at most one message per symbol per interval.
// Fast enough to read as live, slow enough that 30 symbols can't flood the WS.
const EMIT_THROTTLE_MS = 400;

// tickPrice fields we care about, plus their delayed-data equivalents (a live
// subscription falls back to delayed ticks when the account lacks real-time
// data for that listing).
const LAST_FIELDS = new Set([4, 68]);   // LAST, DELAYED_LAST
const CLOSE_FIELDS = new Set([9, 75]);  // CLOSE, DELAYED_CLOSE

interface Entry {
  reqId: number;
  symbol: string;
  refs: number;
  last: number | null;
  prevClose: number | null;
  lastEmit: number;
  timer: ReturnType<typeof setTimeout> | null;
  requested: boolean; // a reqMktData is live for this reqId
}

export class QuoteStreamService {
  private static instance: QuoteStreamService;

  private ibkr: IBKRService;
  private logger: Logger;
  private bySymbol = new Map<string, Entry>();
  private byReqId = new Map<number, Entry>();
  private listeners = new Set<QuoteListener>();
  private nextReqId = config.reqId.quoteBase;

  private constructor(ibkr: IBKRService, logger: Logger) {
    this.ibkr = ibkr;
    this.logger = logger.child({ service: 'QuoteStreamService' });

    this.ibkr.api.on(EventName.tickPrice, (reqId: number, field: number, price: number) => {
      const entry = this.byReqId.get(reqId);
      if (!entry || !(price > 0)) return;
      if (LAST_FIELDS.has(field)) {
        if (entry.last === price) return;
        entry.last = price;
      } else if (CLOSE_FIELDS.has(field)) {
        if (entry.prevClose === price) return;
        entry.prevClose = price;
      } else {
        return;
      }
      this.scheduleEmit(entry);
    });

    // Market-data lines die with the socket — re-issue them on reconnect.
    this.ibkr.on('status', (status: { connected: boolean }) => {
      for (const entry of this.bySymbol.values()) {
        if (!status.connected) entry.requested = false;
        else this.request(entry);
      }
    });
  }

  static getInstance(ibkr: IBKRService, logger: Logger): QuoteStreamService {
    if (!QuoteStreamService.instance) {
      QuoteStreamService.instance = new QuoteStreamService(ibkr, logger);
    }
    return QuoteStreamService.instance;
  }

  // ─── Ref-counted subscriptions ───────────────────────────────────────────────

  /** Take a reference on `symbol`'s live line, opening it if this is the first. */
  retain(symbol: string): void {
    const sym = symbol.toUpperCase();
    const existing = this.bySymbol.get(sym);
    if (existing) {
      existing.refs++;
      return;
    }
    const entry: Entry = {
      reqId: this.nextReqId++,
      symbol: sym,
      refs: 1,
      last: null,
      prevClose: null,
      lastEmit: 0,
      timer: null,
      requested: false,
    };
    this.bySymbol.set(sym, entry);
    this.byReqId.set(entry.reqId, entry);
    this.request(entry);
  }

  /** Drop a reference; the line closes when the last holder releases it. */
  release(symbol: string): void {
    const sym = symbol.toUpperCase();
    const entry = this.bySymbol.get(sym);
    if (!entry) return;
    if (--entry.refs > 0) return;

    this.bySymbol.delete(sym);
    this.byReqId.delete(entry.reqId);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.requested) {
      try {
        this.ibkr.api.cancelMktData(entry.reqId);
      } catch (err) {
        this.logger.warn({ symbol: sym, err: err instanceof Error ? err.message : String(err) }, 'cancelMktData failed');
      }
    }
  }

  /** Latest known values, so a client that starts watching mid-session doesn't
   * sit blank until the next print. */
  snapshot(symbol: string): LiveQuote | null {
    const entry = this.bySymbol.get(symbol.toUpperCase());
    if (!entry || entry.last == null) return null;
    return { symbol: entry.symbol, last: entry.last, prevClose: entry.prevClose };
  }

  onQuote(listener: QuoteListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ─── Internals ───────────────────────────────────────────────────────────────

  private request(entry: Entry): void {
    if (entry.requested || !this.ibkr.isConnected) return;
    try {
      // Watchlist quotes are always STK/SMART/USD (consolidated tape), matching
      // /api/quotes and the summary.
      const contract = MarketDataService.toIBContract(entry.symbol, 'STK', 'SMART', 'USD');
      this.ibkr.api.reqMktData(entry.reqId, contract, '', false, false, []);
      entry.requested = true;
      this.logger.debug({ symbol: entry.symbol, reqId: entry.reqId }, 'Quote line opened');
    } catch (err) {
      this.logger.warn({ symbol: entry.symbol, err: err instanceof Error ? err.message : String(err) }, 'reqMktData failed');
    }
  }

  private scheduleEmit(entry: Entry): void {
    if (entry.last == null) return; // a close without a last price isn't a quote yet
    const wait = EMIT_THROTTLE_MS - (Date.now() - entry.lastEmit);
    if (wait <= 0) { this.emit(entry); return; }
    if (entry.timer) return; // already coalescing
    entry.timer = setTimeout(() => { entry.timer = null; this.emit(entry); }, wait);
  }

  private emit(entry: Entry): void {
    if (entry.last == null) return;
    entry.lastEmit = Date.now();
    const quote: LiveQuote = { symbol: entry.symbol, last: entry.last, prevClose: entry.prevClose };
    for (const listener of this.listeners) {
      try { listener(quote); } catch { /* one bad client must not stop the rest */ }
    }
  }
}
