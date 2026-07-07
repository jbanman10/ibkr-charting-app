/**
 * MarketDataService
 *
 * Provides:
 *  - fetchHistoricalBars(contract, timeframe) → Bar[]
 *  - subscribeRealTime(contract, timeframe, onBar, onTick) → unsubscribe fn
 *  - searchContracts(query) → ContractSearchResult[]
 *
 * Design notes:
 *  - Each call to subscribeRealTime gets a unique reqId from a monotonic counter.
 *  - IBKR streaming uses reqRealTimeBars (5-sec bars) which we aggregate into
 *    the requested timeframe, OR reqMktData for raw tick data.
 *  - We use 5-sec RT bars + aggregation because it is the most reliable approach
 *    across equities, futures, and forex — tick data requires extra permissions.
 */

import {
  EventName,
  Contract as IBContract,
  BarSizeSetting,
  WhatToShow,
  SecType as IBSecType,
} from '@stoqey/ib';
import type { Logger } from 'pino';
import type {
  Bar,
  Tick,
  Timeframe,
  ContractSearchResult,
  SecType,
} from '@ibkr-chart/types';
import { TIMEFRAMES } from '@ibkr-chart/types';
import { IBKRService } from './ibkr.service.js';
import { config } from '../config.js';

type OnBarCallback = (bar: Bar, isClosed: boolean) => void;
type OnTickCallback = (tick: Tick) => void;

// Spacing between consecutive historical requests, to stay under IBKR's
// pacing limits when several panels request data at once.
const HIST_SPACING_MS = 150;

interface ActiveStream {
  reqId: number;
  symbol: string;
  timeframe: Timeframe;
  contract: IBContract;
  useRTH: 0 | 1;
  onBar: OnBarCallback;
  onTick: OnTickCallback;
  aggregator: BarAggregator;
  // Wall-clock timer that rolls the forming bar / flat-fills quiet minutes even
  // when no 5-sec bar arrives (illiquid names). Cleared on unsubscribe.
  fillTimer?: ReturnType<typeof setInterval>;
  // Cached "is this bucket inside the stream's trading session" predicate.
  inSession: (sec: number) => boolean;
}

// Minimum gap between per-close correction fetches per symbol|timeframe. Small
// enough that a freshly-closed bar is verified within seconds, large enough to
// coalesce the burst when flat-fill closes several buckets at once and stay
// well under IBKR's ~60-per-10-min historical pacing budget (real closes are
// ≥60 s apart per symbol, so this never blocks a legit close).
const CORRECT_MIN_MS = 20_000;

// How many consecutive empty minutes we're willing to synthesize as flat
// continuation candles before giving up and letting the deep re-sync refill
// (guards against fabricating a huge run after sleep/backgrounding).
const MAX_FLAT_FILL = 20;

// Grace (seconds) before the wall-clock timer rolls a bucket, so a late 5-sec
// bar for the just-ended minute still lands in the right candle.
const ROLL_GRACE_SEC = 3;

/** Result of advancing/merging the aggregator: buckets that closed + the live bar. */
interface AggResult {
  closed: Bar[];
  forming: Bar | null; // non-null only when a new forming bar was opened
}

// ─── 5-sec bar → target-timeframe aggregator ────────────────────────────────

class BarAggregator {
  private currentBar: Bar | null = null;
  private readonly barSeconds: number;
  // Close of the most recently closed bar in this session. New buckets open at
  // this value so consecutive intraday candles connect like TWS/TradingView
  // (open == prev close). Reset to null across a session/overnight gap so we
  // never snap the first bar of a new session back to the prior session.
  private lastClose: number | null = null;
  // Continuity (open == prev close) applies to regular hours only; pre/post
  // market keep real first-trade opens so extended-hours gaps show like TV.
  private readonly isRTH: (sec: number) => boolean;

  constructor(timeframe: Timeframe, isRTH: (sec: number) => boolean) {
    this.barSeconds = TIMEFRAMES[timeframe].seconds;
    this.isRTH = isRTH;
  }

  /** Whether a new bucket at `barTime` should open at the prior close (RTH-only, consecutive). */
  private continuous(barTime: number): boolean {
    return this.lastClose != null
      && this.isRTH(barTime)
      && this.isRTH(barTime - this.barSeconds);
  }

