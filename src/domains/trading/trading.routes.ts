import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import {
  cancelTradingOrder,
  createTradingOrder,
  getOpenOrders,
  getOrderChance,
  getRecentFills,
  getTradingOrder,
} from './trading.service';

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
    const { exchange, symbol } = request.query as { exchange?: ExchangeId; symbol?: string };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }

    try {
      return createSuccessResponse(await getOrderChance(request.user.id, exchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.post('/orders', async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      return createSuccessResponse(await createTradingOrder(request.user.id, parsed.data));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.delete('/orders/:exchange/:orderId', async (request, reply) => {
    const { exchange, orderId } = request.params as { exchange: ExchangeId; orderId: string };
    const { symbol } = request.query as { symbol?: string };
    try {
      return createSuccessResponse(await cancelTradingOrder(request.user.id, exchange, orderId, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/orders/:exchange/:orderId', async (request, reply) => {
    const { exchange, orderId } = request.params as { exchange: ExchangeId; orderId: string };
    const { symbol } = request.query as { symbol?: string };
    try {
      return createSuccessResponse(await getTradingOrder(request.user.id, exchange, orderId, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/open-orders', async (request, reply) => {
    const { exchange, symbol } = request.query as { exchange?: ExchangeId; symbol?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required'));
    }
    try {
      return createSuccessResponse(await getOpenOrders(request.user.id, exchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/fills', async (request, reply) => {
    const { exchange, symbol, limit } = request.query as { exchange?: ExchangeId; symbol?: string; limit?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required'));
    }
    try {
      return createSuccessResponse(await getRecentFills(request.user.id, exchange, symbol, limit ? parseInt(limit, 10) : 50));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
