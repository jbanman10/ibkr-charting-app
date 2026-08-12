/**
 * tradeMatcher — FIFO round-trip matching.
 *
 * Pure functions over a normalized fill stream. Nothing here touches IBKR,
 * Fastify, or the filesystem, so the whole module is unit-testable in isolation
 * (see tradeMatcher.test.ts) — everything else in the journal depends on it
 * being right.
 *
 * How a "trade" is defined
 * ------------------------
 * Lots are consumed FIFO, but a TRADE is one POSITION EPISODE: the contract
 * goes flat → non-flat → flat. That's what a trader means by "my AMZN trade",
 * and it's what makes scale-ins and scale-outs behave — three adds and two
 * trims are one trade with quantity-weighted average entry and exit, not five.
 * The individual fills survive on `entryLegs`/`exitLegs` so the chart can still
 * mark every add and trim.
 *
 * A fill that carries the position THROUGH flat (long 2, sell 5) is split: the
 * first 2 close the long episode, the remaining 3 open a new short one.
 *
 * P&L
 * ---
 * Computed from FIFO price math, quantity × multiplier. When every closing fill
 * of an episode carries IBKR's own realized P&L, that sum wins instead
 * (`pnlSource: 'ibkr'`) — IBKR knows the true cost basis, which may predate the
 * fills we hold. Commission is pro-rated by the quantity consumed, so a
 * partially-consumed fill contributes only its matched share.
 *
 * **IBKR's realized figure is already net of commissions** (see finalizeEpisode),
 * so `pnl` takes it as-is and derives `grossPnl` by adding the fees back. Only
 * the computed path subtracts them.
 */

import type { MatchedTrade, TradeDaySummary, TradeLeg } from '@ibkr-chart/types';
import { etDay } from './etTime.js';

/** A normalized fill — the matcher's only input. */
export interface MatchableFill {
  /** Stable unique id (execId, or a synthesized one for Flex rows). */
  id: string;
  time: number;              // unix seconds
  symbol: string;            // underlying for options
  secType: string;           // 'OPT' | 'STK' | 'FOP' | ...
  side: 'BOT' | 'SLD';
  price: number;
  quantity: number;          // always positive
  commission?: number;       // absolute, for the WHOLE fill
  realizedPnl?: number;      // IBKR's own realized P&L, closing fills only
  multiplier?: number;       // defaults by secType
  strike?: number;
  right?: string;
  expiry?: string;
  source: 'flex' | 'local';
}

/** Contract identity. Options need the full series, not just the underlying —
 * two different strikes on one symbol are separate positions. */
export function contractKey(fill: MatchableFill): string {
  return [
    fill.symbol,
    fill.secType,
    fill.expiry ?? '',
    fill.strike ?? '',
    fill.right ?? '',
  ].join('|');
}

