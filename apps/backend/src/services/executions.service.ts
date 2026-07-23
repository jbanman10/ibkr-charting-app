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

import { EventName, ExecutionFilter, Contract as IBContract, Execution } from '@stoqey/ib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { TradeExecution } from '@ibkr-chart/types';
import { IBKRService } from './ibkr.service.js';
import { config } from '../config.js';

const POLL_MS = 10_000;
const KEEP_DAYS = 5;
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const FILE = join(DATA_DIR, 'store', 'executions.json');

export class ExecutionsService {
  private static instance: ExecutionsService;

  private ibkr: IBKRService;
  private logger: Logger;
  private reqId = config.reqId.execBase;
  private cache = new Map<string, TradeExecution>(); // execId → fill
  private pending: TradeExecution[] = [];            // fills gathered during one poll
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
  }

  private async ingest(execs: TradeExecution[]): Promise<void> {
    await this.loaded;
    const fresh = execs.filter((e) => !this.cache.has(e.execId));
    if (!fresh.length) return;
    for (const e of fresh) this.cache.set(e.execId, e);
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

  /** "yyyymmdd  hh:mm:ss" (TWS operator timezone = this machine) → unix seconds. */
  private parseExecTime(raw?: string): number | null {
    if (!raw) return null;
    const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
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
