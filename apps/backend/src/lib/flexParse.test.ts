/**
 * Tests for the Flex statement parser's per-fill detail extraction.
 *
 * These run against synthetic statement XML so the detail path is verified
 * without hitting IBKR (a real sync needs the user's token and burns a Flex
 * request). The attribute spellings below are the ones IBKR emits across the
 * common Activity query templates.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlexService, hasFlexDetail } from '../services/flex.service.js';
import { TradesService } from '../services/trades.service.js';
import { matchTrades } from './tradeMatcher.js';

const wrap = (rows: string) => `<?xml version="1.0"?>
<FlexQueryResponse><FlexStatements><FlexStatement><Trades>
${rows}
</Trades></FlexStatement></FlexStatements></FlexQueryResponse>`;

test('day-level rows still parse when the query lacks detail columns', () => {
  const rows = FlexService.parseTrades(wrap(
    `<Trade tradeDate="20260723" underlyingSymbol="AMZN" assetCategory="OPT" fifoPnlRealized="26.00" ibCommission="-2.10" />`
  ));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-07-23');
  assert.equal(rows[0].symbol, 'AMZN');
  assert.equal(rows[0].realizedPnl, 26);
  assert.equal(rows[0].commission, 2.1, 'commission is stored positive');
  assert.equal(hasFlexDetail(rows[0]), false);
});

test('detail columns are picked up and times resolve in exchange time', () => {
  const rows = FlexService.parseTrades(wrap(
    `<Trade levelOfDetail="EXECUTION" tradeID="9001" tradeDate="20260723" dateTime="20260723;103000"
            underlyingSymbol="AMZN" assetCategory="OPT" buySell="BUY" quantity="2" tradePrice="1.15"
            multiplier="100" strike="232.5" putCall="P" expiry="20260724"
            fifoPnlRealized="0" ibCommission="-1.38" />`
  ));
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(hasFlexDetail(r), true);
  assert.equal(r.id, '9001');
  assert.equal(r.side, 'BOT');
  assert.equal(r.quantity, 2);
  assert.equal(r.price, 1.15);
  assert.equal(r.multiplier, 100);
  assert.equal(r.strike, 232.5);
  assert.equal(r.right, 'P');
  assert.equal(r.expiry, '20260724');
  // 10:30 ET on 2026-07-23 is 14:30 UTC (EDT, UTC−4).
  assert.equal(new Date(r.time! * 1000).toISOString(), '2026-07-23T14:30:00.000Z');
});

test('the several dateTime spellings all parse', () => {
  for (const dt of ['20260723;103000', '20260723 10:30:00', '2026-07-23 10:30:00', '20260723;10:30:00']) {
    const [r] = FlexService.parseTrades(wrap(
      `<Trade tradeDate="20260723" dateTime="${dt}" symbol="AMZN" buySell="BUY" quantity="1" tradePrice="1" />`
    ));
    assert.equal(new Date(r.time! * 1000).toISOString(), '2026-07-23T14:30:00.000Z', `failed on "${dt}"`);
  }
});

test('a winter date uses EST, not a fixed offset', () => {
  const [r] = FlexService.parseTrades(wrap(
    `<Trade tradeDate="20260115" dateTime="20260115;103000" symbol="AMZN" buySell="BUY" quantity="1" tradePrice="1" />`
  ));
  // 10:30 EST is 15:30 UTC (UTC−5).
  assert.equal(new Date(r.time! * 1000).toISOString(), '2026-01-15T15:30:00.000Z');
});

test('EXECUTION rows win over duplicated ORDER rows', () => {
  const rows = FlexService.parseTrades(wrap(`
    <Trade levelOfDetail="ORDER" tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN"
           buySell="BUY" quantity="2" tradePrice="1.15" fifoPnlRealized="0" ibCommission="-1.38" />
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN"
           buySell="BUY" quantity="1" tradePrice="1.15" fifoPnlRealized="0" ibCommission="-0.69" />
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;103005" symbol="AMZN"
           buySell="BUY" quantity="1" tradePrice="1.15" fifoPnlRealized="0" ibCommission="-0.69" />
  `));
  assert.equal(rows.length, 2, 'the order-level duplicate must not be counted too');
  assert.equal(rows.reduce((a, r) => a + (r.quantity ?? 0), 0), 2);
});

test('CLOSED_LOT rows are never treated as fills', () => {
  const rows = FlexService.parseTrades(wrap(`
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN"
           buySell="BUY" quantity="1" tradePrice="1.15" />
    <Trade levelOfDetail="CLOSED_LOT" tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN"
           buySell="SELL" quantity="1" tradePrice="1.33" fifoPnlRealized="18" />
  `));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'BOT');
});

test('direction falls back to a signed quantity when buySell is absent', () => {
  const rows = FlexService.parseTrades(wrap(`
    <Trade tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN" quantity="2" tradePrice="1.15" />
    <Trade tradeDate="20260723" dateTime="20260723;103500" symbol="AMZN" quantity="-2" tradePrice="1.30" />
  `));
  assert.equal(rows[0].side, 'BOT');
  assert.equal(rows[1].side, 'SLD');
  assert.equal(rows[1].quantity, 2, 'quantity is stored absolute');
});

test('a detailed statement round-trips through the matcher', () => {
  const rows = FlexService.parseTrades(wrap(`
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;103000" underlyingSymbol="AMZN"
           assetCategory="OPT" buySell="BUY" quantity="2" tradePrice="1.15" multiplier="100"
           strike="232.5" putCall="P" expiry="20260724" fifoPnlRealized="0" ibCommission="-1.38" />
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;104000" underlyingSymbol="AMZN"
           assetCategory="OPT" buySell="SELL" quantity="1" tradePrice="1.33" multiplier="100"
           strike="232.5" putCall="P" expiry="20260724" fifoPnlRealized="18" ibCommission="-0.53" />
    <Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;104500" underlyingSymbol="AMZN"
           assetCategory="OPT" buySell="SELL" quantity="1" tradePrice="1.23" multiplier="100"
           strike="232.5" putCall="P" expiry="20260724" fifoPnlRealized="8" ibCommission="-0.53" />
  `));
  const { fills, detailAvailable } = TradesService.buildFills(rows, []);
  assert.equal(detailAvailable, true);
  assert.equal(fills.length, 3);

  const trades = matchTrades(fills);
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.symbol, 'AMZN');
  assert.equal(t.quantity, 2);
  assert.equal(t.date, '2026-07-23');
  assert.equal(t.pnlSource, 'ibkr', "IBKR's realized P&L is present on both exits");
  assert.equal(t.grossPnl, 26);
  assert.equal(t.commission, 2.44);
  assert.equal(t.pnl, 23.56);
});

test('local fills are dropped for dates the Flex statement already covers', () => {
  const flexRows = FlexService.parseTrades(wrap(
    `<Trade levelOfDetail="EXECUTION" tradeDate="20260723" dateTime="20260723;103000" symbol="AMZN"
            assetCategory="OPT" buySell="BUY" quantity="1" tradePrice="1.15" />`
  ));
  // 2026-07-23 10:30 ET and 2026-07-24 10:30 ET
  const covered = Date.parse('2026-07-23T14:30:00Z') / 1000;
  const notCovered = Date.parse('2026-07-24T14:30:00Z') / 1000;
  const { fills } = TradesService.buildFills(flexRows, [
    { execId: 'x1', time: covered, symbol: 'AMZN', secType: 'OPT', side: 'BOT', price: 1.15, quantity: 1 },
    { execId: 'x2', time: notCovered, symbol: 'AMZN', secType: 'OPT', side: 'BOT', price: 1.15, quantity: 1 },
  ]);
  const ids = fills.map((f) => f.id);
  assert.ok(!ids.includes('x1'), 'the duplicate on a Flex-covered day is dropped');
  assert.ok(ids.includes('x2'), 'the uncovered day still contributes');
});
