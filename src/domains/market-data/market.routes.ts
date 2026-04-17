import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { getCandles, getOrderbook, getTickers, getTrades, listMarkets } from './market-data.service';
import type { ExchangeId } from '../../core/exchange/exchange.types';

const VALID_EXCHANGES = new Set<ExchangeId>(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);

function parseExchange(exchange: string | undefined) {
  if (!exchange) return null;
  return VALID_EXCHANGES.has(exchange as ExchangeId) ? (exchange as ExchangeId) : null;
}

export async function marketRoutes(app: FastifyInstance) {
  app.get('/markets', async (request, reply) => {
    const { exchange } = request.query as { exchange?: string };
    if (exchange && !parseExchange(exchange)) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await listMarkets(parseExchange(exchange) ?? undefined));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.get('/tickers', async (request, reply) => {
    const { exchange, symbol } = request.query as { exchange?: string; symbol?: string };
    if (exchange && !parseExchange(exchange)) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getTickers({ exchange: parseExchange(exchange) ?? undefined, symbol }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.get('/orderbook', async (request, reply) => {
    const { exchange, symbol } = request.query as { exchange?: string; symbol?: string };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getOrderbook(parsedExchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.get('/trades', async (request, reply) => {
    const { exchange, symbol, limit } = request.query as { exchange?: string; symbol?: string; limit?: string };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getTrades(parsedExchange, symbol, limit ? parseInt(limit, 10) : 50));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.get('/candles', async (request, reply) => {
    const { exchange, symbol, interval, limit } = request.query as {
      exchange?: string;
      symbol?: string;
      interval?: string;
      limit?: string;
    };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(
        await getCandles(parsedExchange, symbol, interval ?? '1h', limit ? parseInt(limit, 10) : 60),
      );
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });
}