/** Contract multiplier. US equity options are 100; stock is 1. */
export function defaultMultiplier(secType: string): number {
  return secType === 'OPT' || secType === 'FOP' ? 100 : 1;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An open lot awaiting a closing fill. */
interface OpenLot {
  time: number;
  price: number;
  remaining: number;
  /** Commission per unit, so a partial close takes its fair share. */
  commissionPerUnit: number;
}

/** Accumulator for the episode currently in progress on one contract. */
interface Episode {
  direction: 'long' | 'short';
  entryLegs: TradeLeg[];
  exitLegs: TradeLeg[];
  grossPnl: number;
  commission: number;
  entryQty: number;      // total opened
  exitQty: number;       // total closed
  entryNotional: number; // Σ price × qty, for the weighted average
  exitNotional: number;
  ibkrRealized: number;
  /** False as soon as one closing fill lacks IBKR's realized P&L. */
  ibkrRealizedComplete: boolean;
  seq: number;
}

/**
 * Match a fill stream into completed round-trips.
 *
 * Fills may arrive in any order and from mixed sources; they are sorted by time
 * (then id, so equal timestamps are deterministic) before matching. Positions
 * left open at the end are simply not emitted — an unclosed position has no
 * realized P&L to report.
 */
export function matchTrades(fills: MatchableFill[]): MatchedTrade[] {
  const ordered = [...fills].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));

  const lotsByContract = new Map<string, OpenLot[]>();
  const episodeByContract = new Map<string, Episode>();
  const seqByContract = new Map<string, number>();
  const out: MatchedTrade[] = [];

  for (const fill of ordered) {
    if (!(fill.quantity > 0)) continue;

    const key = contractKey(fill);
    const multiplier = fill.multiplier ?? defaultMultiplier(fill.secType);
    const lots = lotsByContract.get(key) ?? [];
    const commissionPerUnit = (fill.commission ?? 0) / fill.quantity;

    // Signed position direction this fill would take: BOT = +, SLD = −.
    const fillIsBuy = fill.side === 'BOT';
    let remaining = fill.quantity;

    while (remaining > 0) {
      const episode = episodeByContract.get(key);
      const openDirection = episode?.direction ?? null;
      const opening =
        openDirection === null ||
        (openDirection === 'long' && fillIsBuy) ||
        (openDirection === 'short' && !fillIsBuy);

      if (opening) {
        // Extend (or start) the position — the whole remainder opens.
        const ep = episode ?? startEpisode(fillIsBuy ? 'long' : 'short', bumpSeq(seqByContract, key));
        ep.entryLegs.push({ time: fill.time, price: fill.price, quantity: remaining });
        ep.entryQty += remaining;
        ep.entryNotional += fill.price * remaining;
        ep.commission += commissionPerUnit * remaining;
        episodeByContract.set(key, ep);

        lots.push({ time: fill.time, price: fill.price, remaining, commissionPerUnit });
        lotsByContract.set(key, lots);
        remaining = 0;
        continue;
      }

      // Reducing: consume open lots FIFO.
      const lot = lots[0];
      if (!lot) {
        // Defensive: an episode with no lots shouldn't happen, but if the data
        // is inconsistent (a close with no recorded open), treat the remainder
        // as opening the other way rather than looping forever.
        episodeByContract.delete(key);
        continue;
      }

      const take = Math.min(lot.remaining, remaining);
      const ep = episode!;
      // Long: profit when exit > entry. Short: the reverse.
      const perUnit = ep.direction === 'long' ? fill.price - lot.price : lot.price - fill.price;
      ep.grossPnl += perUnit * take * multiplier;
      ep.commission += commissionPerUnit * take;
      ep.exitLegs.push({ time: fill.time, price: fill.price, quantity: take });
      ep.exitQty += take;
      ep.exitNotional += fill.price * take;

      lot.remaining -= take;
      if (lot.remaining <= 1e-9) lots.shift();
      remaining -= take;

      // IBKR's realized P&L is reported per FILL, so credit it once — on the
      // slice that finishes consuming this fill's contribution.
      if (remaining <= 1e-9) {
        if (fill.realizedPnl != null) ep.ibkrRealized += fill.realizedPnl;
        else ep.ibkrRealizedComplete = false;
      }

      // Flat again → the episode is a completed trade.
      if (lots.length === 0) {
        out.push(finalizeEpisode(ep, key, fill, multiplier));
        episodeByContract.delete(key);
        lotsByContract.set(key, lots);
      }
    }
  }

  return out.sort((a, b) => a.exitTime - b.exitTime || a.id.localeCompare(b.id));
}

function bumpSeq(seqByContract: Map<string, number>, key: string): number {
  const next = (seqByContract.get(key) ?? 0) + 1;
  seqByContract.set(key, next);
  return next;
}

function startEpisode(direction: 'long' | 'short', seq: number): Episode {
  return {
    direction,
    entryLegs: [],
    exitLegs: [],
    grossPnl: 0,
    commission: 0,
    entryQty: 0,
    exitQty: 0,
    entryNotional: 0,
    exitNotional: 0,
    ibkrRealized: 0,
    ibkrRealizedComplete: true,
    seq,
  };
}

