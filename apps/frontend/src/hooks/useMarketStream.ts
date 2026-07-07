import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WsServerMsg,
  WsClientMsg,
  Bar,
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
  const pendingSubscription = useRef<WsClientMsg | null>(null);
  const optsRef = useRef(opts);

  // Keep opts ref current without restarting effect
  useEffect(() => { optsRef.current = opts; });

  const send = useCallback((msg: WsClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    } else {
      // Queue so it fires on reconnect
      pendingSubscription.current = msg;
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;
    setStatus('connecting');

    ws.onopen = () => {
      reconnectCount.current = 0;
      setStatus('connected');
      // Flush any queued subscription
      if (pendingSubscription.current) {
        ws.send(JSON.stringify(pendingSubscription.current));
        pendingSubscription.current = null;
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
