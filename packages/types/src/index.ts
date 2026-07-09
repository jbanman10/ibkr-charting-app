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
  | 'snapshot'
  | 'tick'
  | 'bar_update'
  | 'bar_close'
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

export type WsClientMsg = WsSubscribeMsg | WsUnsubscribeMsg;

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
}

// Per-symbol result: either a Quote or an error (bad symbol, no data, etc.).
export type QuoteResult = Quote | { symbol: string; error: string };

export interface QuotesResponse {
  quotes: QuoteResult[];
}

// ─── Indicator types ─────────────────────────────────────────────────────────

export type IndicatorType = 'SMA' | 'EMA';

export interface IndicatorConfig {
  type: IndicatorType;
  period: number;
  color: string;
  visible: boolean;
  lineWidth?: number; // 1–4, default 1
}
