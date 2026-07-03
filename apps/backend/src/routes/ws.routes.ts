import type { FastifyInstance } from 'fastify';
import type { WebSocket } from '@fastify/websocket';
import { IBKRService } from '../services/ibkr.service.js';
import { MarketDataService } from '../services/market-data.service.js';
import { WebSocketGateway } from '../services/ws.gateway.js';

export async function registerWsRoute(app: FastifyInstance): Promise<void> {
  const ibkr = IBKRService.getInstance();
  const marketData = MarketDataService.getInstance(ibkr, app.log as any);
  const gateway = WebSocketGateway.getInstance(ibkr, marketData, app.log as any);

  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    gateway.handleConnection(socket);
  });
}