  /**
   * Roll the forming bar forward to `nowSec` using the wall clock, WITHOUT any
   * new trade data. Closes the current bar if its window has elapsed and fills
   * each fully-elapsed empty bucket with a flat continuation candle
   * (open=high=low=close=prevClose, volume=0) — the way TWS/TradingView keep a
   * candle for every minute even with no trades. `inSession(bucketSec)` gates
   * fill to the stream's trading hours; large or boundary-crossing gaps reset
   * the aggregator so prime/reconcile reseed instead of fabricating a long run.
   */
  advanceTo(nowSec: number, inSession: (sec: number) => boolean): AggResult {
    if (!this.currentBar) return { closed: [], forming: null };
    const cur = this.currentBar;
    const nowBucket = Math.floor(nowSec / this.barSeconds) * this.barSeconds;
    if (nowBucket <= cur.time) return { closed: [], forming: null }; // still forming

    const closed: Bar[] = [{ ...cur }]; // the real bar's window has ended
    const prevClose = cur.close;

    const empties: number[] = [];
    for (let t = cur.time + this.barSeconds; t < nowBucket; t += this.barSeconds) empties.push(t);

    // Too far, or the gap leaves session (overnight/weekend/lunch-halt) → don't
    // invent candles; drop the forming bar and break continuity so the next
    // session's first bar keeps its real open.
    if (empties.length > MAX_FLAT_FILL || empties.some((t) => !inSession(t)) || !inSession(nowBucket)) {
      this.currentBar = null;
      this.lastClose = null;
      return { closed, forming: null };
    }

    for (const t of empties) {
      closed.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
    }
    this.lastClose = prevClose; // consecutive within session → next opens at prev close
    this.currentBar = { time: nowBucket, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 };
    return { closed, forming: { ...this.currentBar } };
  }

  /**
   * Merge a live 5-sec bar. First flushes any buckets that ended before this
   * bar (flat-filling quiet minutes), then folds the bar into the current
   * bucket. Returns the closed bars plus the (always present) forming bar.
   */
  push(
    fiveSecBar: { time: number; open: number; high: number; low: number; close: number; volume: number },
    inSession: (sec: number) => boolean
  ): AggResult {
    const barTime = Math.floor(fiveSecBar.time / this.barSeconds) * this.barSeconds;
    const { closed } = this.advanceTo(fiveSecBar.time, inSession);

    if (!this.currentBar || barTime > this.currentBar.time) {
      // Brand-new bucket (or reset by a large gap). During RTH open at the
      // previous bar's close (continuous); pre/post-market and session starts
      // keep the 5s bar's real open so the genuine gap shows.
      const open = this.continuous(barTime) ? this.lastClose! : fiveSecBar.open;
      this.currentBar = {
        time: barTime,
        open,
        high: Math.max(open, fiveSecBar.high),
        low: Math.min(open, fiveSecBar.low),
        close: fiveSecBar.close,
        volume: fiveSecBar.volume,
      };
    } else if (barTime === this.currentBar.time) {
      if (this.currentBar.volume === 0) {
        // Flat synthetic placeholder (open currently = prev close). Fold the
        // first real trade in: during RTH keep the continuous open; in pre/post
        // market take the real first-trade open so the gap shows.
        const open = this.continuous(barTime) ? this.currentBar.open : fiveSecBar.open;
        this.currentBar = {
          time: barTime,
          open,
          high: Math.max(open, fiveSecBar.high),
          low: Math.min(open, fiveSecBar.low),
          close: fiveSecBar.close,
          volume: fiveSecBar.volume,
        };
      } else {
        this.currentBar.high = Math.max(this.currentBar.high, fiveSecBar.high);
        this.currentBar.low = Math.min(this.currentBar.low, fiveSecBar.low);
        this.currentBar.close = fiveSecBar.close;
        this.currentBar.volume += fiveSecBar.volume;
      }
    }
    // barTime < currentBar.time → stale late 5s bar for an already-closed bucket;
    // ignore it (the value is already reflected in the closed bar / reconcile).

    return { closed, forming: { ...this.currentBar! } };
  }

  /** Bucket start time of the currently-forming bar, or null before the first push. */
  get currentTime(): number | null {
    return this.currentBar?.time ?? null;
  }

