/**
 * RVOL scanner endpoint.
 *
 * GET /api/scanner/rvol → mega-cap US stocks ranked by relative volume.
 *
 * Two stages:
 *  1. IBKR market scanner `HOT_BY_VOLUME` (today's volume vs average daily —
 *     TWS's own RVOL ranking) over STK.US.MAJOR, corporates only, cap ≥ $90B.
 *  2. For the top symbols, exact session-adjusted RVOL via the shared
 *     `lib/rvol.ts` math (U-shaped time-of-day curve, day-cached 10-day
 *     averages) plus price/change from one small daily-bars request.
 *
 * Results cached ~60s.
 */

import type { FastifyInstance } from 'fastify';
import { EventName, Instrument, LocationCode, ScanCode, type ContractDetails } from '@stoqey/ib';
import { MarketDataService } from '../services/market-data.service.js';
import { IBKRService } from '../services/ibkr.service.js';
import { sessionFraction, avgDailyVolume, etDay, AVG_DAYS } from '../lib/rvol.js';
import { config } from '../config.js';

export interface RvolRow {
  symbol: string;
  rvol: number;       // session-adjusted relative volume
  price: number;      // today's last (daily bar close)
  changePct: number;  // vs previous daily close
  volume: number;     // today's cumulative volume
}

const SCAN_ROWS = 30;      // symbols to request from the IBKR scanner
const DETAIL_ROWS = 15;    // symbols we compute exact RVOL for
const CACHE_MS = 60_000;

export async function registerScannerRoutes(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const marketData = MarketDataService.getInstance(ibkr, app.log as any);

  let scanReqId = config.reqId.scanBase;
  let cached: { at: number; rows: RvolRow[] } | null = null;

  /** Stage 1: ranked symbols from the IBKR market scanner. */
  function runScan(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const reqId = scanReqId++;
      const symbols: string[] = [];
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        ibkr.api.off(EventName.scannerData, onData);
        ibkr.api.off(EventName.scannerDataEnd, onEnd);
        ibkr.api.off(EventName.error, onError);
        try { ibkr.api.cancelScannerSubscription(reqId); } catch { /* already gone */ }
      };
      const onData = (id: number, _rank: number, details: ContractDetails) => {
        if (id !== reqId) return;
        const sym = details?.contract?.symbol;
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      };
      const onEnd = (id: number) => {
        if (id !== reqId || settled) return;
        settled = true; cleanup(); resolve(symbols);
      };
      const onError = (err: Error, _code: number, id: number) => {
        if (id !== reqId || settled) return;
        settled = true; cleanup(); reject(err);
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true; cleanup();
        if (symbols.length) resolve(symbols); else reject(new Error('scanner timed out'));
      }, 15_000);

      ibkr.api.on(EventName.scannerData, onData);
      ibkr.api.on(EventName.scannerDataEnd, onEnd);
      ibkr.api.on(EventName.error, onError);
      ibkr.api.reqScannerSubscription(reqId, {
        instrument: Instrument.STK,
        locationCode: LocationCode.STK_US_MAJOR,
        scanCode: ScanCode.HOT_BY_VOLUME,
        numberOfRows: SCAN_ROWS,
        abovePrice: 5,
        // Low floor so the scan is useful in the first 10-15 min of the session,
        // before most names have printed a million shares.
        aboveVolume: 300_000,
        marketCapAbove: 90_000, // ≥ $90B (IBKR scanner units: $ millions)
        stockTypeFilter: 'CORP', // real companies — keep leveraged ETFs off the board
      });
    });
  }

  /** Stage 2: exact session-adjusted RVOL from daily bars (today = partial bar). */
  async function computeRvol(symbol: string): Promise<RvolRow | null> {
    const contract = MarketDataService.toIBContract(symbol, 'STK', 'SMART', 'USD');
    const bars = await marketData.fetchRecentDailyBars(contract, AVG_DAYS + 3);
    if (bars.length < 3) return null;

    const avg = await avgDailyVolume(marketData, symbol, app.log as any);
    if (avg == null) return null;

    const last = bars[bars.length - 1];
    const today = etDay();
    let todayVol: number;
    let price: number;
    let prevClose: number;

    if (etDay(Number(last.time)) === today) {
      // Regular case: last daily bar IS today (partial, cumulative volume).
      todayVol = Number(last.volume) || 0;
      price = Number(last.close);
      prevClose = Number(bars[bars.length - 2]?.close) || 0;
    } else {
      // Pre-market: today's daily bar doesn't exist yet — without this branch
      // yesterday's FULL volume would masquerade as "today". Pull today's
      // pre-market prints from extended-hours 1m bars instead.
      const mins = await marketData.fetchHistoricalBars(contract, '1m', 0);
      const todayMins = mins.filter((b) => etDay(Number(b.time)) === today);
      todayVol = todayMins.reduce((a, b) => a + (Number(b.volume) || 0), 0);
      price = todayMins.length ? Number(todayMins[todayMins.length - 1].close) : Number(last.close);
      prevClose = Number(last.close) || 0;
    }
    if (!(prevClose > 0)) return null;

    return {
      symbol,
      rvol: todayVol / (avg * sessionFraction()),
      price,
      changePct: ((price - prevClose) / prevClose) * 100,
      volume: todayVol,
    };
  }

  app.get('/api/scanner/rvol', async (_request, reply) => {
    if (cached && Date.now() - cached.at < CACHE_MS) return { rows: cached.rows, asOf: cached.at };
    if (!ibkr.isConnected) return reply.status(503).send({ error: 'IBKR not connected' });

    try {
      const symbols = (await runScan()).slice(0, DETAIL_ROWS);
      const rows: RvolRow[] = [];
      for (const sym of symbols) {
        try {
          const row = await computeRvol(sym);
          if (row) rows.push(row);
        } catch (err) {
          app.log.warn({ sym, err: err instanceof Error ? err.message : String(err) }, 'rvol compute failed');
        }
      }
      rows.sort((a, b) => b.rvol - a.rvol);
      cached = { at: Date.now(), rows };
      return { rows, asOf: cached.at };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'scanner failed';
      app.log.error({ err }, 'rvol scan failed');
      return reply.status(500).send({ error: message });
    }
  });
}
