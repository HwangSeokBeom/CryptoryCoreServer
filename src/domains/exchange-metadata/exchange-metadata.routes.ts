import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { getExchangeGuide, listExchangeGuides } from './exchange-metadata.service';
import type { ExchangeId } from '../../modules/private-account/exchange-connections.contract';

export async function exchangeMetadataRoutes(app: FastifyInstance) {
  app.get('/', async () => createSuccessResponse(listExchangeGuides()));

  app.get('/:exchange', async (request, reply) => {
    const { exchange } = request.params as { exchange: ExchangeId };
    try {
      return createSuccessResponse(getExchangeGuide(exchange));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
