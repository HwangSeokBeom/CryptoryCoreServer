import { FastifyInstance } from 'fastify';
import { getPortfolio, getPortfolioSummary } from './portfolio.service';
import { authenticate } from '../auth/auth.middleware';
import { createSuccessResponse } from '../../utils/errors';

export async function portfolioRoutes(app: FastifyInstance) {
  app.get('/api/v1/portfolio', { preHandler: [authenticate] }, async (request) => {
    const { id: userId } = request.user as { id: string };
    const { exchange } = request.query as { exchange?: string };
    const portfolio = await getPortfolio(userId, exchange || 'upbit');
    return createSuccessResponse(portfolio);
  });

  app.get('/api/v1/portfolio/summary', { preHandler: [authenticate] }, async (request) => {
    const { id: userId } = request.user as { id: string };
    const { exchange } = request.query as { exchange?: string };
    const summary = await getPortfolioSummary(userId, exchange || 'upbit');
    return createSuccessResponse(summary);
  });
}
