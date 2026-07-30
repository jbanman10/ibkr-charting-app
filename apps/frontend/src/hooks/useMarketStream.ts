import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WsServerMsg,
  WsClientMsg,
  Bar,
  Tick,
  Timeframe,
  SecType,
  TradeExecution,
  WsQuoteMsg,
} from '@ibkr-chart/types';

const WS_URL = import.meta.env.VITE_WS_URL ?? `ws://${window.location.host}/ws`;
const RECONNECT_DELAY_MS = 3_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export type StreamStatus = 'connecting' | 'connected' | 'disconnected' | 'ibkr_down';

export interface UseMarketStreamOptions {
  onSnapshot?: (symbol: string, bars: Bar[], timeframe: Timeframe) => void;
  onBarUpdate?: (symbol: string, bar: Bar, timeframe: Timeframe) => void;
  onBarClose?: (symbol: string, bar: Bar, timeframe: Timeframe) => void;
  onTick?: (tick: Tick) => void;
  onExecutions?: (executions: TradeExecution[]) => void;
  onQuote?: (quote: WsQuoteMsg) => void;
  onStatusChange?: (status: StreamStatus) => void;
}

export interface UseMarketStreamReturn {
  status: StreamStatus;
  ibkrConnected: boolean;
  subscribe: (symbol: string, secType: SecType, exchange: string, currency: string, timeframe: Timeframe, useRTH: 0 | 1 | undefined, subId: string, primaryExchange?: string) => void;
  unsubscribe: (symbol: string, subId: string) => void;
  /** Set the watchlist's live-quote symbol set (full set; idempotent). */
  watch: (symbols: string[]) => void;
}

export function useMarketStream(opts: UseMarketStreamOptions): UseMarketStreamReturn {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [ibkrConnected, setIbkrConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // All active subscriptions keyed by subId (one per panel), so EVERY panel is
  // re-subscribed on reconnect — and two panels holding the SAME symbol don't
  // overwrite/kill each other's entry (they'd starve one chart's stream).
  const activeSubs = useRef<Map<string, WsSubscribeMsg>>(new Map());
  // Latest watchlist symbol set, replayed on reconnect like the subscriptions.
  const watchedSymbols = useRef<string[]>([]);
  const optsRef = useRef(opts);

  // Keep opts ref current without restarting effect
  useEffect(() => { optsRef.current = opts; });

  const send = useCallback((msg: WsClientMsg) => {
    // Track subscribe/unsubscribe intent so we can replay it on reconnect.
    if (msg.type === 'subscribe') activeSubs.current.set(msg.subId ?? msg.symbol, msg);
    else if (msg.type === 'unsubscribe') activeSubs.current.delete(msg.subId ?? msg.symbol);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
    // If not open, the subscription is held in activeSubs and replayed on onopen.
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      reconnectCount.current = 0;
      setStatus('connected');
      // Re-subscribe every active panel so all charts get a fresh snapshot after
      // a (re)connect — not just the last one.
      for (const msg of activeSubs.current.values()) {
        ws.send(JSON.stringify(msg));
      }
      if (watchedSymbols.current.length) {
        ws.send(JSON.stringify({ type: 'watch', symbols: watchedSymbols.current }));
      }
    };

    ws.onclose = () => {
      if (reconnectCount.current >= MAX_RECONNECT_ATTEMPTS) {
        setStatus('disconnected');
        return;
      }
      const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, reconnectCount.current), 30_000);
      reconnectCount.current++;
      reconnectTimer.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror; handle reconnect there
    };

    ws.onmessage = (evt) => {
      let msg: WsServerMsg;
      try { msg = JSON.parse(evt.data as string); } catch { return; }

      const o = optsRef.current;
      switch (msg.type) {
        case 'snapshot':
          o.onSnapshot?.(msg.symbol, msg.bars, msg.timeframe);
          break;
        case 'tick':
          o.onTick?.(msg.tick);
          break;
        case 'bar_update':
          o.onBarUpdate?.(msg.symbol, msg.bar, msg.timeframe);
          break;
        case 'bar_close':
          o.onBarClose?.(msg.symbol, msg.bar, msg.timeframe);
          break;
        case 'executions':
          o.onExecutions?.(msg.executions);
          break;
        case 'quote':
          o.onQuote?.(msg);
          break;
        case 'status':
          setIbkrConnected(msg.connected);
          if (!msg.connected) setStatus('ibkr_down');
          else if (ws.readyState === WebSocket.OPEN) setStatus('connected');
          o.onStatusChange?.(msg.connected ? 'connected' : 'ibkr_down');
          break;
        case 'error':
          console.warn('[WS] IBKR error', msg.code, msg.message);
          break;
      }
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const subscribe = useCallback(
    (symbol: string, secType: SecType, exchange: string, currency: string, timeframe: Timeframe, useRTH: 0 | 1 = 1, subId: string, primaryExchange?: string) => {
      send({ type: 'subscribe', symbol, secType, exchange, currency, timeframe, useRTH, subId, primaryExchange });
    },
    [send]
  );

  const unsubscribe = useCallback((symbol: string, subId: string) => {
    send({ type: 'unsubscribe', symbol, subId });
  }, [send]);

  const watch = useCallback((symbols: string[]) => {
    watchedSymbols.current = symbols;
    send({ type: 'watch', symbols });
  }, [send]);

  return { status, ibkrConnected, subscribe, unsubscribe, watch };
}
