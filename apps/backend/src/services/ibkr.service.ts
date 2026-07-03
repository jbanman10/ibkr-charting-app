/**
 * IBKRService
 *
 * Wraps @stoqey/ib's IBApi to provide:
 *  - Automatic reconnection with exponential back-off
 *  - Typed event emitter for all IBKR callbacks
 *  - A single shared connection used by all other services
 *
 * Usage:
 *   const ibkr = IBKRService.getInstance();
 *   await ibkr.connect();
 *   const api = ibkr.api;  // IBApi instance, ready to use
 */

import { IBApi, EventName, ErrorCode, Contract as IBContract } from '@stoqey/ib';
import { EventEmitter } from 'node:events';
import { config } from '../config.js';
import type { Logger } from 'pino';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// Re-export the raw IBApi Contract type so callers don't need to import @stoqey/ib directly
export type { IBContract };

export class IBKRService extends EventEmitter {
  private static instance: IBKRService;

  public readonly api: IBApi;
  private _state: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private logger: Logger;

  private constructor(logger: Logger) {
    super();
    this.setMaxListeners(50); // Many services attach listeners

    this.logger = logger.child({ service: 'IBKRService' });

    this.api = new IBApi({
      host: config.ibkr.host,
      port: config.ibkr.port,
      clientId: config.ibkr.clientId,
    });

    this.bindApiEvents();
  }

  static getInstance(logger?: Logger): IBKRService {
    if (!IBKRService.instance) {
      if (!logger) throw new Error('Logger required for first IBKRService.getInstance() call');
      IBKRService.instance = new IBKRService(logger);
    }
    return IBKRService.instance;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get isConnected(): boolean {
    return this._state === 'connected';
  }

  // ─── Connection management ──────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._state === 'connected' || this._state === 'connecting') return;

    this._state = 'connecting';
    this.logger.info({ host: config.ibkr.host, port: config.ibkr.port }, 'Connecting to IBKR...');

    try {
      this.api.connect();
      // connected event fires via bindApiEvents → onConnected
    } catch (err) {
      this.logger.error(err, 'Failed to initiate IBKR connection');
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._state = 'disconnected';
    try {
      this.api.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.logger.info('Disconnected from IBKR');
    this.emit('status', { connected: false, message: 'Disconnected' });
  }

  // ─── Private event wiring ───────────────────────────────────────────────────

  private bindApiEvents(): void {
    this.api.on(EventName.connected, () => this.onConnected());
    this.api.on(EventName.disconnected, () => this.onDisconnected());
    this.api.on(EventName.error, (err: Error, code: ErrorCode, reqId: number) =>
      this.onError(err, code, reqId)
    );

    // Forward all raw IBKR events so other services can listen via ibkr.api.on(...)
    // No additional forwarding needed — consumers use ibkr.api.on() directly.
  }

  private onConnected(): void {
    this._state = 'connected';
    this.reconnectAttempts = 0;
    this.logger.info('Connected to IBKR TWS/Gateway');
    this.emit('status', { connected: true, message: 'Connected to IBKR' });
  }

  private onDisconnected(): void {
    if (this._state === 'disconnected') return; // intentional disconnect
    this._state = 'error';
    this.logger.warn('Disconnected unexpectedly from IBKR');
    this.emit('status', { connected: false, message: 'Connection lost' });
    this.scheduleReconnect();
  }

  private onError(err: Error, code: ErrorCode, reqId: number): void {
    // IBKR sends informational "errors" for things like market closed, etc.
    // Only treat real errors as reconnect triggers.
    const FATAL_CODES = [504, 502, 501, 1100, 1300, 2110];

    this.logger.error({ code, reqId, message: err.message }, 'IBKR error');
    this.emit('ibkr_error', { code, reqId, message: err.message });

    if (FATAL_CODES.includes(code)) {
      this._state = 'error';
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= config.ibkr.maxReconnectAttempts) {
      this.logger.error('Max reconnect attempts reached. Giving up.');
      this._state = 'error';
      this.emit('status', { connected: false, message: 'Max reconnect attempts reached' });
      return;
    }

    // Exponential back-off: 5s, 10s, 20s, 40s … capped at 60s
    const delay = Math.min(
      config.ibkr.reconnectDelay * Math.pow(2, this.reconnectAttempts),
      60_000
    );
    this.reconnectAttempts++;

    this.logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling IBKR reconnect'
    );

    this.reconnectTimer = setTimeout(() => {
      this._state = 'disconnected';
      this.connect();
    }, delay);
  }
}
