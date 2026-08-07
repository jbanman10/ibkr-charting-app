/**
 * FlexService — historical trade history via IBKR's Flex Web Service.
 *
 * The TWS API only returns the CURRENT day's executions (verified: a 90-day
 * ExecutionFilter returns nothing), so the P&L calendar's history comes from
 * Flex instead: the user enables the Flex Web Service in IBKR Account
 * Management, generates a token, and creates an Activity query with the Trades
 * section. We then fetch it over HTTPS in the documented two steps:
 *
 *   1. SendRequest?t=<token>&q=<queryId>&v=3  → a ReferenceCode + Url
 *   2. <Url>?t=<token>&q=<ReferenceCode>&v=3  → the statement XML
 *      (may answer "generation in progress" — we retry a few times)
 *
 * Parsed trades are cached to <DATA_DIR>/store/trades.json so the calendar
 * loads instantly and keeps working when IBKR is unreachable.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { FlexConfig } from '@ibkr-chart/types';
import { etWallClockToUnix } from '../lib/etTime.js';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const CONFIG_FILE = join(DATA_DIR, 'store', 'flex.json');
const TRADES_FILE = join(DATA_DIR, 'store', 'trades.json');

const SEND_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
const FETCH_TIMEOUT_MS = 30_000;
const STATEMENT_RETRIES = 6;
const RETRY_DELAY_MS = 4_000;

/**
 * A single trade row from the Flex statement.
 *
 * The first five fields are always present and are all the day-level P&L
 * calendar needs. The rest are the per-FILL detail the trade journal needs to
 * match round-trips and plot entries/exits — they only appear when the user's
 * Flex query includes those columns, so every one is optional and consumers
 * must check `hasFlexDetail()` before relying on them.
 */
export interface FlexTrade {
  date: string;        // YYYY-MM-DD
  symbol: string;      // underlying where available
  assetCategory: string;
  realizedPnl: number; // 0 on opening trades
  commission: number;  // absolute cost (positive)

  id?: string;         // tradeID / transactionID — stable across syncs
  time?: number;       // unix seconds (exchange time)
  side?: 'BOT' | 'SLD';
  quantity?: number;   // absolute
  price?: number;
  multiplier?: number;
  strike?: number;
  right?: string;      // 'C' | 'P'
  expiry?: string;     // yyyymmdd
}

interface TradesCache {
  trades: FlexTrade[];
  syncedAt: number | null;
}

