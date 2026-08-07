/**
 * ExecutionsService
 *
 * Polls IBKR for the account's fills (reqExecutions) every few seconds so
 * trades entered manually in TWS — including option orders — show up as
 * entry/exit arrows on the charts. Manual TWS fills do NOT push to API clients
 * with a non-zero client id, so polling is the reliable path.
 *
 * Fills are normalized to `TradeExecution` (options carry the UNDERLYING
 * symbol), deduped by execId, persisted to <DATA_DIR>/store/executions.json
 * (pruned to ~5 days) so arrows survive restarts, and new ones are handed to
 * the WS gateway for broadcast.
 */

import { EventName, ExecutionFilter, Contract as IBContract, Execution, CommissionReport } from '@stoqey/ib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { TradeExecution } from '@ibkr-chart/types';
import { IBKRService } from './ibkr.service.js';
import { config } from '../config.js';
import { etWallClockToUnix } from '../lib/etTime.js';

const POLL_MS = 10_000;
// Fills feed both the chart arrows (recent) and the P&L calendar's CURRENT day
// (Flex covers history), but keeping a long local tail costs nothing and gives
// the calendar a fallback for days Flex hasn't published yet.
const KEEP_DAYS = 400;
// IBKR sends Double.MAX_VALUE for "no realized P&L" (opening trades).
const NO_VALUE = 1e12;
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const FILE = join(DATA_DIR, 'store', 'executions.json');

export class ExecutionsService {
  private static instance: ExecutionsService;

  private ibkr: IBKRService;
  private logger: Logger;
  private reqId = config.reqId.execBase;
  private cache = new Map<string, TradeExecution>(); // execId → fill
  private pending: TradeExecution[] = [];            // fills gathered during one poll
  // execId → commission/realized P&L, for reports that beat their fill here.
  private commissions = new Map<string, { commission: number; realizedPnl?: number }>();
  private pollTimer: NodeJS.Timeout | null = null;
  private loaded: Promise<void>;
  private onNewExecutions: (execs: TradeExecution[]) => void = () => {};

  private constructor(ibkr: IBKRService, logger: Logger) {
    this.ibkr = ibkr;
    this.logger = logger.child({ service: 'ExecutionsService' });
    this.loaded = this.loadFromDisk();
    this.bindEvents();
    this.pollTimer = setInterval(() => this.poll(), POLL_MS);
    // First poll shortly after startup (once the IBKR socket is likely up).
    setTimeout(() => this.poll(), 3_000);
  }

  static getInstance(ibkr: IBKRService, logger: Logger): ExecutionsService {
    if (!ExecutionsService.instance) {
      ExecutionsService.instance = new ExecutionsService(ibkr, logger);
    }
    return ExecutionsService.instance;
  }

  /** Wire the broadcast sink (WS gateway). */
  setOnNewExecutions(cb: (execs: TradeExecution[]) => void): void {
    this.onNewExecutions = cb;
  }

  /** All known fills (disk + live), newest last. */
  async getExecutions(): Promise<TradeExecution[]> {
    await this.loaded;
    return [...this.cache.values()].sort((a, b) => a.time - b.time);
  }

  // ─── Polling ────────────────────────────────────────────────────────────────

