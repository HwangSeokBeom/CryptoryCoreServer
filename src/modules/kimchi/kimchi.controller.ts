import { FastifyInstance } from 'fastify';
import { getKimchiPremium } from './kimchi.service';
import { createSuccessResponse, createErrorResponse } from '../../utils/errors';

export async function kimchiRoutes(app: FastifyInstance) {
  app.get('/api/v1/kimchi-premium', async (request, reply) => {
    const { symbols } = request.query as { symbols?: string };
    if (!symbols) {
      return reply.status(400).send(createErrorResponse('symbols query parameter is required'));
    }

    const symbolList = symbols.split(',').map((s) => s.trim());
    const result = await getKimchiPremium(symbolList);
    return createSuccessResponse(result);
  });
}
