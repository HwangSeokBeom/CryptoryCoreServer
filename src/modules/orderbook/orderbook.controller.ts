import { FastifyInstance } from 'fastify';
import { getOrderbook } from './orderbook.service';
import { createSuccessResponse, createErrorResponse } from '../../utils/errors';

export async function orderbookRoutes(app: FastifyInstance) {
  app.get('/api/v1/orderbook', async (request, reply) => {
    const { symbol, exchange, depth } = request.query as {
      symbol?: string;
      exchange?: string;
      depth?: string;
    };

    if (!symbol || !exchange) {
      return reply.status(400).send(createErrorResponse('symbol and exchange are required'));
    }

    const orderbook = await getOrderbook(symbol, exchange, depth ? parseInt(depth, 10) : 10);
    if (!orderbook) {
      return reply.status(404).send(createErrorResponse('Orderbook not found'));
    }
    return createSuccessResponse(orderbook);
  });
}
