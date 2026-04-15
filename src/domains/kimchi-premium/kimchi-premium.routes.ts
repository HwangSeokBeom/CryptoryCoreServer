import type { FastifyInstance } from 'fastify';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { getKimchiPremium } from './kimchi-premium.service';

export async function kimchiPremiumRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const { symbols } = request.query as { symbols?: string };
    if (!symbols) {
      return reply.status(400).send(createErrorResponse('symbols query parameter is required'));
    }

    return createSuccessResponse(
      await getKimchiPremium(symbols.split(',').map((symbol) => symbol.trim()).filter(Boolean)),
    );
  });
}
