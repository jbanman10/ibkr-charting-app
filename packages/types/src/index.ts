// ─── Core market data types ─────────────────────────────────────────────────

export interface Bar {
  time: number;   // Unix timestamp (seconds)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  volume: number;
  timestamp: number; // Unix ms
}

// ─── Contract / Symbol ───────────────────────────────────────────────────────

export type SecType = 'STK' | 'FUT' | 'OPT' | 'CASH' | 'IND';

export interface Contract {
  symbol: string;
  secType: SecType;
  exchange: string;          // routing/data exchange — SMART for consolidated tape
  currency: string;
  primaryExchange?: string;  // listing exchange, for disambiguation only (never data)
  localSymbol?: string;      // e.g. "ESM4" for futures
  lastTradeDateOrContractMonth?: string;
  multiplier?: string;
}

export interface ContractSearchResult {
  conId: number;
  symbol: string;
  secType: SecType;
  exchange: string;
  currency: string;
  description: string;
}

// ─── Trade executions (fills) ────────────────────────────────────────────────

// A normalized account fill from IBKR (reqExecutions), including manual TWS
// orders. For options, `symbol` is the UNDERLYING ticker so fills can be
// drawn as arrows on the underlying's chart.
export interface TradeExecution {
  execId: string;
  time: number;              // unix seconds
  symbol: string;            // underlying ticker
  secType: string;           // 'OPT' | 'STK' | ...
  side: 'BOT' | 'SLD';
  price: number;             // fill price (option premium for OPT)
  quantity: number;
  strike?: number;           // options only
  right?: string;            // 'C' | 'P' (options only)
  expiry?: string;           // yyyymmdd (options only)
  // Filled in from IBKR's commissionReport (arrives just after the fill).
  // realizedPnl is only present on CLOSING fills.
  commission?: number;       // absolute cost of this fill
  realizedPnl?: number;      // IBKR's own FIFO realized P&L, gross of commission
}

// ─── P&L calendar ────────────────────────────────────────────────────────────

/** One trading day's realized performance, net of commissions. */
export interface DailyPnl {
  date: string;      // 'YYYY-MM-DD' (exchange/trade date)
  pnl: number;       // realized P&L net of commissions
  trades: number;    // round-trips (grouped per symbol per day)
  wins: number;      // round-trips that closed positive
  commissions: number;
  // Sum of winning / losing round-trips, so month stats (avg win, avg loss,
  // profit factor) are exact instead of inferred from the daily net.
  grossWin: number;  // ≥ 0
  grossLoss: number; // ≤ 0
  source: 'flex' | 'local';
}

export interface PnlCalendarResponse {
  days: DailyPnl[];
  /** Last successful Flex sync (unix ms), null if never. */
  syncedAt: number | null;
  /** False until a Flex token + query id are saved. */
  flexConfigured: boolean;
}

export interface FlexConfig {
  token?: string;
  queryId?: string;
}

// ─── Trade journal (matched round-trips) ─────────────────────────────────────

/** One fill that contributed to a round-trip's entry or exit. */
export interface TradeLeg {
  time: number;      // unix seconds
  price: number;
  quantity: number;  // contracts/shares consumed by THIS trade (may be a
                     // partial slice of a larger fill on a scale-out)
}

/**
 * A completed round-trip: a position on one contract taken from flat back to
 * flat. Scale-ins and scale-outs collapse into a single trade whose entry/exit
 * prices are quantity-weighted averages; the individual fills survive in
 * `entryLegs`/`exitLegs` for charting.
 */
export interface MatchedTrade {
  id: string;
  /** ET calendar date the trade was CLOSED (where its P&L is booked). */
  date: string;              // YYYY-MM-DD
  /** ET calendar date the position was opened (differs on overnight holds). */
  openDate: string;
  symbol: string;            // underlying for options
  secType: string;
  direction: 'long' | 'short';
  quantity: number;          // contracts/shares round-tripped
  multiplier: number;        // 100 for options, 1 for stock
  entryTime: number;         // unix seconds, first entry fill
  exitTime: number;          // unix seconds, last exit fill
  entryPrice: number;        // quantity-weighted average
  exitPrice: number;         // quantity-weighted average
  grossPnl: number;
  commission: number;
  pnl: number;               // net of commission
  /** 'ibkr' when taken from IBKR's own realized P&L, 'computed' when derived
   * from our FIFO price math (IBKR's cost basis can predate our data). */
  pnlSource: 'ibkr' | 'computed';
  entryLegs: TradeLeg[];
  exitLegs: TradeLeg[];
  strike?: number;
  right?: string;            // 'C' | 'P'
  expiry?: string;           // yyyymmdd
  source: 'flex' | 'local';
}

