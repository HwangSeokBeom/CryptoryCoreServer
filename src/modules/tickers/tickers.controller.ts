import { FastifyInstance } from 'fastify';
import { getTickersByExchange } from './tickers.service';
import { createSuccessResponse, createErrorResponse } from '../../utils/errors';

export async function tickersRoutes(app: FastifyInstance) {
  app.get('/api/v1/tickers', async (request, reply) => {
    const { exchange } = request.query as { exchange?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange query parameter is required'));
    }
    const tickers = await getTickersByExchange(exchange);
    return createSuccessResponse(tickers);
  });
}
