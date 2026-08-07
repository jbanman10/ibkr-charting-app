/**
 * TradesService — the trade journal's data layer.
 *
 * Builds one normalized fill stream out of the two sources the app has (the
 * Flex statement for history, locally collected executions for today and
 * anything Flex hasn't published), runs it through the pure FIFO matcher, and
 * caches the result.
 *
 * Caching: matched trades and their per-day rollups are held in memory and
 * mirrored to <DATA_DIR>/store/trade-aggregates.json, keyed by a fingerprint of
 * the inputs (Flex sync time + row count, execution count + newest fill). A
 * request recomputes only when that fingerprint moves — a Flex sync, or a new
 * fill landing. The file makes a cold start instant; it is a cache, never a
 * source of truth, so a corrupt or stale one costs one recompute.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { MatchedTrade, TradeDaySummary, TradeExecution } from '@ibkr-chart/types';
import { FlexService, hasFlexDetail, type FlexTrade } from './flex.service.js';
import { ExecutionsService } from './executions.service.js';
import { IBKRService } from './ibkr.service.js';
import { matchTrades, summarizeByDay, defaultMultiplier, type MatchableFill } from '../lib/tradeMatcher.js';
import { etDay } from '../lib/etTime.js';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const CACHE_FILE = join(DATA_DIR, 'store', 'trade-aggregates.json');

interface Computed {
  fingerprint: string;
  trades: MatchedTrade[];
  days: TradeDaySummary[];
  /** True when at least one Flex row carried per-fill detail — i.e. history is
   * drillable, not just day-level. */
  detailAvailable: boolean;
}

export class TradesService {
  private static instance: TradesService;

  private logger: Logger;
  private flex: FlexService;
  private executions: ExecutionsService;
  private computed: Computed | null = null;
  private loaded: Promise<void>;
  /** Concurrent requests during a recompute share one run. */
  private inflight: Promise<Computed> | null = null;

  private constructor(ibkr: IBKRService, logger: Logger) {
    this.logger = logger.child({ service: 'TradesService' });
    this.flex = FlexService.getInstance(logger);
    this.executions = ExecutionsService.getInstance(ibkr, logger);
    this.loaded = this.loadCache();
  }

  static getInstance(ibkr: IBKRService, logger: Logger): TradesService {
    if (!TradesService.instance) TradesService.instance = new TradesService(ibkr, logger);
    return TradesService.instance;
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  async getAll(): Promise<Computed> {
    await this.loaded;
    if (this.inflight) return this.inflight;

    const [{ trades: flexTrades, syncedAt }, execs] = await Promise.all([
      this.flex.getTrades(),
      this.executions.getExecutions(),
    ]);
    const fingerprint = TradesService.fingerprint(flexTrades, syncedAt, execs);
    if (this.computed?.fingerprint === fingerprint) return this.computed;

    this.inflight = this.recompute(flexTrades, execs, fingerprint)
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async getDays(): Promise<TradeDaySummary[]> {
    return (await this.getAll()).days;
  }

  /** Matched trades closed on an ET calendar date. */
  async getTradesForDay(date: string): Promise<MatchedTrade[]> {
    const { trades } = await this.getAll();
    return trades.filter((t) => t.date === date);
  }

  /** Matched trades closed within an inclusive ET date range. */
  async getTradesInRange(from: string, to: string): Promise<MatchedTrade[]> {
    const { trades } = await this.getAll();
    return trades.filter((t) => t.date >= from && t.date <= to);
  }

  // ─── Computation ────────────────────────────────────────────────────────────

  private async recompute(
    flexTrades: FlexTrade[],
    execs: TradeExecution[],
    fingerprint: string
  ): Promise<Computed> {
    const started = Date.now();
    const { fills, detailAvailable } = TradesService.buildFills(flexTrades, execs);
    const trades = matchTrades(fills);
    const days = summarizeByDay(trades);

    const computed: Computed = { fingerprint, trades, days, detailAvailable };
    this.computed = computed;
    this.logger.info(
      { fills: fills.length, trades: trades.length, days: days.length, detailAvailable, ms: Date.now() - started },
      'Trade journal recomputed'
    );
    void this.saveCache(computed);
    return computed;
  }

  /**
   * Merge the two fill sources into one stream.
   *
   * Flex is authoritative for every date it covers, so local executions are
   * dropped for those dates — otherwise a fill present in both would open and
   * close twice. (A position opened on a Flex-covered day and closed on a
   * local-only day is the one case this can't stitch together; it shows up as
   * an unmatched open and is simply not reported, which beats double counting.)
   */
  static buildFills(
    flexTrades: FlexTrade[],
    execs: TradeExecution[]
  ): { fills: MatchableFill[]; detailAvailable: boolean } {
    const fills: MatchableFill[] = [];
    const flexDates = new Set<string>();
    let detailRows = 0;

    flexTrades.forEach((t, i) => {
      flexDates.add(t.date);
      if (!hasFlexDetail(t)) return;
      detailRows++;
      const secType = t.assetCategory || 'STK';
      fills.push({
        id: t.id ?? `flex:${t.date}:${i}`,
        time: t.time!,
        symbol: t.symbol,
        secType,
        side: t.side!,
        price: t.price!,
        quantity: t.quantity!,
        commission: t.commission,
        // Flex reports realized P&L on the closing row; 0 means "opening", not
        // "broke exactly even", so don't hand a 0 to the matcher as truth.
        realizedPnl: t.realizedPnl !== 0 ? t.realizedPnl : undefined,
        multiplier: t.multiplier ?? defaultMultiplier(secType),
        strike: t.strike,
        right: t.right,
        expiry: t.expiry,
        source: 'flex',
      });
    });

    for (const e of execs) {
      if (flexDates.has(etDay(e.time))) continue; // Flex owns this date
      fills.push({
        id: e.execId,
        time: e.time,
        symbol: e.symbol,
        secType: e.secType || 'STK',
        side: e.side,
        price: e.price,
        quantity: e.quantity,
        commission: e.commission,
        realizedPnl: e.realizedPnl,
        multiplier: defaultMultiplier(e.secType || 'STK'),
        strike: e.strike,
        right: e.right,
        expiry: e.expiry,
        source: 'local',
      });
    }

    return { fills, detailAvailable: detailRows > 0 };
  }

  /** Cheap, order-independent signature of the inputs. */
  private static fingerprint(
    flexTrades: FlexTrade[],
    syncedAt: number | null,
    execs: TradeExecution[]
  ): string {
    const newest = execs.reduce((a, e) => Math.max(a, e.time), 0);
    // Commission reports mutate fills in place without changing the count, so
    // fold their presence in too.
    const priced = execs.reduce((a, e) => a + (e.commission != null ? 1 : 0), 0);
    return [flexTrades.length, syncedAt ?? 0, execs.length, newest, priced].join(':');
  }

  // ─── Cache file (same write-then-rename pattern as the other stores) ────────

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Computed;
      if (parsed?.fingerprint && Array.isArray(parsed.trades) && Array.isArray(parsed.days)) {
        this.computed = parsed;
      }
    } catch { /* no cache yet — first request computes it */ }
  }

  private async saveCache(computed: Computed): Promise<void> {
    try {
      await mkdir(join(DATA_DIR, 'store'), { recursive: true });
      const tmp = `${CACHE_FILE}.tmp`;
      await writeFile(tmp, JSON.stringify(computed), 'utf8');
      await rename(tmp, CACHE_FILE);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'trade cache save failed');
    }
  }
}