/** Per-day rollup of matched trades. */
export interface TradeDaySummary {
  date: string;              // YYYY-MM-DD (ET)
  pnl: number;               // realized, net of commissions
  grossPnl: number;
  commissions: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;           // 0–100
  volume: number;            // total contracts/shares round-tripped
  grossWin: number;          // ≥ 0
  grossLoss: number;         // ≤ 0
  source: 'flex' | 'local';
}

export interface TradesSummaryResponse {
  days: TradeDaySummary[];
  from: string;
  to: string;
  /** Last successful Flex sync (unix ms), null if never. */
  syncedAt: number | null;
  flexConfigured: boolean;
  /** True when the Flex statement lacks per-fill detail, so history is
   * day-level only and those days cannot be drilled into. */
  detailAvailable: boolean;
}

export interface TradesDayResponse {
  date: string;
  trades: MatchedTrade[];
  summary: TradeDaySummary | null;
}

/** Aggregate analytics over a date range (the stats tab). */
export interface TradeStatsResponse {
  from: string;
  to: string;
  totals: {
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    profitFactor: number | null;
    expectancy: number | null;   // average P&L per trade
    commissions: number;
  };
  /** Index 0 = Sunday … 6 = Saturday. */
  byDayOfWeek: Array<{ day: number; pnl: number; trades: number; wins: number }>;
  /** ET hour buckets (e.g. 9 = 09:00–09:59), keyed on the ENTRY time. */
  byHour: Array<{ hour: number; pnl: number; trades: number; wins: number }>;
  bySymbol: Array<{ symbol: string; pnl: number; trades: number; wins: number; volume: number }>;
  maxConsecutiveLosingDays: number;
  maxConsecutiveWinningDays: number;
  bestDay: { date: string; pnl: number } | null;
  worstDay: { date: string; pnl: number } | null;
}

// ─── Timeframe ───────────────────────────────────────────────────────────────

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w';

export interface TimeframeConfig {
  label: string;
  barSize: string;       // IBKR barSizeSetting format, e.g. "1 min"
  durationStr: string;   // IBKR durationStr, e.g. "1 D"
  seconds: number;       // Bar length in seconds (for WS update logic)
}

export const TIMEFRAMES: Record<Timeframe, TimeframeConfig> = {
  '1m':  { label: '1m',  barSize: '1 min',  durationStr: '2 D',  seconds: 60 },
  '5m':  { label: '5m',  barSize: '5 mins', durationStr: '5 D',  seconds: 300 },
  '15m': { label: '15m', barSize: '15 mins',durationStr: '10 D', seconds: 900 },
  '30m': { label: '30m', barSize: '30 mins',durationStr: '20 D', seconds: 1800 },
  '1h':  { label: '1h',  barSize: '1 hour', durationStr: '30 D', seconds: 3600 },
  '4h':  { label: '4h',  barSize: '4 hours',durationStr: '60 D', seconds: 14400 },
  '1d':  { label: '1D',  barSize: '1 day',  durationStr: '1 Y',  seconds: 86400 },
  '1w':  { label: '1W',  barSize: '1 week', durationStr: '5 Y',  seconds: 604800 },
};

// ─── WebSocket message protocol ──────────────────────────────────────────────

export type WsMessageType =
  | 'subscribe'
  | 'unsubscribe'
  | 'watch'
  | 'snapshot'
  | 'tick'
  | 'bar_update'
  | 'bar_close'
  | 'executions'
  | 'quote'
  | 'status'
  | 'error';

// Client → Server
export interface WsSubscribeMsg {
  type: 'subscribe';
  symbol: string;
  secType: SecType;
  exchange: string;
  currency: string;
  timeframe: Timeframe;
  useRTH?: 0 | 1; // 1 = RTH only, 0 = include extended hours. Matches the
                  // historical fetch so live bars use the same session. Default 1.
  subId?: string; // Unique per-panel subscription id. Without it, subscriptions
                  // key by symbol and two panels showing the same symbol stomp
                  // each other's stream (one panel silently starves).
  primaryExchange?: string; // Listing exchange for disambiguation; data always
                            // routes via `exchange` (SMART = consolidated tape).
}