  /**
   * Seed/repair the current bucket with an authoritative snapshot (a historical
   * bar fetched at subscribe time). Fixes "mid-bucket subscription" where the
   * aggregator only ever saw the tail of the in-progress bar and thus rendered a
   * candle with the wrong open / a missing early wick. Returns the resulting
   * forming bar, or null if the prime is stale (older bucket than current).
   */
  prime(primeBar: Bar): Bar | null {
    const barTime = Math.floor(primeBar.time / this.barSeconds) * this.barSeconds;

    // No live bar yet, or the prime is for a newer bucket → adopt it wholesale.
    if (!this.currentBar || barTime > this.currentBar.time) {
      this.currentBar = { ...primeBar, time: barTime };
      return { ...this.currentBar };
    }

    // Prime is for an older bucket than the one already forming → we've rolled
    // over; the snapshot is stale, ignore it.
    if (barTime < this.currentBar.time) return null;

    // Same bucket: take the snapshot's open + full range, keep the latest close
    // from the live 5s bars we've already accumulated.
    this.currentBar = {
      time: barTime,
      open: primeBar.open,
      high: Math.max(this.currentBar.high, primeBar.high),
      low: Math.min(this.currentBar.low, primeBar.low),
      close: this.currentBar.close,
      volume: Math.max(this.currentBar.volume, primeBar.volume),
    };
    return { ...this.currentBar };
  }
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class MarketDataService {
  private static instance: MarketDataService;

  private ibkr: IBKRService;
  private logger: Logger;
  private activeStreams = new Map<number, ActiveStream>();
  private historicalReqId = config.reqId.historicalBase;
  // Serializes historical requests so a burst (one per chart panel) doesn't
  // trip IBKR pacing limits.
  private histChain: Promise<void> = Promise.resolve();
  private streamReqId = config.reqId.streamBase;
  private searchReqId = config.reqId.searchBase;

  private constructor(ibkr: IBKRService, logger: Logger) {
    this.ibkr = ibkr;
    this.logger = logger.child({ service: 'MarketDataService' });
    this.bindStreamEvents();
  }

  static getInstance(ibkr: IBKRService, logger: Logger): MarketDataService {
    if (!MarketDataService.instance) {
      MarketDataService.instance = new MarketDataService(ibkr, logger);
    }
    return MarketDataService.instance;
  }

  // ─── Historical data ────────────────────────────────────────────────────────

  fetchHistoricalBars(
    contract: IBContract,
    timeframe: Timeframe,
    useRTH: 0 | 1 = 1
  ): Promise<Bar[]> {
    // Daily/weekly candles are always the official RTH session (9:30–16:00 ET),
    // like TWS and every standard daily chart — extended hours only applies to
    // intraday timeframes.
    if (timeframe === '1d' || timeframe === '1w') useRTH = 1;
    // IBKR enforces pacing on historical-data requests. When several panels
    // request at once, TWS rejects all but one with a pacing/"competing
    // request" error. Serialize requests through a queue with a short spacing
    // gap so each goes out cleanly. The chain advances on both success and
    // failure so one bad request never stalls the rest.
    const tf = TIMEFRAMES[timeframe];
    const result = this.histChain.then(async () => {
      const bars = await this.runHistoricalRequest(contract, tf.barSize, tf.durationStr, useRTH);
      // IBKR's daily history ends at yesterday's close. Build today's daily candle
      // from today's intraday so it isn't a tiny live-only stub. Runs sequentially
      // in the same queue slot (respects pacing).
      if (timeframe === '1d') {
        const today = await this.aggregateTodayDaily(contract, useRTH).catch(() => null);
        if (today) {
          const lastT = bars.length ? Number(bars[bars.length - 1].time) : 0;
          if (lastT === today.time) {
            // IBKR sometimes returns today's daily bar as a partial stub — replace
            // it with the full intraday aggregate.
            bars[bars.length - 1] = today;
          } else if (lastT < today.time) {
            bars.push(today); // IBKR omitted today entirely
          }
        }
      } else if (useRTH === 0) {
        // Extended-hours TRADES bars include stale away-from-market prints
        // (overnight/OTC trades batch-reported when the tape opens at 4:00 ET),
        // which put fake $1+ wicks on the 4:00–4:15 candles and corrupt the
        // pre-market H/L levels. TWS filters these from its charts; the API
        // doesn't. Clamp each outside-RTH bar to that minute's NBBO range
        // (BID_ASK bars: high = max ask, low = min bid) to match TWS. Runs in
        // the same queue slot, so pacing is respected; a quotes failure never
        // blocks the bars themselves.
        try {
          const quotes = await this.runHistoricalRequest(
            contract, tf.barSize, tf.durationStr, 0, WhatToShow.BID_ASK
          );
          const fixed = MarketDataService.sanitizeExtendedBars(bars, quotes);
          if (fixed > 0) {
            this.logger.info(
              { symbol: contract.symbol, timeframe, fixed },
              'Clamped stale extended-hours prints to NBBO'
            );
          }
        } catch (err) {
          this.logger.warn(
            { symbol: contract.symbol, err: err instanceof Error ? err.message : err },
            'BID_ASK sanitize fetch failed; serving unfiltered bars'
          );
        }
      }
      // Intraday: fill short in-session gaps with flat continuation candles so the
      // chart is continuous like TWS/TradingView, and so the live flat-fill and
      // the 3-min deep re-sync agree (a full re-render won't flicker gaps back).
      // Then snap each bar's open to the prior consecutive bar's close so the
      // candles connect like TV (IBKR's raw first-trade opens otherwise leave a
      // bid/ask-bounce gap between every bar).
      if (timeframe !== '1d' && timeframe !== '1w') {
        const filled = MarketDataService.fillIntradayGaps(bars, useRTH, tf.seconds);
        return MarketDataService.makeContinuous(filled, tf.seconds);
      }
      return bars;
    });
    const advance = () => this.delay(HIST_SPACING_MS);
    this.histChain = result.then(advance, advance);
    return result;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Insert flat continuation candles (open=high=low=close=prevClose, volume=0)
   * for missing in-session minutes, matching how TWS/TradingView keep a candle
   * for every bar. Only short gaps are filled (≤ MAX_FLAT_FILL buckets, both
   * ends in session); overnight / halt / weekend gaps are left as-is. Assumes
   * ascending, bar-aligned times.
   */
  private static fillIntradayGaps(bars: Bar[], useRTH: 0 | 1, barSeconds: number): Bar[] {
    if (bars.length < 2) return bars;
    const inSession = MarketDataService.sessionPredicate(useRTH);
    const out: Bar[] = [];
    for (let i = 0; i < bars.length; i++) {
      out.push(bars[i]);
      if (i === bars.length - 1) break;
      const curT = Number(bars[i].time);
      const nextT = Number(bars[i + 1].time);
      const gap = (nextT - curT) / barSeconds;
      // Contiguous, irregular, or too large (lunch halt / overnight) → don't fill.
      if (!Number.isInteger(gap) || gap <= 1 || gap > MAX_FLAT_FILL + 1) continue;
      const prevClose = bars[i].close;
      for (let t = curT + barSeconds; t < nextT; t += barSeconds) {
        if (!inSession(t)) continue;
        out.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: 0 });
      }
    }
    return out;
  }

