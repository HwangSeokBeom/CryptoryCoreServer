import type { FastifyInstance } from 'fastify';
import { featureFlags } from '../../config/feature-flags';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { getNewsById, listNews } from './news.service';

export async function newsRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { coin, category, date, cursor, limit } = request.query as {
      coin?: string;
      category?: string;
      date?: string;
      cursor?: string;
      limit?: string;
    };

    return createSuccessResponse(listNews({
      coin,
      category,
      date,
      cursor,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    }));
  });

  app.get('/:newsId', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { newsId } = request.params as { newsId: string };
    const item = getNewsById(newsId);
    if (!item) {
      return reply.status(404).send(createErrorResponse('news not found', undefined, 'NEWS_NOT_FOUND'));
    }

    return createSuccessResponse(item);
  });
}
