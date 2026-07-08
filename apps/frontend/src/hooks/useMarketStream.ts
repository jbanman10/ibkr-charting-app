import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WsServerMsg,
  WsClientMsg,
  Bar,
  Tick,
  Timeframe,
  SecType,
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
  onStatusChange?: (status: StreamStatus) => void;
}

export interface UseMarketStreamReturn {
  status: StreamStatus;
  ibkrConnected: boolean;
  subscribe: (symbol: string, secType: SecType, exchange: string, currency: string, timeframe: Timeframe, useRTH?: 0 | 1) => void;
  unsubscribe: (symbol: string) => void;
}

export function useMarketStream(opts: UseMarketStreamOptions): UseMarketStreamReturn {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [ibkrConnected, setIbkrConnected] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectCount = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // All active subscriptions keyed by symbol, so EVERY panel is re-subscribed on
  // reconnect (e.g. after a backend restart) — not just the most recent one.
  const activeSubs = useRef<Map<string, WsSubscribeMsg>>(new Map());
  const optsRef = useRef(opts);

  // Keep opts ref current without restarting effect
  useEffect(() => { optsRef.current = opts; });

  const send = useCallback((msg: WsClientMsg) => {
    // Track subscribe/unsubscribe intent so we can replay it on reconnect.
    if (msg.type === 'subscribe') activeSubs.current.set(msg.symbol, msg);
    else if (msg.type === 'unsubscribe') activeSubs.current.delete(msg.symbol);
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
    (symbol: string, secType: SecType, exchange: string, currency: string, timeframe: Timeframe, useRTH: 0 | 1 = 1) => {
      send({ type: 'subscribe', symbol, secType, exchange, currency, timeframe, useRTH });
    },
    [send]
  );

  const unsubscribe = useCallback((symbol: string) => {
    send({ type: 'unsubscribe', symbol });
  }, [send]);

  return { status, ibkrConnected, subscribe, unsubscribe };
}