  /**
   * Make intraday candles continuous like TWS/TradingView: snap each bar's open
   * to the previous bar's close when the two are exactly one bucket apart (same
   * session — guaranteed contiguous by fillIntradayGaps), and expand high/low to
   * include the new open so no traded extreme is lost (a gapped bar just grows a
   * small wick down/up to the connection). Bars that aren't consecutive (across
   * the overnight/lunch/session boundary, or the first bar) keep their real open,
   * so session opens stay genuine and no wick is drawn across a real gap.
   * Mutates in place and returns the same array. high/low/close/volume unchanged.
   */
  private static makeContinuous(bars: Bar[], barSeconds: number): Bar[] {
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const b = bars[i];
      if (Number(b.time) !== Number(prev.time) + barSeconds) continue; // not consecutive
      // Regular hours only. Pre/post-market keep their real first-trade opens so
      // the genuine extended-hours gaps show, like TradingView; connecting them
      // would distort the pre-market candle structure and H/L read.
      if (!MarketDataService.isRTH(Number(b.time)) || !MarketDataService.isRTH(Number(prev.time))) continue;
      const open = prev.close;
      if (open === b.open) continue;
      b.open = open;
      if (open > b.high) b.high = open;
      if (open < b.low) b.low = open;
    }
    return bars;
  }

  /** True when the bar's ET minute-of-day is inside regular trading hours (09:30–16:00). */
  private static isRTH(unixSec: number): boolean {
    const m = MarketDataService.etMinuteOfDay(unixSec);
    return m >= 570 && m < 960;
  }

  /**
   * Clamp outside-RTH trade bars to their bar's NBBO range (from BID_ASK bars:
   * high = max ask, low = min bid). Extended-hours trades must execute inside
   * the consolidated quote, so anything beyond it (plus a small tolerance) is a
   * stale/late report — replace it with the nearest genuinely quoted price.
   * RTH bars are left untouched (auction crosses can print off the continuous
   * quote, and RTH prints are already NBBO-protected). Mutates in place;
   * returns how many bars were adjusted.
   */
  private static sanitizeExtendedBars(bars: Bar[], quotes: Bar[]): number {
    const quoteByTime = new Map<number, Bar>();
    for (const q of quotes) quoteByTime.set(Number(q.time), q);

    let fixed = 0;
    for (const b of bars) {
      const t = Number(b.time);
      const m = MarketDataService.etMinuteOfDay(t);
      if (m >= 570 && m < 960) continue; // RTH bar

      const q = quoteByTime.get(t);
      if (!q) continue;
      const maxAsk = q.high;
      const minBid = q.low;
      if (!(minBid > 0) || !(maxAsk >= minBid)) continue; // unusable quote bar

      // Tolerance: a few cents / 5 bps so borderline prints aren't mangled.
      const eps = Math.max(0.05, ((maxAsk + minBid) / 2) * 0.0005);
      const lo = minBid - eps;
      const hi = maxAsk + eps;
      const clamp = (v: number) => (v < lo ? minBid : v > hi ? maxAsk : v);

      const open = clamp(b.open);
      const close = clamp(b.close);
      const high = clamp(b.high);
      const low = clamp(b.low);
      if (open === b.open && close === b.close && high === b.high && low === b.low) continue;

      b.open = open;
      b.close = close;
      b.high = Math.max(open, close, high);
      b.low = Math.min(open, close, low);
      fixed++;
    }
    return fixed;
  }

  private static readonly ET_HM = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });

  /** ET minute-of-day (0–1439) for a UTC epoch-seconds timestamp. */
  private static etMinuteOfDay(unixSec: number): number {
    const [h, m] = MarketDataService.ET_HM.format(unixSec * 1000).split(':').map(Number);
    return h * 60 + m;
  }

  /** Aggregate today's (ET) intraday bars into a single daily OHLCV bar, or null. */
  private async aggregateTodayDaily(contract: IBContract, useRTH: 0 | 1): Promise<Bar | null> {
    const intraday = await this.runHistoricalRequest(contract, '30 mins', '1 D', useRTH);
    if (!intraday.length) return null;

    // ET date of "now" — the trading day we're building.
    const etParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const p: Record<string, string> = {};
    for (const part of etParts) if (part.type !== 'literal') p[part.type] = part.value;
    const todayKey = `${p.year}-${p.month}-${p.day}`;
    const etKey = (sec: number) => new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(sec * 1000).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');

    const todays = intraday.filter((b) => etKey(Number(b.time)) === todayKey);
    if (!todays.length) return null;

    const time = Math.floor(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 1000);
    return {
      time,
      open: todays[0].open,
      high: Math.max(...todays.map((b) => b.high)),
      low: Math.min(...todays.map((b) => b.low)),
      close: todays[todays.length - 1].close,
      volume: todays.reduce((s, b) => s + (b.volume ?? 0), 0),
    };
  }

  private runHistoricalRequest(
    contract: IBContract,
    barSize: string,
    durationStr: string,
    useRTH: 0 | 1,
    whatToShow: WhatToShow = WhatToShow.TRADES
  ): Promise<Bar[]> {
    return new Promise((resolve, reject) => {
      if (!this.ibkr.isConnected) {
        return reject(new Error('IBKR not connected'));
      }

      const reqId = this.historicalReqId++;
      const bars: Bar[] = [];
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        this.ibkr.api.off(EventName.historicalData, onHistoricalData);
        this.ibkr.api.off(EventName.error, onError);
      };

      const onHistoricalData = (
        id: number,
        date: string,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number
      ) => {
        if (id !== reqId) return;
        if (date.startsWith('finished')) {
          if (settled) return;
          settled = true;
          cleanup();
          this.logger.info(
            { reqId, symbol: contract.symbol, count: bars.length, sample: bars[0] },
            'Historical bars received'
          );
          resolve(bars);
          return;
        }
        const time = this.parseIBKRDate(date);
        if (!time) {
          this.logger.warn({ date, open }, 'Failed to parse date');
        }
        if (time && open > 0) {
          bars.push({ time, open, high, low, close, volume: volume ?? 0 });
        }
      };

      // IBKR reports request failures (pacing, no security definition, etc.)
      // via the error event, tagged with this reqId. Without this listener a
      // rejected request would hang until the 30s timeout and the chart would
      // stay blank — the root cause of "only 1 of N charts populates".
      const onError = (err: Error, code: number, id: number) => {
        if (id !== reqId || settled) return;
        settled = true;
        cleanup();
        this.logger.warn(
          { reqId, code, symbol: contract.symbol, message: err.message },
          'Historical request failed'
        );
        reject(new Error(`IBKR error ${code}: ${err.message}`));
      };

      // Timeout guard — IBKR sometimes silently fails historical requests
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        if (bars.length > 0) {
          resolve(bars); // Partial data is better than nothing
        } else {
          reject(new Error('Historical data request timed out'));
        }
      }, 30_000);

      this.ibkr.api.on(EventName.historicalData, onHistoricalData);
      this.ibkr.api.on(EventName.error, onError);

      this.logger.info({ reqId, symbol: contract.symbol, barSize, durationStr, useRTH }, 'Requesting historical bars');

      this.ibkr.api.reqHistoricalData(
        reqId,
        contract,
        '',                    // endDateTime: '' = now
        durationStr,
        barSize as BarSizeSetting,
        whatToShow,
        useRTH,                // 0 = include extended hours, 1 = RTH only
        2,                     // formatDate: 2 = UTC epoch seconds (avoids exchange-tz skew;
                               //   matches the live tick time-base which uses Date.now() UTC)
        false,                 // keepUpToDate
        []
      );
    });
  }

  // ─── Real-time streaming ────────────────────────────────────────────────────

  subscribeRealTime(
    contract: IBContract,
    timeframe: Timeframe,
    onBar: OnBarCallback,
    onTick: OnTickCallback,
    useRTH: 0 | 1 = 1
  ): () => void {
    if (!this.ibkr.isConnected) throw new Error('IBKR not connected');

    // Daily/weekly candles are RTH-only (matches the historical fetch above),
    // so live 5s bars must not extend today's candle with pre/post-market range.
    if (timeframe === '1d' || timeframe === '1w') useRTH = 1;

    const reqId = this.streamReqId++;

    const stream: ActiveStream = {
      reqId,
      symbol: contract.symbol ?? '',
      timeframe,
      contract,
      useRTH,
      onBar,
      onTick,
      aggregator: new BarAggregator(timeframe, MarketDataService.sessionPredicate(1)),
      inSession: MarketDataService.sessionPredicate(useRTH),
    };
    this.activeStreams.set(reqId, stream);

    // Wall-clock roll: every second, advance the forming bar so quiet minutes get
    // flat continuation candles and the next candle opens on time even if no 5s
    // bar arrives. Skipped for daily/weekly (they roll once/day; harmless but
    // pointless). A small grace lets late 5s bars land in the right bucket.
    if (timeframe !== '1d' && timeframe !== '1w') {
      stream.fillTimer = setInterval(() => this.tickFill(reqId), 1_000);
    }

    this.logger.info(
      { reqId, symbol: contract.symbol, timeframe, useRTH },
      'Subscribing to real-time bars'
    );

    // reqRealTimeBars gives 5-second bars — most reliable for all asset types.
    // useRTH must match the historical fetch, else live bars would only cover RTH
    // while history includes extended hours (a gap at session boundaries).
    this.ibkr.api.reqRealTimeBars(
      reqId,
      contract,
      5,                   // barSize (always 5 for RT bars)
      WhatToShow.TRADES,
      useRTH === 1
    );

    // Also subscribe to market data for tick-level bid/ask
    this.ibkr.api.reqMktData(reqId + 10000, contract, '', false, false, []);

    // Prime the currently-forming bar from an authoritative snapshot so a
    // mid-bucket subscription renders a complete candle immediately instead of a
    // thin/gapped one that only a page refresh would fix.
    this.primeStream(reqId, contract, timeframe, useRTH);

    return () => this.unsubscribe(reqId);
  }

  /** Predicate: is a bucket's start time inside this stream's trading session? */
  private static sessionPredicate(useRTH: 0 | 1): (sec: number) => boolean {
    // ET minute-of-day windows: RTH 09:30–16:00, extended 04:00–20:00.
    const [lo, hi] = useRTH === 1 ? [570, 960] : [240, 1200];
    return (sec: number) => {
      const m = MarketDataService.etMinuteOfDay(sec);
      return m >= lo && m < hi;
    };
  }

  /**
   * Wall-clock tick (once/sec per stream): roll the forming bar forward with no
   * new trades, emitting flat continuation candles for quiet minutes. Emits any
   * closed bars + the freshly opened forming bar, and triggers a fast correction
   * so the just-closed bar is verified against official history within seconds.
   */
  private tickFill(reqId: number): void {
    const stream = this.activeStreams.get(reqId);
    if (!stream) return;
    // Subtract the grace so we don't roll a bucket the instant it ends — a late
    // 5s bar for the last few seconds of the minute must still land in it.
    const nowSec = Date.now() / 1000 - ROLL_GRACE_SEC;
    const { closed, forming } = stream.aggregator.advanceTo(nowSec, stream.inSession);
    if (!closed.length && !forming) return;
    for (const b of closed) stream.onBar(b, true);
    if (forming) stream.onBar(forming, false);
    if (closed.length) this.reconcileStream(stream);
  }

  /**
   * Fetch the current forming bar once (via the pacing-aware historical queue)
   * and seed the stream's aggregator with it, then push it to the client. Runs
   * async; guards against the stream being torn down before it resolves.
   */
  private primeStream(
    reqId: number,
    contract: IBContract,
    timeframe: Timeframe,
    useRTH: 0 | 1
  ): void {
    const run = async () => {
      if (!this.activeStreams.has(reqId)) return;
      try {
        let primeBar: Bar | null;
        if (timeframe === '1d') {
          // Reuse the full-day intraday aggregate so the daily forming bar has the
          // whole session's range.
          primeBar = await this.aggregateTodayDaily(contract, useRTH);
        } else {
          const tf = TIMEFRAMES[timeframe];
          const bars = await this.runHistoricalRequest(contract, tf.barSize, tf.durationStr, useRTH);
          primeBar = bars.length ? bars[bars.length - 1] : null;
        }

        const stream = this.activeStreams.get(reqId);
        if (!stream || !primeBar) return;

        const seeded = stream.aggregator.prime(primeBar);
        if (seeded) {
          stream.onBar(seeded, false);
          this.logger.info(
            { reqId, symbol: contract.symbol, time: seeded.time },
            'Primed forming bar'
          );
        }
      } catch (err) {
        this.logger.warn(
          { reqId, err: err instanceof Error ? err.message : String(err) },
          'Stream prime failed'
        );
      }
    };

    // Queue behind any pending historical work so we respect IBKR pacing.
    const advance = () => this.delay(HIST_SPACING_MS);
    this.histChain = this.histChain.then(run, run).then(advance, advance);
  }

  // Tracks the last correction per symbol|timeframe so several panels on the
  // same chart don't multiply the request volume.
  private lastReconcile = new Map<string, number>();

  /**
   * Re-fetch the last couple of OFFICIAL bars for a stream and re-emit them as
   * closed bars. The live 5s aggregate can permanently miss prints that only
   * appear in IBKR's historical data (odd lots, late reports) — the reason
   * candles differed from TWS until a manual refresh. Triggered on every bucket
   * close so a freshly-closed bar settles to the official value within seconds;
   * a short per-key floor coalesces bursts and respects IBKR pacing.
   */
  private reconcileStream(stream: ActiveStream): void {
    const { timeframe, contract, useRTH, reqId } = stream;
    if (timeframe === '1d' || timeframe === '1w') return; // intraday only

    const key = `${stream.symbol}|${timeframe}`;
    const now = Date.now();
    if (now - (this.lastReconcile.get(key) ?? 0) < CORRECT_MIN_MS) return;
    this.lastReconcile.set(key, now);

    const run = async () => {
      if (!this.activeStreams.has(reqId)) return;
      try {
        const tf = TIMEFRAMES[timeframe];
        // A few bars: enough to catch the freshly-closed one plus a lead-in bar
        // used only as the continuity anchor (see below), without a heavy fetch.
        const durSec = Math.min(Math.max(tf.seconds * 4, 240), 86400);
        const raw = await this.runHistoricalRequest(contract, tf.barSize, `${Math.ceil(durSec)} S`, useRTH);
        // Match the historical path so corrections don't re-introduce the gaps:
        // flat-fill quiet minutes, then snap opens to the prior close.
        const filled = MarketDataService.fillIntradayGaps(raw, useRTH, tf.seconds);
        const bars = MarketDataService.makeContinuous(filled, tf.seconds);

        const live = this.activeStreams.get(reqId);
        if (!live || !bars.length) return;

        // Correct every returned bar EXCEPT the one still forming — that bucket
        // is owned by the live aggregator (and tick painting on the client) — and
        // EXCEPT the first bar, which has no predecessor in this window so its open
        // couldn't be made continuous (it's only the anchor for bars[1]).
        const formingTime = live.aggregator.currentTime;
        let corrected = 0;
        for (let i = 1; i < bars.length; i++) {
          const b = bars[i];
          if (formingTime != null && Number(b.time) >= formingTime) continue;
          live.onBar(b, true);
          corrected++;
        }
        this.logger.debug({ reqId, symbol: stream.symbol, timeframe, corrected }, 'Corrected recent bars');
      } catch (err) {
        this.logger.warn(
          { reqId, err: err instanceof Error ? err.message : String(err) },
          'Bar reconcile failed'
        );
      }
    };

    const advance = () => this.delay(HIST_SPACING_MS);
    this.histChain = this.histChain.then(run, run).then(advance, advance);
  }

  private unsubscribe(reqId: number): void {
    const stream = this.activeStreams.get(reqId);
    if (!stream) return;
    if (stream.fillTimer) clearInterval(stream.fillTimer);
    this.activeStreams.delete(reqId);
    try {
      this.ibkr.api.cancelRealTimeBars(reqId);
      this.ibkr.api.cancelMktData(reqId + 10000);
      this.logger.info({ reqId }, 'Unsubscribed from real-time bars');
    } catch (err) {
      this.logger.warn({ err, reqId }, 'Error during unsubscribe');
    }
  }

  // ─── Symbol search ──────────────────────────────────────────────────────────

  searchContracts(query: string): Promise<ContractSearchResult[]> {
    return new Promise((resolve, reject) => {
      if (!this.ibkr.isConnected) return reject(new Error('IBKR not connected'));

      const reqId = this.searchReqId++;
      const results: ContractSearchResult[] = [];

      const onSymbolSamples = (
        id: number,
        contractDescriptions: Array<{
          contract: { conId: number; symbol: string; secType: string; primaryExch: string; currency: string };
          derivativeSecTypes: string[];
        }>
      ) => {
        if (id !== reqId) return;
        this.ibkr.api.off(EventName.symbolSamples, onSymbolSamples);

        for (const desc of contractDescriptions) {
          results.push({
            conId: desc.contract.conId,
            symbol: desc.contract.symbol,
            secType: desc.contract.secType as SecType,
            exchange: desc.contract.primaryExch || 'SMART',
            currency: desc.contract.currency,
            description: `${desc.contract.symbol} — ${desc.contract.secType}`,
          });
        }
        resolve(results);
      };

      this.ibkr.api.on(EventName.symbolSamples, onSymbolSamples);

      setTimeout(() => {
        this.ibkr.api.off(EventName.symbolSamples, onSymbolSamples);
        resolve(results); // Return whatever we have
      }, 5_000);

      this.ibkr.api.reqMatchingSymbols(reqId, query);
    });
  }

  // ─── Event binding (5-sec bars → aggregator → callbacks) ───────────────────

  private bindStreamEvents(): void {
    this.ibkr.api.on(
      EventName.realtimeBar,
      (
        reqId: number,
        time: number,
        open: number,
        high: number,
        low: number,
        close: number,
        volume: number,
        _wap: number,
        _count: number
      ) => {
        const stream = this.activeStreams.get(reqId);
        if (!stream) return;

        // Merge the 5s bar; this flat-fills any quiet minutes since the last bar,
        // emits their closes, then the (always-present) forming bar.
        const { closed, forming } = stream.aggregator.push(
          { time, open, high, low, close, volume },
          stream.inSession
        );
        for (const b of closed) stream.onBar(b, true);
        if (forming) stream.onBar(forming, false);
        // A bucket just closed. RT bars can miss prints that official history
        // includes (late reports, odd lots), so verify the just-closed bar
        // against history right away (throttled per symbol|timeframe).
        if (closed.length) this.reconcileStream(stream);
      }
    );

    // Tick price events for bid/ask/last
    this.ibkr.api.on(
      EventName.tickPrice,
      (reqId: number, tickType: number, price: number) => {
        const baseReqId = reqId - 10000;
        const stream = this.activeStreams.get(baseReqId);
        if (!stream || price <= 0) return;

        // tickType: 1=bid, 2=ask, 4=last, 6=high, 7=low, 9=close
        const tick: Partial<Tick> & { symbol: string; timestamp: number } = {
          symbol: stream.symbol,
          timestamp: Date.now(),
          bid: 0,
          ask: 0,
          last: 0,
          volume: 0,
        };

        if (tickType === 1) tick.bid = price;
        else if (tickType === 2) tick.ask = price;
        else if (tickType === 4) tick.last = price;
        else return;

        stream.onTick(tick as Tick);
      }
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseIBKRDate(date: string): number | null {
    // Format 1: Unix timestamp (10 digits) e.g. "1705312200"
    if (/^\d{10}$/.test(date)) {
      return parseInt(date, 10);
    }

    // Format 2: Daily bars — "20240115" (date only, no time)
    // Return numeric unix seconds (UTC midnight) so daily bars share the SAME
    // time representation as intraday + real-time streaming bars. Emitting daily
    // as a string while streaming emits a number caused the frontend's
    // `findIndex(b.time === bar.time)` to never match, pushing duplicate bars
    // and crashing lightweight-charts ("data must be asc ordered by time").
    // The frontend's toChartTime() converts this number to "YYYY-MM-DD".
    const dateOnly = date.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateOnly) {
      const [, y, mo, d] = dateOnly;
      return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 1000);
    }

    // Format 3: Intraday bars — "20240115 09:30:00" or "20240115 09:30:00 US/Eastern"
    const withTime = date.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (withTime) {
      const [, y, mo, d, h, mi, s] = withTime;
      return Math.floor(new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).getTime() / 1000);
    }

    this.logger.warn({ date }, 'Could not parse IBKR date format');
    return null;
  }

  /** Build an IBContract from our simplified Contract type */
  static toIBContract(
    symbol: string,
    secType: SecType,
    exchange: string,
    currency: string
  ): IBContract {
    return {
      symbol,
      secType: secType as IBSecType,
      exchange,
      currency,
    };
  }
}
