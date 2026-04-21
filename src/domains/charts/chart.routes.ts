import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { getChartCandles } from './chart.service';

const VALID_EXCHANGES = new Set<ExchangeId>(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);

function parseExchange(exchange: string | undefined) {
  if (!exchange) return null;
  return VALID_EXCHANGES.has(exchange as ExchangeId) ? (exchange as ExchangeId) : null;
}

export async function chartRoutes(app: FastifyInstance) {
  app.get('/candles', async (request, reply) => {
    const { exchange, symbol, marketId, interval, limit } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
      interval?: string;
      limit?: string;
    };

    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getChartCandles({
        exchange: parsedExchange,
        symbol,
        marketId,
        interval: interval ?? '1m',
        limit: limit ? Number.parseInt(limit, 10) : 200,
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
