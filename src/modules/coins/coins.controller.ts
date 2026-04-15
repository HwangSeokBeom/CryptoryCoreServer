import { FastifyInstance } from 'fastify';
import { getAllCoins } from './coins.service';
import { createSuccessResponse } from '../../utils/errors';

export async function coinsRoutes(app: FastifyInstance) {
  app.get('/api/v1/coins', async () => {
    const coins = await getAllCoins();
    return createSuccessResponse(coins);
  });
}
