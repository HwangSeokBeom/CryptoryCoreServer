import { FastifyInstance } from 'fastify';
import { getCandles } from './candles.service';
import { createSuccessResponse, createErrorResponse } from '../../utils/errors';

export async function candlesRoutes(app: FastifyInstance) {
  app.get('/api/v1/candles', async (request, reply) => {
    const { symbol, exchange, period, limit } = request.query as {
      symbol?: string;
      exchange?: string;
      period?: string;
      limit?: string;
    };

    if (!symbol || !exchange) {
      return reply.status(400).send(createErrorResponse('symbol and exchange are required'));
    }

    const candles = await getCandles(
      symbol,
      exchange,
      period || '1h',
      limit ? parseInt(limit, 10) : 60,
    );
    return createSuccessResponse(candles);
  });
}