export interface WsUnsubscribeMsg {
  type: 'unsubscribe';
  symbol: string;
  subId?: string; // Must match the subscribe's subId (falls back to symbol key).
}

// Watchlist real-time quotes. The client sends its FULL desired symbol set
// (idempotent — the server diffs it against what this connection already holds),
// and the backend keeps one ref-counted reqMktData line per distinct symbol.
export interface WsWatchMsg {
  type: 'watch';
  symbols: string[];
}

export type WsClientMsg = WsSubscribeMsg | WsUnsubscribeMsg | WsWatchMsg;

// Server → Client
export interface WsSnapshotMsg {
  type: 'snapshot';     // Initial history for a subscription (keepUpToDate batch)
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

export interface WsTickMsg {
  type: 'tick';
  symbol: string;
  tick: Tick;
}

export interface WsBarUpdateMsg {
  type: 'bar_update';   // Live bar still forming
  symbol: string;
  timeframe: Timeframe;
  bar: Bar;
}

export interface WsBarCloseMsg {
  type: 'bar_close';    // Bar finalized
  symbol: string;
  timeframe: Timeframe;
  bar: Bar;
}

export interface WsExecutionsMsg {
  type: 'executions';  // new account fills discovered by the backend poll
  executions: TradeExecution[];
}

// Live watchlist price. Deliberately price-only: today's volume and RVOL still
// come from the slower /api/quotes poll (they need daily bars anyway), while
// last/change/% update in real time from the market-data line.
export interface WsQuoteMsg {
  type: 'quote';
  symbol: string;
  last: number;
  prevClose: number | null; // IBKR's CLOSE tick (previous session's close)
}

export interface WsStatusMsg {
  type: 'status';
  connected: boolean;
  message: string;
}

export interface WsErrorMsg {
  type: 'error';
  code: number;
  message: string;
}

export type WsServerMsg =
  | WsSnapshotMsg
  | WsTickMsg
  | WsBarUpdateMsg
  | WsBarCloseMsg
  | WsExecutionsMsg
  | WsQuoteMsg
  | WsStatusMsg
  | WsErrorMsg;

// ─── REST API shapes ─────────────────────────────────────────────────────────

export interface BarsResponse {
  symbol: string;
  timeframe: Timeframe;
  bars: Bar[];
}

export interface SearchResponse {
  results: ContractSearchResult[];
}

// A lightweight quote for the watchlist: last print, change vs previous RTH
// close, and today's cumulative (extended-hours) volume.
export interface Quote {
  symbol: string;
  last: number;
  prevClose: number;
  change: number;
  changePct: number;
  volume: number;
  rvol?: number; // session-adjusted relative volume (vs normal pace for this time of day)
}

// Per-symbol result: either a Quote or an error (bad symbol, no data, etc.).
export type QuoteResult = Quote | { symbol: string; error: string };

export interface QuotesResponse {
  quotes: QuoteResult[];
}

// ─── Earnings ────────────────────────────────────────────────────────────────

/** A reported quarter: when it was announced and how it landed vs consensus. */
export interface EarningsEvent {
  date: number;             // unix seconds (UTC midnight of the report date)
  fiscalQtr: string;        // e.g. "Mar 2026"
  eps: number | null;       // reported EPS
  consensus: number | null; // consensus forecast
  surprisePct: number | null;
}

export interface EarningsInfo {
  symbol: string;
  next: {
    date: number;           // unix seconds (UTC midnight)
    timing: string | null;  // 'after market close' | 'before market open' | null
    consensusEps: number | null;
    // true = projected from the reporting cadence because the vendor hasn't
    // published a date yet; flips to false once the real date is announced.
    estimated: boolean;
  } | null;
  history: EarningsEvent[]; // most recent first
}

// ─── Indicator types ─────────────────────────────────────────────────────────

export type IndicatorType = 'SMA' | 'EMA' | 'BB';

export interface IndicatorConfig {
  type: IndicatorType;
  period: number;
  color: string;
  visible: boolean;
  lineWidth?: number; // 1–4, default 1
  // Bollinger Bands only: standard-deviation multiplier (TradingView default 2)
  // and the middle band's colour (`color` styles the upper/lower bands + fill).
  stdDev?: number;
  basisColor?: string;
  // 'daily' = computed on DAILY bars and projected onto the panel's timeframe
  // (a 200-day MA shown as a stepped level on the 1m/30m). Absent = 'chart'
  // (computed on the panel's own bars, the classic behavior).
  source?: 'chart' | 'daily';
}