/** True when this row carries enough detail to participate in FIFO matching. */
export function hasFlexDetail(t: FlexTrade): boolean {
  return t.time != null && t.side != null && t.quantity != null && t.price != null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull attributes out of a self-closing XML tag. */
function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

const num = (v: string | undefined): number => {
  if (v == null || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** "20260723" | "2026-07-23" | "20260723;123000" → "2026-07-23" */
function normalizeDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim().split(/[;\s]/)[0];
  let m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return null;
}

/**
 * Flex `dateTime` → unix seconds. Accepts the several shapes IBKR emits
 * depending on the query's date/time format setting:
 *   "20260723;103000"  "20260723 10:30:00"  "2026-07-23 10:30:00"  "20260723;10:30:00"
 * The wall clock is exchange time, so it is resolved against America/New_York
 * rather than the server's timezone.
 */
function parseFlexDateTime(raw: string | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})[;\sT]+(\d{2}):?(\d{2}):?(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m.map(Number) as unknown as number[];
  const t = etWallClockToUnix(y, mo, d, h, mi, sec);
  return Number.isFinite(t) ? t : null;
}

/** Flex `expiry` in any of its spellings → "yyyymmdd". */
function normalizeExpiry(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().replace(/-/g, '');
  return /^\d{8}$/.test(s) ? s : undefined;
}

export class FlexService {
  private static instance: FlexService;
  private logger: Logger;
  private cache: TradesCache = { trades: [], syncedAt: null };
  private config: FlexConfig = {};
  private loaded: Promise<void>;
  private syncing: Promise<{ ok: boolean; count?: number; error?: string }> | null = null;

  private constructor(logger: Logger) {
    this.logger = logger.child({ service: 'FlexService' });
    this.loaded = this.load();
  }

  static getInstance(logger: Logger): FlexService {
    if (!FlexService.instance) FlexService.instance = new FlexService(logger);
    return FlexService.instance;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(CONFIG_FILE, 'utf8');
      this.config = JSON.parse(raw) as FlexConfig;
    } catch { /* not configured yet */ }
    try {
      const raw = await readFile(TRADES_FILE, 'utf8');
      const parsed = JSON.parse(raw) as TradesCache;
      if (Array.isArray(parsed?.trades)) this.cache = parsed;
    } catch { /* no cache yet */ }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(join(DATA_DIR, 'store'), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await rename(tmp, file);
  }

  async getConfig(): Promise<{ configured: boolean; queryId?: string }> {
    await this.loaded;
    // Never echo the token back to the client.
    return { configured: !!(this.config.token && this.config.queryId), queryId: this.config.queryId };
  }

  async setConfig(cfg: FlexConfig): Promise<void> {
    await this.loaded;
    this.config = { ...this.config, ...cfg };
    await this.writeJson(CONFIG_FILE, this.config);
  }

  async getTrades(): Promise<TradesCache> {
    await this.loaded;
    return this.cache;
  }

  /** Fetch + parse the Flex statement. Concurrent calls share one run. */
  sync(): Promise<{ ok: boolean; count?: number; error?: string }> {
    if (this.syncing) return this.syncing;
    this.syncing = this.runSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async runSync(): Promise<{ ok: boolean; count?: number; error?: string }> {
    await this.loaded;
    const { token, queryId } = this.config;
    if (!token || !queryId) return { ok: false, error: 'Flex token and query id are not configured' };

    try {
      const xml = await this.fetchStatement(token, queryId);
      if ('error' in xml) return { ok: false, error: xml.error };
      const trades = FlexService.parseTrades(xml.body);
      if (!trades.length && !/<Trades?\b/i.test(xml.body)) {
        return { ok: false, error: 'The statement has no Trades section — add it to the Flex query (with Realized P&L and Commission fields).' };
      }
      this.cache = { trades, syncedAt: Date.now() };
      await this.writeJson(TRADES_FILE, this.cache);
      this.logger.info({ count: trades.length }, 'Flex sync complete');
      return { ok: true, count: trades.length };
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Flex sync failed';
      this.logger.warn({ err: error }, 'Flex sync failed');
      return { ok: false, error };
    }
  }

  private async fetchStatement(token: string, queryId: string): Promise<{ body: string } | { error: string }> {
    const get = async (url: string): Promise<string> => {
      const res = await fetch(url, {
        headers: { 'user-agent': 'ibkr-chart/1.0' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Flex HTTP ${res.status}`);
      return res.text();
    };

    const first = await get(`${SEND_URL}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
    const fail = first.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/i);
    const refCode = first.match(/<ReferenceCode>([^<]*)<\/ReferenceCode>/i)?.[1];
    const baseUrl = first.match(/<Url>([^<]*)<\/Url>/i)?.[1];
    if (!refCode || !baseUrl) {
      return { error: fail ? `IBKR: ${fail[1]}` : 'IBKR did not return a statement reference — check the token and query id.' };
    }

    // The statement is generated asynchronously; poll until it's ready.
    for (let attempt = 0; attempt < STATEMENT_RETRIES; attempt++) {
      const body = await get(`${baseUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(refCode)}&v=3`);
      if (/<FlexQueryResponse|<Trades?\b/i.test(body)) return { body };
      const err = body.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/i)?.[1] ?? '';
      // 1019 = still generating; anything else is terminal.
      if (!/generat|progress|1019/i.test(err)) return { error: err ? `IBKR: ${err}` : 'Unexpected Flex response' };
      await delay(RETRY_DELAY_MS);
    }
    return { error: 'IBKR is still generating the statement — try again in a moment.' };
  }

  /**
   * Pull Trade rows out of an Activity Flex statement.
   *
   * A statement can carry the same trade at several levels of detail
   * (`levelOfDetail="EXECUTION"` alongside `"ORDER"`, plus `CLOSED_LOT` rows).
   * Summing all of them would double- or triple-count, so rows are grouped by
   * level and only the finest AVAILABLE level is returned — EXECUTION when the
   * query includes it (that's what the journal needs), otherwise ORDER, and
   * lot rows are never used as fills.
   */
  static parseTrades(xml: string): FlexTrade[] {
    const byLevel = new Map<string, FlexTrade[]>();

    for (const m of xml.matchAll(/<(Trade|Order)\b([^>]*?)\/?>/gi)) {
      const a = parseAttrs(m[2]);
      const date = normalizeDate(a.tradeDate ?? a.dateTime ?? a.settleDateTarget);
      if (!date) continue;

      const level = (a.levelOfDetail ?? '').toUpperCase();
      // CLOSED_LOT / LOT rows describe how an existing trade was matched by
      // IBKR — they are not fills, and counting them duplicates P&L.
      if (level.includes('LOT')) continue;

      // Flex names vary a little by query template; accept the usual spellings.
      const realized = num(a.fifoPnlRealized ?? a.realizedPnl ?? a.fifoPnlRealizedBase);
      const commission = Math.abs(num(a.ibCommission ?? a.commission ?? a.brokerCommission));

      const row: FlexTrade = {
        date,
        symbol: (a.underlyingSymbol || a.symbol || '').toUpperCase(),
        assetCategory: a.assetCategory ?? '',
        realizedPnl: realized,
        commission,
      };

      // ─ Optional per-fill detail (only if the query includes these columns) ─
      const time = parseFlexDateTime(a.dateTime ?? a.tradeDateTime ?? a.orderTime);
      if (time != null) row.time = time;

      const buySell = (a.buySell ?? a.side ?? '').toUpperCase();
      const qtyRaw = a.quantity ?? a.shares;
      const quantity = qtyRaw != null ? Math.abs(num(qtyRaw)) : 0;
      // Direction comes from buySell when present; some templates only signal it
      // through a signed quantity.
      if (buySell.startsWith('BUY') || buySell === 'BOT') row.side = 'BOT';
      else if (buySell.startsWith('SELL') || buySell === 'SLD') row.side = 'SLD';
      else if (qtyRaw != null && num(qtyRaw) !== 0) row.side = num(qtyRaw) > 0 ? 'BOT' : 'SLD';
      if (quantity > 0) row.quantity = quantity;

      const price = num(a.tradePrice ?? a.price);
      if (price > 0) row.price = price;

      const multiplier = num(a.multiplier);
      if (multiplier > 0) row.multiplier = multiplier;

      const strike = num(a.strike);
      if (strike > 0) row.strike = strike;

      const right = (a.putCall ?? a.right ?? '').trim().slice(0, 1).toUpperCase();
      if (right === 'P' || right === 'C') row.right = right;

      const expiry = normalizeExpiry(a.expiry ?? a.lastTradeDateOrContractMonth);
      if (expiry) row.expiry = expiry;

      const id = a.tradeID ?? a.transactionID ?? a.ibExecID ?? a.tradeId;
      if (id) row.id = String(id);

      const bucket = byLevel.get(level) ?? [];
      bucket.push(row);
      byLevel.set(level, bucket);
    }

    // Prefer the finest level present. An unlabelled statement (no
    // levelOfDetail attribute at all) lands under '' and is used as-is.
    for (const level of ['EXECUTION', 'ORDER', '']) {
      const rows = byLevel.get(level);
      if (rows?.length) return rows;
    }
    // Unexpected level name — return everything rather than nothing.
    return [...byLevel.values()].flat();
  }
}
