import { FastifyInstance } from 'fastify';
import { addFavorite, removeFavorite, getFavorites } from './favorites.service';
import { authenticate } from '../auth/auth.middleware';
import { createSuccessResponse, createErrorResponse, AppError } from '../../utils/errors';

export async function favoritesRoutes(app: FastifyInstance) {
  app.post('/api/v1/favorites', { preHandler: [authenticate] }, async (request, reply) => {
    const { id: userId } = request.user as { id: string };
    const { symbol } = request.body as { symbol?: string };
    if (!symbol) {
      return reply.status(400).send(createErrorResponse('symbol is required'));
    }

    try {
      await addFavorite(userId, symbol);
      return createSuccessResponse({ symbol });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message));
      }
      throw err;
    }
  });

  app.delete('/api/v1/favorites/:symbol', { preHandler: [authenticate] }, async (request, reply) => {
    const { id: userId } = request.user as { id: string };
    const { symbol } = request.params as { symbol: string };

    try {
      await removeFavorite(userId, symbol);
      return createSuccessResponse({ symbol });
    } catch (err) {
      if (err instanceof AppError) {
        return reply.status(err.statusCode).send(createErrorResponse(err.message));
      }
      throw err;
    }
  });

  app.get('/api/v1/favorites', { preHandler: [authenticate] }, async (request) => {
    const { id: userId } = request.user as { id: string };
    const favorites = await getFavorites(userId);
    return createSuccessResponse(favorites);
  });
}