function finalizeEpisode(
  ep: Episode,
  key: string,
  lastFill: MatchableFill,
  multiplier: number
): MatchedTrade {
  // Entry legs may include quantity that was never closed only if the position
  // ended flat, which is exactly when we finalize — so entryQty === exitQty.
  const quantity = ep.exitQty;
  const entryTime = ep.entryLegs[0]?.time ?? lastFill.time;
  const exitTime = ep.exitLegs[ep.exitLegs.length - 1]?.time ?? lastFill.time;
  const entryPrice = ep.entryQty ? ep.entryNotional / ep.entryQty : 0;
  const exitPrice = ep.exitQty ? ep.exitNotional / ep.exitQty : 0;

  const useIbkr = ep.ibkrRealizedComplete && ep.ibkrRealized !== 0;
  const commission = ep.commission;

  // IBKR's realized P&L is already NET of commissions — both the TWS API's
  // commissionReport and Flex's fifoPnlRealized. Verified against price math on
  // real fills: NVDA 225C bought 1.53 / sold 1.71 is 18.00 gross, commissions
  // 2.087413, and IBKR reports exactly 15.912587. Subtracting commissions from
  // it again (as this did) understated every trade by its own fees.
  //
  // Our own FIFO figure, by contrast, is gross and does need them taken off.
  const pnl = useIbkr ? ep.ibkrRealized : ep.grossPnl - commission;
  const grossPnl = useIbkr ? ep.ibkrRealized + commission : ep.grossPnl;

  return {
    id: `${key}#${ep.seq}@${exitTime}`,
    date: etDay(exitTime),
    openDate: etDay(entryTime),
    symbol: lastFill.symbol,
    secType: lastFill.secType,
    direction: ep.direction,
    quantity,
    multiplier,
    entryTime,
    exitTime,
    entryPrice: Math.round(entryPrice * 10_000) / 10_000,
    exitPrice: Math.round(exitPrice * 10_000) / 10_000,
    grossPnl: round2(grossPnl),
    commission: round2(commission),
    pnl: round2(pnl),
    pnlSource: useIbkr ? 'ibkr' : 'computed',
    entryLegs: ep.entryLegs,
    exitLegs: ep.exitLegs,
    strike: lastFill.strike,
    right: lastFill.right,
    expiry: lastFill.expiry,
    source: lastFill.source,
  };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Roll matched trades into per-day summaries, keyed by the ET date the trade
 * CLOSED (where the realized P&L is booked, matching IBKR's statements).
 */
export function summarizeByDay(trades: MatchedTrade[]): TradeDaySummary[] {
  const byDate = new Map<string, MatchedTrade[]>();
  for (const t of trades) {
    const arr = byDate.get(t.date);
    if (arr) arr.push(t);
    else byDate.set(t.date, [t]);
  }

  const out: TradeDaySummary[] = [];
  for (const [date, dayTrades] of byDate) {
    const wins = dayTrades.filter((t) => t.pnl > 0);
    const losses = dayTrades.filter((t) => t.pnl < 0);
    out.push({
      date,
      pnl: round2(dayTrades.reduce((a, t) => a + t.pnl, 0)),
      grossPnl: round2(dayTrades.reduce((a, t) => a + t.grossPnl, 0)),
      commissions: round2(dayTrades.reduce((a, t) => a + t.commission, 0)),
      trades: dayTrades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: dayTrades.length ? round2((wins.length / dayTrades.length) * 100) : 0,
      volume: dayTrades.reduce((a, t) => a + t.quantity, 0),
      grossWin: round2(wins.reduce((a, t) => a + t.pnl, 0)),
      grossLoss: round2(losses.reduce((a, t) => a + t.pnl, 0)),
      // A day is 'flex' only if every trade in it came from the statement.
      source: dayTrades.every((t) => t.source === 'flex') ? 'flex' : 'local',
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Longest run of consecutive TRADING days (days present in the list) whose net
 * P&L matched `sign`. Calendar gaps — weekends, holidays, days you didn't
 * trade — don't break a streak, which is how traders count them.
 */
export function maxConsecutiveDays(days: TradeDaySummary[], sign: 'win' | 'loss'): number {
  const ordered = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let best = 0;
  let run = 0;
  for (const d of ordered) {
    const hit = sign === 'win' ? d.pnl > 0 : d.pnl < 0;
    run = hit ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}
