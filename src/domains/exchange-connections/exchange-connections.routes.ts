import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import {
  createExchangeConnection,
  listExchangeConnections,
  removeExchangeConnection,
  updateExchangeConnection,
  validateStoredExchangeConnection,
} from '../../modules/private-account/exchange-connections.service';
import {
  createExchangeConnectionRequestSchema,
  serializeExchangeConnectionListResponse,
  updateExchangeConnectionRequestSchema,
} from '../../modules/private-account/exchange-connections.contract';

export async function exchangeConnectionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => {
    const items = await listExchangeConnections(request.user.id);
    return createSuccessResponse(serializeExchangeConnectionListResponse(items));
  });

  app.post('/', async (request, reply) => {
    const parsed = createExchangeConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      return reply.status(201).send(createSuccessResponse(await createExchangeConnection(request.user.id, parsed.data)));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.post('/:id/validate', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return createSuccessResponse(await validateStoredExchangeConnection(request.user.id, id));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.patch('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = updateExchangeConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message));
    }

    try {
      return createSuccessResponse(await updateExchangeConnection(request.user.id, id, parsed.data));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });

  app.delete('/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return createSuccessResponse(await removeExchangeConnection(request.user.id, id));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message));
      }
      throw error;
    }
  });
}
