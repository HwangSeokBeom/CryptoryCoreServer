import { FastifyInstance } from 'fastify';
import { createOrder } from '../orders/orders.service';
import { CreateOrderInput } from '../orders/orders.schema';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  createExchangeConnection,
  listExchangeConnections,
  removeExchangeConnection,
  updateExchangeConnection,
  validateStoredExchangeConnection,
} from './exchange-connections.service';
import {
  createExchangeConnectionRequestSchema,
  serializeExchangeConnectionListResponse,
  updateExchangeConnectionRequestSchema,
} from './exchange-connections.contract';
import {
  getPrivateBalances,
  getPrivateFills,
  getPrivateHoldings,
  getPrivateOpenOrders,
  getPrivateOrders,
  getPrivatePortfolio,
  getPrivatePortfolioSummary,
} from './private-account.service';

export async function privateAccountRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    logger.info({ domain: 'private-account', method: request.method, url: request.url }, 'Handling private account route');
  });

  app.addHook('preHandler', app.authenticate);

  app.get('/exchange-connections', async (request) => {
    const connections = await listExchangeConnections(request.user.id);
    return createSuccessResponse(serializeExchangeConnectionListResponse(connections));
  });

  app.post('/exchange-connections', async (request, reply) => {
    const parsed = createExchangeConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const connection = await createExchangeConnection(request.user.id, parsed.data);
      return reply.status(201).send(createSuccessResponse(connection));
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.post('/exchange-connections/:id/validate', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const connection = await validateStoredExchangeConnection(request.user.id, id);
      return createSuccessResponse(connection);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.patch('/exchange-connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateExchangeConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const connection = await updateExchangeConnection(request.user.id, id, parsed.data);
      return createSuccessResponse(connection);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.delete('/exchange-connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const removed = await removeExchangeConnection(request.user.id, id);
      return createSuccessResponse(removed);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.get('/balances', async (request) => {
    const { exchange } = request.query as { exchange?: string };
    return createSuccessResponse(await getPrivateBalances(request.user.id, exchange ?? 'upbit'));
  });

  app.get('/holdings', async (request) => {
    const { exchange } = request.query as { exchange?: string };
    return createSuccessResponse(await getPrivateHoldings(request.user.id, exchange ?? 'upbit'));
  });

  app.get('/portfolio', async (request) => {
    const { exchange } = request.query as { exchange?: string };
    return createSuccessResponse(await getPrivatePortfolio(request.user.id, exchange ?? 'upbit'));
  });

  app.get('/portfolio/summary', async (request) => {
    const { exchange } = request.query as { exchange?: string };
    return createSuccessResponse(await getPrivatePortfolioSummary(request.user.id, exchange ?? 'upbit'));
  });

  app.post('/orders', async (request, reply) => {
    const parsed = CreateOrderInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      const result = await createOrder(request.user.id, parsed.data);
      return createSuccessResponse(result);
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message, err.details, err.code));
      }
      throw err;
    }
  });

  app.get('/orders', async (request) => {
    const { exchange, limit } = request.query as { exchange?: string; limit?: string };
    return createSuccessResponse(
      await getPrivateOrders(request.user.id, exchange, limit ? parseInt(limit, 10) : 50),
    );
  });

  app.get('/open-orders', async (request) => {
    const { exchange } = request.query as { exchange?: string };
    return createSuccessResponse(await getPrivateOpenOrders(request.user.id, exchange));
  });

  app.get('/fills', async (request) => {
    const { exchange, limit } = request.query as { exchange?: string; limit?: string };
    return createSuccessResponse(
      await getPrivateFills(request.user.id, exchange, limit ? parseInt(limit, 10) : 50),
    );
  });
}
