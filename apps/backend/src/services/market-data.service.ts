/**
 * MarketDataService
 *
 * Drives charts from IBKR's native `keepUpToDate` historical feed — the exact
 * data a TWS chart uses. One `reqHistoricalData(keepUpToDate=true)` per
 * subscription returns the initial history (snapshot) and then streams
 * `historicalDataUpdate` events that are "a composite of historical and real
 * time data equivalent to TWS chart functionality". Candles therefore match TWS
 * by construction — no 5-sec aggregation, flat-fill, reconcile, or resync.
 *
 * Provides:
 *  - subscribeRealTime(contract, timeframe, onSnapshot, onBar, useRTH) → unsubscribe
 *  - fetchHistoricalBars(contract, timeframe, useRTH) → Bar[]   (morning-summary quotes)
 *  - searchContracts(query) → ContractSearchResult[]
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
type OnSnapshotCallback = (bars: Bar[]) => void;
type OnTickCallback = (tick: Tick) => void;

// Spacing between consecutive historical requests, to stay under IBKR's pacing
// limits when several panels subscribe at once.
const HIST_SPACING_MS = 150;

// Offset added to a stream's reqId for its reqMktData (tick) channel, kept well
// clear of the historical/stream/search reqId ranges.
const TICK_REQID_OFFSET = 1_000_000;

// Min gap between on-rollover corrections per symbol|timeframe (coalesces bursts;
// real closes are ≥ one bar apart so this never blocks a legit rollover).
const CORRECT_MIN_MS = 15_000;

interface ActiveStream {
  reqId: number;
  symbol: string;
  timeframe: Timeframe;
  contract: IBContract;
  useRTH: 0 | 1;
  onSnapshot: OnSnapshotCallback;
  onBar: OnBarCallback;
  onTick: OnTickCallback;
  // Initial keepUpToDate batch accumulates here until the 'finished' marker.
  snapshotBars: Bar[];
  snapshotFinalizing: boolean; // 'finished' seen; clamp in flight, snapshot not yet sent
  snapshotDone: boolean;       // snapshot delivered; live updates may now flow
  // Most recent bar seen from the live update stream — used to detect a rollover
  // (time advances → previous bar is final) and to finalize it.
  lastBar: Bar | null;
}

// ─── Service ─────────────────────────────────────────────────────────────────

export class MarketDataService {
  private static instance: MarketDataService;

  private ibkr: IBKRService;
  private logger: Logger;
  private activeStreams = new Map<number, ActiveStream>();
  private historicalReqId = config.reqId.historicalBase;
  // Serializes historical requests so a burst (one per chart panel) doesn't trip
  // IBKR pacing limits.
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

  // ─── One-shot historical (morning-summary quotes; not the chart) ─────────────

  fetchHistoricalBars(
    contract: IBContract,
    timeframe: Timeframe,
    useRTH: 0 | 1 = 1
  ): Promise<Bar[]> {
    if (timeframe === '1d' || timeframe === '1w') useRTH = 1;
    const tf = TIMEFRAMES[timeframe];
    const result = this.histChain.then(async () => {
      const bars = await this.runHistoricalRequest(contract, tf.barSize, tf.durationStr, useRTH);
      // Extended-hours intraday: clamp stale away-from-market prints to the NBBO
      // (see sanitizeExtendedBars) so quote-derived values match TWS.
      if (timeframe !== '1d' && timeframe !== '1w' && useRTH === 0) {
        try {
          const quotes = await this.runHistoricalRequest(contract, tf.barSize, tf.durationStr, 0, WhatToShow.BID_ASK);
          MarketDataService.sanitizeExtendedBars(bars, quotes);
        } catch { /* serve unfiltered on quote-fetch failure */ }
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
   * Clamp outside-RTH trade bars to their bar's NBBO range (from BID_ASK bars:
   * high = max ask, low = min bid). Extended-hours trades must execute inside the
   * consolidated quote, so anything beyond it (plus a small tolerance) is a
   * stale/late report — replace it with the nearest genuinely quoted price. RTH
   * bars are left untouched. Mutates in place; returns how many bars changed.
   */
  private static sanitizeExtendedBars(bars: Bar[], quotes: Bar[]): number {
    const quoteByTime = new Map<number, Bar>();
    for (const q of quotes) quoteByTime.set(Number(q.time), q);

    let fixed = 0;
    for (const b of bars) {
      const m = MarketDataService.etMinuteOfDay(Number(b.time));
      if (m >= 570 && m < 960) continue; // RTH bar

      const q = quoteByTime.get(Number(b.time));
      if (!q) continue;
      const maxAsk = q.high;
      const minBid = q.low;
      if (!(minBid > 0) || !(maxAsk >= minBid)) continue; // unusable quote bar

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

  /** True when the timestamp's ET minute-of-day is inside regular hours (09:30–16:00). */
  private static isRTH(unixSec: number): boolean {
    const m = MarketDataService.etMinuteOfDay(unixSec);
    return m >= 570 && m < 960;
  }

  // Last on-rollover correction per symbol|timeframe (throttle).
  private lastCorrect = new Map<string, number>();

  /**
   * On a regular-hours rollover, re-fetch the last few OFFICIAL bars and re-emit
   * the closed ones so the just-finished candle snaps to its authoritative value
   * right as the new candle opens (TWS-style), instead of drifting until the
   * frontend's periodic re-sync. Async (queued on histChain), so it never blocks
   * live rendering; a per-key throttle coalesces bursts. TRADES only — no clamp
   * (RTH bars are already NBBO-protected); the forming bar is left to the live feed.
   */
  private correctRecent(stream: ActiveStream): void {
    const { timeframe, contract, useRTH, reqId, symbol } = stream;
    if (timeframe === '1d' || timeframe === '1w') return; // intraday only
    const key = `${symbol}|${timeframe}`;
    const now = Date.now();
    if (now - (this.lastCorrect.get(key) ?? 0) < CORRECT_MIN_MS) return;
    this.lastCorrect.set(key, now);

    const run = async () => {
      if (!this.activeStreams.has(reqId)) return;
      try {
        const tf = TIMEFRAMES[timeframe];
        // Last ~5 bars — enough to catch the freshly-closed one plus a little overlap.
        const durSec = Math.min(Math.max(tf.seconds * 5, 300), 86400);
        const bars = await this.runHistoricalRequest(contract, tf.barSize, `${Math.ceil(durSec)} S`, useRTH);
        const live = this.activeStreams.get(reqId);
        if (!live || !bars.length) return;
        const formingTime = live.lastBar ? Number(live.lastBar.time) : null;
        for (const b of bars) {
          // Never overwrite the live forming bar; only correct closed RTH bars.
          if (formingTime != null && Number(b.time) >= formingTime) continue;
          if (!MarketDataService.isRTH(Number(b.time))) continue;
          live.onBar(b, true);
        }
      } catch (err) {
        this.logger.warn({ reqId, err: err instanceof Error ? err.message : String(err) }, 'Rollover correction failed');
      }
    };
    const advance = () => this.delay(HIST_SPACING_MS);
    this.histChain = this.histChain.then(run, run).then(advance, advance);
  }

  private runHistoricalRequest(
    contract: IBContract,
    barSize: string,
    durationStr: string,
    useRTH: 0 | 1,
    whatToShow: WhatToShow = WhatToShow.TRADES
  ): Promise<Bar[]> {
    return new Promise((resolve, reject) => {
      if (!this.ibkr.isConnected) return reject(new Error('IBKR not connected'));

      const reqId = this.historicalReqId++;
      const bars: Bar[] = [];
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        this.ibkr.api.off(EventName.historicalData, onHistoricalData);
        this.ibkr.api.off(EventName.error, onError);
      };

      const onHistoricalData = (
        id: number, date: string, open: number, high: number, low: number, close: number, volume: number
      ) => {
        if (id !== reqId) return;
        if (date.startsWith('finished')) {
          if (settled) return;
          settled = true; cleanup();
          resolve(bars);
          return;
        }
        const time = this.parseIBKRDate(date);
        if (time && open > 0) bars.push({ time, open, high, low, close, volume: volume ?? 0 });
      };

      const onError = (err: Error, code: number, id: number) => {
        if (id !== reqId || settled) return;
        settled = true; cleanup();
        this.logger.warn({ reqId, code, symbol: contract.symbol, message: err.message }, 'Historical request failed');
        reject(new Error(`IBKR error ${code}: ${err.message}`));
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        if (bars.length > 0) resolve(bars);
        else reject(new Error('Historical data request timed out'));
      }, 30_000);

      this.ibkr.api.on(EventName.historicalData, onHistoricalData);
      this.ibkr.api.on(EventName.error, onError);

      this.ibkr.api.reqHistoricalData(
        reqId, contract, '', durationStr, barSize as BarSizeSetting, whatToShow,
        useRTH, 2 /* epoch seconds */, false /* keepUpToDate */, []
      );
    });
  }

  // ─── Live streaming via keepUpToDate ─────────────────────────────────────────

  subscribeRealTime(
    contract: IBContract,
    timeframe: Timeframe,
    onSnapshot: OnSnapshotCallback,
    onBar: OnBarCallback,
    onTick: OnTickCallback,
    useRTH: 0 | 1 = 1
  ): () => void {
    if (!this.ibkr.isConnected) throw new Error('IBKR not connected');
    // Daily/weekly are the official RTH session, like every standard daily chart.
    if (timeframe === '1d' || timeframe === '1w') useRTH = 1;

    const reqId = this.streamReqId++;
    const tf = TIMEFRAMES[timeframe];

    this.activeStreams.set(reqId, {
      reqId,
      symbol: contract.symbol ?? '',
      timeframe,
      contract,
      useRTH,
      onSnapshot,
      onBar,
      onTick,
      snapshotBars: [],
      snapshotFinalizing: false,
      snapshotDone: false,
      lastBar: null,
    });

    // Sub-second last-price feed so the forming candle moves smoothly between
    // the slower keepUpToDate bar updates (which stay the source of truth and
    // re-anchor the bar to TWS-exact values each cadence).
    try {
      this.ibkr.api.reqMktData(reqId + TICK_REQID_OFFSET, contract, '', false, false, []);
    } catch (err) {
      this.logger.warn({ reqId, err: err instanceof Error ? err.message : String(err) }, 'reqMktData failed');
    }

    // Issue the keepUpToDate request through the pacing queue so a burst of panel
    // subscriptions is spaced out. The persistent listeners in bindStreamEvents
    // pick up the batch + updates whenever they arrive.
    const issue = () => {
      if (!this.activeStreams.has(reqId)) return; // torn down before issuing
      this.logger.info({ reqId, symbol: contract.symbol, timeframe, useRTH }, 'Subscribing (keepUpToDate)');
      this.ibkr.api.reqHistoricalData(
        reqId, contract, '', tf.durationStr, tf.barSize as BarSizeSetting, WhatToShow.TRADES,
        useRTH, 2 /* epoch seconds */, true /* keepUpToDate */, []
      );
    };
    const advance = () => this.delay(HIST_SPACING_MS);
    this.histChain = this.histChain.then(issue, issue).then(advance, advance);

    return () => this.unsubscribe(reqId);
  }

  /** Finish the initial batch: clamp extended-hours prints, then deliver the snapshot. */
  private async finalizeSnapshot(stream: ActiveStream): Promise<void> {
    const bars = stream.snapshotBars;

    // Extended-hours intraday: clamp stale away-from-market prints to NBBO so the
    // snapshot (and PMH/PML) matches TWS. Live updates are already TWS-equivalent.
    if (stream.timeframe !== '1d' && stream.timeframe !== '1w' && stream.useRTH === 0 && bars.length) {
      try {
        const tf = TIMEFRAMES[stream.timeframe];
        const quotes = await this.runHistoricalRequest(stream.contract, tf.barSize, tf.durationStr, 0, WhatToShow.BID_ASK);
        if (this.activeStreams.get(stream.reqId) !== stream) return; // unsubscribed meanwhile
        const fixed = MarketDataService.sanitizeExtendedBars(bars, quotes);
        if (fixed > 0) this.logger.info({ reqId: stream.reqId, symbol: stream.symbol, fixed }, 'Clamped stale extended-hours prints to NBBO');
      } catch (err) {
        this.logger.warn({ reqId: stream.reqId, err: err instanceof Error ? err.message : String(err) }, 'BID_ASK sanitize failed; serving unfiltered');
      }
    }

    if (this.activeStreams.get(stream.reqId) !== stream) return;
    stream.lastBar = bars.length ? bars[bars.length - 1] : null;
    // Set done immediately before delivering (no await between) so live updates
    // are dropped until the snapshot lands, never before it.
    stream.snapshotDone = true;
    stream.onSnapshot(bars);
    this.logger.info({ reqId: stream.reqId, symbol: stream.symbol, timeframe: stream.timeframe, count: bars.length }, 'Snapshot delivered');
  }

  private unsubscribe(reqId: number): void {
    const stream = this.activeStreams.get(reqId);
    if (!stream) return;
    this.activeStreams.delete(reqId);
    try {
      this.ibkr.api.cancelHistoricalData(reqId);
      this.ibkr.api.cancelMktData(reqId + TICK_REQID_OFFSET);
      this.logger.info({ reqId }, 'Unsubscribed (keepUpToDate)');
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
        resolve(results);
      }, 5_000);

      this.ibkr.api.reqMatchingSymbols(reqId, query);
    });
  }

  // ─── Event binding (keepUpToDate snapshot + live updates) ────────────────────

  private bindStreamEvents(): void {
    // Initial batch for each keepUpToDate subscription. (One-shot
    // runHistoricalRequest reqIds aren't in activeStreams, so they're ignored
    // here and handled by their own temporary listener.)
    this.ibkr.api.on(
      EventName.historicalData,
      (reqId: number, date: string, open: number, high: number, low: number, close: number, volume: number) => {
        const stream = this.activeStreams.get(reqId);
        if (!stream || stream.snapshotDone || stream.snapshotFinalizing) return;
        if (String(date).startsWith('finished')) { stream.snapshotFinalizing = true; void this.finalizeSnapshot(stream); return; }
        const time = this.parseIBKRDate(String(date));
        if (time && open > 0) stream.snapshotBars.push({ time, open, high, low, close, volume: volume ?? 0 });
      }
    );

    // Live bar updates — the composite TWS-equivalent bar. Fires repeatedly for
    // the forming bar and, when the clock rolls, for the new bar.
    this.ibkr.api.on(
      EventName.historicalDataUpdate,
      (reqId: number, date: string, open: number, high: number, low: number, close: number, volume: number) => {
        const stream = this.activeStreams.get(reqId);
        if (!stream || !stream.snapshotDone) return;
        const time = this.parseIBKRDate(String(date));
        if (!time || !(open > 0)) return;
        const bar: Bar = { time, open, high, low, close, volume: volume ?? 0 };
        const last = stream.lastBar;

        if (last && time > Number(last.time)) {
          stream.onBar(last, true);   // previous bar is now final
          stream.onBar(bar, false);   // new forming bar
          stream.lastBar = bar;
          // Finalize the just-closed bar to its official value right as the new
          // one opens (TWS-style), for regular-hours bars. Pre/post-market rely
          // on the frontend's clamped re-sync (needs BID_ASK, heavier).
          if (MarketDataService.isRTH(Number(last.time))) this.correctRecent(stream);
        } else if (last && time < Number(last.time)) {
          stream.onBar(bar, true);    // late correction to an older bar — update in place
        } else {
          stream.onBar(bar, false);   // same forming bar (or the very first update)
          stream.lastBar = bar;
        }
      }
    );

    // Sub-second bid/ask/last ticks — paint the forming candle between the slower
    // keepUpToDate bar updates.
    this.ibkr.api.on(
      EventName.tickPrice,
      (reqId: number, tickType: number, price: number) => {
        const stream = this.activeStreams.get(reqId - TICK_REQID_OFFSET);
        if (!stream || price <= 0) return;
        // tickType: 1=bid, 2=ask, 4=last
        const tick: Tick = { symbol: stream.symbol, timestamp: Date.now(), bid: 0, ask: 0, last: 0, volume: 0 };
        if (tickType === 1) tick.bid = price;
        else if (tickType === 2) tick.ask = price;
        else if (tickType === 4) tick.last = price;
        else return;
        stream.onTick(tick);
      }
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private parseIBKRDate(date: string): number | null {
    // Unix epoch seconds (formatDate=2), 10 digits.
    if (/^\d{10}$/.test(date)) return parseInt(date, 10);

    // Daily bars "YYYYMMDD" → UTC midnight seconds (shared numeric representation;
    // the frontend converts to "YYYY-MM-DD").
    const dateOnly = date.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (dateOnly) {
      const [, y, mo, d] = dateOnly;
      return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 1000);
    }

    // Intraday "YYYYMMDD HH:mm:ss[ tz]".
    const withTime = date.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (withTime) {
      const [, y, mo, d, h, mi, s] = withTime;
      return Math.floor(new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).getTime() / 1000);
    }

    this.logger.warn({ date }, 'Could not parse IBKR date format');
    return null;
  }

  /** Build an IBContract from our simplified Contract type. */
  static toIBContract(symbol: string, secType: SecType, exchange: string, currency: string): IBContract {
    return { symbol, secType: secType as IBSecType, exchange, currency };
  }
}
