/**
 * WebSocketGateway
 *
 * Manages all connected WebSocket clients.
 * Each client sends a WsSubscribeMsg → backend calls MarketDataService.subscribeRealTime
 * and pipes bar/tick events back to that client (and only that client).
 *
 * Multiple clients can subscribe to the same symbol; each gets its own IBKR stream.
 * (IBKR allows many simultaneous subscriptions per client ID.)
 */

import type { WebSocket } from '@fastify/websocket';
import type { Logger } from 'pino';
import type {
  WsClientMsg,
  WsServerMsg,
  Bar,
  Tick,
  Timeframe,
} from '@ibkr-chart/types';
import { IBKRService } from './ibkr.service.js';
import { MarketDataService } from './market-data.service.js';

interface ClientSession {
  ws: WebSocket;
  // subId (or symbol when the client sends none) → unsubscribe fn. Keyed by the
  // client's per-panel subId so several panels on ONE connection can hold the
  // same symbol without replacing/killing each other's stream.
  subscriptions: Map<string, () => void>;
}

export class WebSocketGateway {
  private static instance: WebSocketGateway;
  private clients = new Map<WebSocket, ClientSession>();
  private ibkr: IBKRService;
  private marketData: MarketDataService;
  private logger: Logger;

  private constructor(ibkr: IBKRService, marketData: MarketDataService, logger: Logger) {
    this.ibkr = ibkr;
    this.marketData = marketData;
    this.logger = logger.child({ service: 'WebSocketGateway' });

    // Forward IBKR connection status to all clients
    this.ibkr.on('status', (status: { connected: boolean; message: string }) => {
      this.broadcast({ type: 'status', connected: status.connected, message: status.message });
    });

    this.ibkr.on('ibkr_error', (err: { code: number; reqId: number; message: string }) => {
      this.broadcast({ type: 'error', code: err.code, message: err.message });
    });
  }

  static getInstance(
    ibkr: IBKRService,
    marketData: MarketDataService,
    logger: Logger
  ): WebSocketGateway {
    if (!WebSocketGateway.instance) {
      WebSocketGateway.instance = new WebSocketGateway(ibkr, marketData, logger);
    }
    return WebSocketGateway.instance;
  }

  // ─── Called by Fastify route handler ───────────────────────────────────────

  handleConnection(ws: WebSocket): void {
    const session: ClientSession = { ws, subscriptions: new Map() };
    this.clients.set(ws, session);
    this.logger.info({ clients: this.clients.size }, 'WebSocket client connected');

    // Send current connection status immediately
    this.send(ws, {
      type: 'status',
      connected: this.ibkr.isConnected,
      message: this.ibkr.isConnected ? 'Connected to IBKR' : 'IBKR not connected',
    });

    ws.on('message', (raw) => this.handleMessage(ws, session, raw.toString()));
    ws.on('close', () => this.handleClose(ws, session));
    ws.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'WebSocket client error');
      this.handleClose(ws, session);
    });
  }

  // ─── Message handling ───────────────────────────────────────────────────────

  private handleMessage(ws: WebSocket, session: ClientSession, raw: string): void {
    let msg: WsClientMsg;
    try {
      msg = JSON.parse(raw) as WsClientMsg;
    } catch {
      this.send(ws, { type: 'error', code: 400, message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'subscribe':
        this.handleSubscribe(ws, session, msg.symbol, msg.secType, msg.exchange, msg.currency, msg.timeframe, msg.useRTH ?? 1, msg.subId);
        break;
      case 'unsubscribe':
        this.handleUnsubscribe(session, msg.subId ?? msg.symbol);
        break;
      default:
        this.send(ws, { type: 'error', code: 400, message: 'Unknown message type' });
    }
  }

  private handleSubscribe(
    ws: WebSocket,
    session: ClientSession,
    symbol: string,
    secType: string,
    exchange: string,
    currency: string,
    timeframe: Timeframe,
    useRTH: 0 | 1,
    subId?: string
  ): void {
    const key = subId ?? symbol;
    // Clean up any existing subscription under this key (same panel re-subscribing)
    this.handleUnsubscribe(session, key);

    if (!this.ibkr.isConnected) {
      this.send(ws, { type: 'error', code: 503, message: 'IBKR not connected' });
      return;
    }

    try {
      const contract = MarketDataService.toIBContract(symbol, secType as any, exchange, currency);

      const unsubscribe = this.marketData.subscribeRealTime(
        contract,
        timeframe,
        (bars: Bar[]) => {
          this.send(ws, { type: 'snapshot', symbol, timeframe, bars });
        },
        (bar: Bar, isClosed: boolean) => {
          this.send(ws, {
            type: isClosed ? 'bar_close' : 'bar_update',
            symbol,
            timeframe,
            bar,
          });
        },
        (tick: Tick) => {
          this.send(ws, { type: 'tick', symbol, tick });
        },
        useRTH
      );

      session.subscriptions.set(key, unsubscribe);
      this.logger.info({ symbol, timeframe, useRTH, subId }, 'Client subscribed');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Subscription failed';
      this.send(ws, { type: 'error', code: 500, message });
    }
  }

  private handleUnsubscribe(session: ClientSession, key: string): void {
    const unsub = session.subscriptions.get(key);
    if (unsub) {
      unsub();
      session.subscriptions.delete(key);
      this.logger.info({ key }, 'Client unsubscribed');
    }
  }

  private handleClose(ws: WebSocket, session: ClientSession): void {
    // Cancel all subscriptions for this client
    for (const [, unsub] of session.subscriptions) {
      unsub();
    }
    session.subscriptions.clear();
    this.clients.delete(ws);
    this.logger.info({ clients: this.clients.size }, 'WebSocket client disconnected');
  }

  // ─── Utilities ──────────────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: WsServerMsg): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to send WS message');
    }
  }

  private broadcast(msg: WsServerMsg): void {
    for (const [ws] of this.clients) {
      this.send(ws, msg);
    }
  }
}