  private poll(): void {
    if (!this.ibkr.isConnected) return;
    this.pending = [];
    try {
      this.ibkr.api.reqExecutions(this.reqId++, {} as ExecutionFilter);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'reqExecutions failed');
    }
  }

  private bindEvents(): void {
    this.ibkr.api.on(
      EventName.execDetails,
      (_reqId: number, contract: IBContract, execution: Execution) => {
        const norm = this.normalize(contract, execution);
        if (norm) this.pending.push(norm);
      }
    );

    this.ibkr.api.on(EventName.execDetailsEnd, () => {
      void this.ingest(this.pending);
      this.pending = [];
    });

    // Commission reports arrive alongside/just after their fill and carry
    // IBKR's own FIFO realized P&L — the basis for the P&L calendar. They can
    // land before OR after the fill is cached, so keep them in a side map and
    // apply from both directions.
    this.ibkr.api.on(EventName.commissionReport, (cr: CommissionReport) => {
      const execId = cr.execId;
      if (!execId) return;
      const commission = Math.abs(Number(cr.commission ?? 0));
      const rp = Number(cr.realizedPNL);
      const realizedPnl = Number.isFinite(rp) && Math.abs(rp) < NO_VALUE ? rp : undefined;
      this.commissions.set(execId, { commission, realizedPnl });

      const existing = this.cache.get(execId);
      if (existing) {
        existing.commission = commission;
        if (realizedPnl !== undefined) existing.realizedPnl = realizedPnl;
        void this.saveToDisk();
      }
    });
  }

  private async ingest(execs: TradeExecution[]): Promise<void> {
    await this.loaded;
    const fresh = execs.filter((e) => !this.cache.has(e.execId));
    if (!fresh.length) return;
    for (const e of fresh) {
      // Attach the commission report if it arrived before the fill did.
      const c = this.commissions.get(e.execId);
      if (c) {
        e.commission = c.commission;
        if (c.realizedPnl !== undefined) e.realizedPnl = c.realizedPnl;
      }
      this.cache.set(e.execId, e);
    }
    this.prune();
    this.logger.info({ count: fresh.length, symbols: [...new Set(fresh.map((e) => e.symbol))] }, 'New executions');
    this.onNewExecutions(fresh);
    void this.saveToDisk();
  }

  // ─── Normalization ──────────────────────────────────────────────────────────

  private normalize(contract: IBContract, execution: Execution): TradeExecution | null {
    const execId = execution.execId;
    const symbol = contract.symbol;
    if (!execId || !symbol) return null;
    const side = execution.side === 'BOT' || execution.side === 'SLD' ? execution.side : null;
    if (!side) return null;
    const time = this.parseExecTime(execution.time);
    if (!time) return null;

    const out: TradeExecution = {
      execId,
      time,
      symbol,
      secType: String(contract.secType ?? ''),
      side,
      price: Number(execution.price ?? 0),
      quantity: Number(execution.shares ?? 0),
    };
    if (contract.secType === 'OPT' || contract.secType === 'FOP') {
      if (contract.strike) out.strike = Number(contract.strike);
      if (contract.right) out.right = String(contract.right).slice(0, 1).toUpperCase();
      if (contract.lastTradeDateOrContractMonth) out.expiry = String(contract.lastTradeDateOrContractMonth);
    }
    return out;
  }

  /**
   * "yyyymmdd  hh:mm:ss [timezone]" → unix seconds.
   *
   * Newer TWS builds append the zone ("20260724 09:30:00 US/Eastern"); when it
   * is present we honour it. Otherwise the wall clock is resolved against
   * EXCHANGE time, not the server's timezone — the old machine-local reading
   * was only correct while this machine sat in ET, and silently shifted every
   * fill (and could misattribute one across midnight) anywhere else.
   */
  private parseExecTime(raw?: string): number | null {
    if (!raw) return null;
    const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s*(\S+)?/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s, zone] = m;
    const parts = [y, mo, d, h, mi, s].map(Number);

    if (zone) {
      try {
        // Resolve the stated zone by formatting a probe instant in it.
        const naive = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]) / 1000;
        const fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
        });
        const read = (t: number) => {
          const o: Record<string, number> = {};
          for (const p of fmt.formatToParts(new Date(t * 1000))) {
            if (p.type !== 'literal') o[p.type] = Number(p.value);
          }
          return Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute, o.second) / 1000;
        };
        let guess = naive + (naive - read(naive));
        guess = naive + (guess - read(guess));
        return Math.floor(guess);
      } catch { /* unknown zone name — fall through to exchange time */ }
    }

    const t = etWallClockToUnix(parts[0], parts[1], parts[2], parts[3], parts[4], parts[5]);
    return Number.isFinite(t) ? Math.floor(t) : null;
  }

  private prune(): void {
    const cutoff = Math.floor(Date.now() / 1000) - KEEP_DAYS * 86_400;
    for (const [id, e] of this.cache) {
      if (e.time < cutoff) this.cache.delete(id);
    }
  }

  // ─── Disk persistence (same pattern as store.routes) ────────────────────────

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(FILE, 'utf8');
      const arr = JSON.parse(raw) as TradeExecution[];
      if (Array.isArray(arr)) {
        for (const e of arr) {
          if (e?.execId && e.time && e.symbol) this.cache.set(e.execId, e);
        }
        this.prune();
      }
    } catch { /* no file yet */ }
  }

  private async saveToDisk(): Promise<void> {
    try {
      await mkdir(join(DATA_DIR, 'store'), { recursive: true });
      const tmp = `${FILE}.tmp`;
      const sorted = [...this.cache.values()].sort((a, b) => a.time - b.time);
      await writeFile(tmp, JSON.stringify(sorted, null, 2), 'utf8');
      await rename(tmp, FILE);
    } catch (err) {
      this.logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'executions save failed');
    }
  }
}
