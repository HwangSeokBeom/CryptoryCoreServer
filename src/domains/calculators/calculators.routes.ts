import type { FastifyInstance } from 'fastify';
import { getUsdtRateController } from './calculators.controller';

export async function calculatorsRoutes(app: FastifyInstance) {
  app.get('/usdt-rate', getUsdtRateController);
}
