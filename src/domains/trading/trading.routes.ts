import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { EXCHANGE_IDS, type ExchangeId } from '../../core/exchange/exchange.types';
import {
  cancelTradingOrder,
  createTradingOrder,
  getOpenOrders,
  getOrderChance,
  getRecentFills,
  getTradingOrder,
} from './trading.service';

function sendAppError(reply: { status: (statusCode: number) => { send: (payload: unknown) => unknown } }, error: AppError) {
  return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
}

function parseExchange(value: string | undefined): ExchangeId | null {
  if (!value || !EXCHANGE_IDS.includes(value as ExchangeId)) {
    return null;
  }
  return value as ExchangeId;
}

const createOrderSchema = z.object({
  exchange: z.enum(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']),
  symbol: z.string().trim().min(1),
  side: z.enum(['buy', 'sell']),
  type: z.enum(['market', 'limit', 'stop_limit']),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  clientOrderId: z.string().optional(),
}).superRefine((value, ctx) => {
  if (value.type === 'limit' && (!value.price || value.price <= 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'limit order requires a positive price',
      path: ['price'],
    });
  }
});

export async function tradingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/chance', async (request, reply) => {
    const { exchange: rawExchange, symbol } = request.query as { exchange?: string; symbol?: string };
    const exchange = parseExchange(rawExchange);
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required', {
        code: 'invalid_request',
        required: ['exchange', 'symbol'],
      }, 'invalid_request'));
    }

    try {
      return createSuccessResponse(await getOrderChance(request.user.id, exchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });

  app.post('/orders', async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, {
        code: 'invalid_request',
      }, 'invalid_request'));
    }

    try {
      return createSuccessResponse(await createTradingOrder(request.user.id, parsed.data));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });

  app.delete('/orders/:exchange/:orderId', async (request, reply) => {
    const { exchange: rawExchange, orderId } = request.params as { exchange: string; orderId: string };
    const exchange = parseExchange(rawExchange);
    const { symbol } = request.query as { symbol?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'invalid_request',
        required: ['exchange'],
      }, 'invalid_request'));
    }
    try {
      return createSuccessResponse(await cancelTradingOrder(request.user.id, exchange, orderId, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });

  app.get('/orders/:exchange/:orderId', async (request, reply) => {
    const { exchange: rawExchange, orderId } = request.params as { exchange: string; orderId: string };
    const exchange = parseExchange(rawExchange);
    const { symbol } = request.query as { symbol?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'invalid_request',
        required: ['exchange'],
      }, 'invalid_request'));
    }
    try {
      return createSuccessResponse(await getTradingOrder(request.user.id, exchange, orderId, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });

  app.get('/open-orders', async (request, reply) => {
    const { exchange: rawExchange, symbol } = request.query as { exchange?: string; symbol?: string };
    const exchange = parseExchange(rawExchange);
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'invalid_request',
        required: ['exchange'],
      }, 'invalid_request'));
    }
    try {
      return createSuccessResponse(await getOpenOrders(request.user.id, exchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });

  app.get('/fills', async (request, reply) => {
    const { exchange: rawExchange, symbol, limit } = request.query as { exchange?: string; symbol?: string; limit?: string };
    const exchange = parseExchange(rawExchange);
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'invalid_request',
        required: ['exchange'],
      }, 'invalid_request'));
    }
    const parsedLimit = limit ? parseInt(limit, 10) : 50;
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      return reply.status(400).send(createErrorResponse('limit must be a positive integer', {
        code: 'invalid_request',
        field: 'limit',
      }, 'invalid_request'));
    }
    try {
      return createSuccessResponse(await getRecentFills(request.user.id, exchange, symbol, parsedLimit));
    } catch (error) {
      if (error instanceof AppError) {
        return sendAppError(reply, error);
      }
      throw error;
    }
  });
}
