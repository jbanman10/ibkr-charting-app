/**
 * Unit tests for the FIFO trade matcher.
 *
 *   npm run test --workspace=apps/backend
 *
 * Run with Node's built-in test runner via tsx (no test framework dependency).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchTrades, summarizeByDay, maxConsecutiveDays, contractKey, defaultMultiplier } from './tradeMatcher.js';
import type { MatchableFill } from './tradeMatcher.js';
import type { TradeDaySummary } from '@ibkr-chart/types';

// 2026-07-23 09:30:00 ET
const T0 = 1784815337;

let seq = 0;
function fill(over: Partial<MatchableFill> = {}): MatchableFill {
  seq++;
  return {
    id: `e${seq}`,
    time: T0 + seq * 60,
    symbol: 'AMZN',
    secType: 'OPT',
    side: 'BOT',
    price: 1,
    quantity: 1,
    source: 'local',
    ...over,
  };
}

test('contract identity separates option series on the same underlying', () => {
  const a = fill({ strike: 230, right: 'C', expiry: '20260724' });
  const b = fill({ strike: 235, right: 'C', expiry: '20260724' });
  assert.notEqual(contractKey(a), contractKey(b));
  assert.equal(contractKey(a), contractKey({ ...b, strike: 230 }));
});

test('options carry a 100x multiplier, stock 1x', () => {
  assert.equal(defaultMultiplier('OPT'), 100);
  assert.equal(defaultMultiplier('FOP'), 100);
  assert.equal(defaultMultiplier('STK'), 1);
});

test('simple long round-trip', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1 }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.direction, 'long');
  assert.equal(t.quantity, 1);
  assert.equal(t.entryPrice, 1.0);
  assert.equal(t.exitPrice, 1.5);
  // (1.50 − 1.00) × 1 × 100
  assert.equal(t.grossPnl, 50);
  assert.equal(t.pnlSource, 'computed');
});

test('scale-out: one buy closed by two sells is ONE trade with a weighted exit', () => {
  // Straight from the user's executions.json: AMZN 232.5P, BOT 2 @1.15,
  // SLD 1 @1.33, SLD 1 @1.23.
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.15, quantity: 2, strike: 232.5, right: 'P', expiry: '20260724' }),
    fill({ side: 'SLD', price: 1.33, quantity: 1, strike: 232.5, right: 'P', expiry: '20260724' }),
    fill({ side: 'SLD', price: 1.23, quantity: 1, strike: 232.5, right: 'P', expiry: '20260724' }),
  ]);
  assert.equal(trades.length, 1, 'a scale-out is one trade, not two');
  const t = trades[0];
  assert.equal(t.quantity, 2);
  assert.equal(t.entryPrice, 1.15);
  assert.equal(t.exitPrice, 1.28);            // (1.33 + 1.23) / 2
  assert.equal(t.grossPnl, 26);               // (0.18 + 0.08) × 100
  assert.equal(t.entryLegs.length, 1);
  assert.equal(t.exitLegs.length, 2, 'both trims survive for charting');
  assert.equal(t.exitTime, t.exitLegs[1].time, 'exit time is the LAST trim');
});

test('scale-in: two buys closed by one sell is ONE trade with a weighted entry', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.00, quantity: 1 }),
    fill({ side: 'BOT', price: 1.50, quantity: 3 }),
    fill({ side: 'SLD', price: 2.00, quantity: 4 }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.quantity, 4);
  assert.equal(t.entryPrice, 1.375);          // (1.00 + 4.50) / 4
  assert.equal(t.exitPrice, 2);
  // FIFO: (2.00−1.00)×1 + (2.00−1.50)×3 = 2.50 → ×100
  assert.equal(t.grossPnl, 250);
  assert.equal(t.entryLegs.length, 2);
});

test('partial fills: a position still open emits nothing', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 3 }),
    fill({ side: 'SLD', price: 1.2, quantity: 1 }),
  ]);
  assert.equal(trades.length, 0, 'still long 2 — no realized round-trip yet');
});

test('short round-trip profits when price falls', () => {
  const trades = matchTrades([
    fill({ side: 'SLD', price: 2.0, quantity: 2 }),
    fill({ side: 'BOT', price: 1.5, quantity: 2 }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.direction, 'short');
  assert.equal(t.grossPnl, 100);              // (2.00 − 1.50) × 2 × 100
});

test('a fill that flips through flat splits into two episodes', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 2 }),
    fill({ side: 'SLD', price: 1.5, quantity: 5 }),   // closes 2 long, opens 3 short
    fill({ side: 'BOT', price: 1.0, quantity: 3 }),   // closes the short
  ]);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].direction, 'long');
  assert.equal(trades[0].quantity, 2);
  assert.equal(trades[0].grossPnl, 100);             // (1.50−1.00)×2×100
  assert.equal(trades[1].direction, 'short');
  assert.equal(trades[1].quantity, 3);
  assert.equal(trades[1].grossPnl, 150);             // (1.50−1.00)×3×100
});

test('separate contracts do not net against each other', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1, strike: 230, right: 'C' }),
    fill({ side: 'BOT', price: 2.0, quantity: 1, strike: 235, right: 'C' }),
    fill({ side: 'SLD', price: 1.5, quantity: 1, strike: 230, right: 'C' }),
    fill({ side: 'SLD', price: 1.0, quantity: 1, strike: 235, right: 'C' }),
  ]);
  assert.equal(trades.length, 2);
  const byStrike = new Map(trades.map((t) => [t.strike, t]));
  assert.equal(byStrike.get(230)!.grossPnl, 50);
  assert.equal(byStrike.get(235)!.grossPnl, -100);
});

test('re-entering the same contract makes a second trade', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1 }),
    fill({ side: 'SLD', price: 1.2, quantity: 1 }),
    fill({ side: 'BOT', price: 1.1, quantity: 1 }),
    fill({ side: 'SLD', price: 0.9, quantity: 1 }),
  ]);
  assert.equal(trades.length, 2);
  assert.notEqual(trades[0].id, trades[1].id, 'ids stay unique per episode');
  assert.equal(trades[0].grossPnl, 20);
  assert.equal(trades[1].grossPnl, -20);
});

test('commission is pro-rated across a partially consumed fill', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 2, commission: 2.0 }),
    fill({ side: 'SLD', price: 1.0, quantity: 1, commission: 1.0 }),
    fill({ side: 'SLD', price: 1.0, quantity: 1, commission: 1.0 }),
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].commission, 4.0, 'entry 2.00 + both exits 1.00 each');
  assert.equal(trades[0].pnl, -4.0, 'flat price, so P&L is pure cost');
});

test("IBKR's own realized P&L wins over price math when every exit reports it", () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1, realizedPnl: 42.5 }),
  ]);
  assert.equal(trades[0].pnlSource, 'ibkr');
  assert.equal(trades[0].pnl, 42.5, 'IBKR knows the true cost basis');
});

// Regression: IBKR's realized P&L is ALREADY net of commissions, so taking the
// fees off it again understated every trade by its own fees. Numbers below are
// real fills from the account.
test("IBKR's realized P&L is net — commissions are not deducted twice", () => {
  // NVDA 225C: BOT 1 @1.53 (comm 1.0333), SLD 1 @1.71 (comm 1.054113).
  // Gross price math 18.00, fees 2.087413, and IBKR reports 15.912587.
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.53, quantity: 1, commission: 1.0333 }),
    fill({ side: 'SLD', price: 1.71, quantity: 1, commission: 1.054113, realizedPnl: 15.912587 }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.pnlSource, 'ibkr');
  assert.equal(t.pnl, 15.91, 'net P&L is IBKR\'s figure as-is');
  assert.equal(t.commission, 2.09);
  assert.equal(t.grossPnl, 18, 'gross adds the fees back, matching price math');
  // The invariant that makes the two paths consistent.
  assert.ok(Math.abs(t.grossPnl - t.commission - t.pnl) < 0.01, 'gross − fees === net');
});

test('the computed path still subtracts commissions (it is gross)', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.53, quantity: 1, commission: 1.0333 }),
    fill({ side: 'SLD', price: 1.71, quantity: 1, commission: 1.054113 }), // no IBKR figure
  ]);
  const t = trades[0];
  assert.equal(t.pnlSource, 'computed');
  assert.equal(t.grossPnl, 18);
  assert.equal(t.commission, 2.09);
  assert.equal(t.pnl, 15.91, 'same answer as IBKR reaches, via price math');
});

test('a scaled trade reconciles to IBKR across multiple closing fills', () => {
  // NVDA 200C: BOT 1 @1.13 (0.3473) + BOT 1 @1.13 (1.04028),
  // SLD 1 @1.32 (1.475479, realized 16.830731), SLD 1 @1.20 (1.048062, realized 5.258148).
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.13, quantity: 1, commission: 0.3473 }),
    fill({ side: 'BOT', price: 1.13, quantity: 1, commission: 1.04028 }),
    fill({ side: 'SLD', price: 1.32, quantity: 1, commission: 1.475479, realizedPnl: 16.830731 }),
    fill({ side: 'SLD', price: 1.20, quantity: 1, commission: 1.048062, realizedPnl: 5.258148 }),
  ]);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.pnl, 22.09, 'sum of IBKR realized, not reduced again');
  assert.equal(t.commission, 3.91);
  assert.equal(t.grossPnl, 26, '(1.32−1.13)×100 + (1.20−1.13)×100');
});

test('one exit missing realized P&L falls back to computed for the whole trade', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 2 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1, realizedPnl: 50 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1 }),  // no report
  ]);
  assert.equal(trades[0].pnlSource, 'computed');
  assert.equal(trades[0].grossPnl, 100);
});

test('commission is pro-rated and only counted once on the computed path', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 2, commission: 2.0 }),
    fill({ side: 'SLD', price: 1.5, quantity: 2, commission: 2.0 }),
  ]);
  const t = trades[0];
  assert.equal(t.grossPnl, 100);
  assert.equal(t.commission, 4);
  assert.equal(t.pnl, 96);
});

test('out-of-order fills are sorted before matching', () => {
  const later = fill({ side: 'SLD', price: 1.5, quantity: 1, time: T0 + 500 });
  const earlier = fill({ side: 'BOT', price: 1.0, quantity: 1, time: T0 + 100 });
  const trades = matchTrades([later, earlier]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].direction, 'long', 'the buy is the entry despite input order');
  assert.equal(trades[0].grossPnl, 50);
});

test('stock trades use a 1x multiplier', () => {
  const trades = matchTrades([
    fill({ secType: 'STK', symbol: 'AAPL', side: 'BOT', price: 200, quantity: 100 }),
    fill({ secType: 'STK', symbol: 'AAPL', side: 'SLD', price: 201, quantity: 100 }),
  ]);
  assert.equal(trades[0].grossPnl, 100);
});

test('a trade held overnight books on its CLOSE date, not its open date', () => {
  // 2026-07-23 15:00 ET → 2026-07-24 10:00 ET
  const open = Date.parse('2026-07-23T19:00:00Z') / 1000;
  const close = Date.parse('2026-07-24T14:00:00Z') / 1000;
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1, time: open }),
    fill({ side: 'SLD', price: 1.5, quantity: 1, time: close }),
  ]);
  assert.equal(trades[0].openDate, '2026-07-23');
  assert.equal(trades[0].date, '2026-07-24');
});

test('a fill just after the ET close stays on that trading day', () => {
  // 2026-07-23 16:05 ET is 20:05 UTC — still Jul 23 in ET, and would be Jul 24
  // if bucketed in UTC.
  const t = Date.parse('2026-07-23T20:05:00Z') / 1000;
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1, time: t - 60 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1, time: t }),
  ]);
  assert.equal(trades[0].date, '2026-07-23');
});

test('day summary counts wins, losses and volume', () => {
  const trades = matchTrades([
    fill({ side: 'BOT', price: 1.0, quantity: 1 }),
    fill({ side: 'SLD', price: 1.5, quantity: 1 }),   // +50
    fill({ side: 'BOT', price: 2.0, quantity: 2 }),
    fill({ side: 'SLD', price: 1.5, quantity: 2 }),   // −100
  ]);
  const days = summarizeByDay(trades);
  assert.equal(days.length, 1);
  const d = days[0];
  assert.equal(d.trades, 2);
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 1);
  assert.equal(d.winRate, 50);
  assert.equal(d.volume, 3);
  assert.equal(d.pnl, -50);
  assert.equal(d.grossWin, 50);
  assert.equal(d.grossLoss, -100);
});

test('losing streaks skip non-trading days rather than breaking on them', () => {
  const day = (date: string, pnl: number): TradeDaySummary => ({
    date, pnl, grossPnl: pnl, commissions: 0, trades: 1,
    wins: pnl > 0 ? 1 : 0, losses: pnl < 0 ? 1 : 0,
    winRate: pnl > 0 ? 100 : 0, volume: 1,
    grossWin: pnl > 0 ? pnl : 0, grossLoss: pnl < 0 ? pnl : 0,
    source: 'local',
  });
  const days = [
    day('2026-07-20', -10),
    day('2026-07-21', -10),
    // Jul 22 not traded at all
    day('2026-07-23', -10),
    day('2026-07-24', 40),
    day('2026-07-27', -10),
  ];
  assert.equal(maxConsecutiveDays(days, 'loss'), 3);
  assert.equal(maxConsecutiveDays(days, 'win'), 1);
});
