import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import {
  createPriceAlert,
  deletePriceAlert,
  listPriceAlerts,
  updatePriceAlert,
} from './price-alert.service';
import {
  parseContractExchange,
  parseContractQuoteCurrency,
} from '../market-data/contracts/market-data-contract.service';

const createSchema = z.object({
  exchange: z.enum(['upbit', 'bithumb']),
  symbol: z.string().min(1),
  quoteCurrency: z.enum(['KRW', 'BTC']),
  condition: z.enum(['ABOVE', 'BELOW']),
  targetPrice: z.number().positive(),
  repeatMode: z.enum(['ONCE', 'REPEAT']).default('ONCE'),
  isActive: z.boolean().default(true),
});

const updateSchema = z.object({
  condition: z.enum(['ABOVE', 'BELOW']).optional(),
  targetPrice: z.number().positive().optional(),
  repeatMode: z.enum(['ONCE', 'REPEAT']).optional(),
  isActive: z.boolean().optional(),
});

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
}

function parseIsActive(value: string | undefined) {
  if (value === undefined) return undefined;
  return ['1', 'true', 'yes'].includes(value.toLowerCase());
}

export async function priceAlertRoutes(app: FastifyInstance) {
  app.get('/price', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const query = request.query as {
      symbol?: string;
      exchange?: string;
      quoteCurrency?: string;
      isActive?: string;
    };
    const exchange = query.exchange ? parseContractExchange(query.exchange) : null;
    const quoteCurrency = query.quoteCurrency ? parseContractQuoteCurrency(query.quoteCurrency) : null;
    if (query.exchange && !exchange) {
      return reply.status(400).send(createErrorResponse('exchange must be upbit or bithumb', undefined, 'INVALID_EXCHANGE'));
    }
    if (query.quoteCurrency && !quoteCurrency) {
      return reply.status(400).send(createErrorResponse('quoteCurrency must be KRW or BTC', undefined, 'INVALID_QUOTE_CURRENCY'));
    }
    return createSuccessResponse(await listPriceAlerts(request.user.id, {
      symbol: query.symbol,
      exchange: exchange ?? undefined,
      quoteCurrency: quoteCurrency ?? undefined,
      isActive: parseIsActive(query.isActive),
    }));
  });

  app.post('/price', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_PRICE_ALERT_REQUEST'));
    }
    try {
      return createSuccessResponse(await createPriceAlert({ userId: request.user.id, ...parsed.data }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
      }
      throw error;
    }
  });

  app.patch('/price/:alertId', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { alertId } = request.params as { alertId: string };
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_PRICE_ALERT_REQUEST'));
    }
    try {
      return createSuccessResponse(await updatePriceAlert(request.user.id, alertId, parsed.data));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
      }
      throw error;
    }
  });

  app.delete('/price/:alertId', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const { alertId } = request.params as { alertId: string };
    try {
      return createSuccessResponse(await deletePriceAlert(request.user.id, alertId));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
      }
      throw error;
    }
  });
}
