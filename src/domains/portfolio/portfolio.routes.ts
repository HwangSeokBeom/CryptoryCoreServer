import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { getAggregatedPortfolioSummary, getAssetHistory, getPortfolioSnapshot } from './portfolio.service';

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/summary', async (request, reply) => {
    const { exchange } = request.query as { exchange?: ExchangeId };
    try {
      return createSuccessResponse(
        exchange
          ? await getPortfolioSnapshot(request.user.id, exchange)
          : await getAggregatedPortfolioSummary(request.user.id),
      );
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/assets', async (request, reply) => {
    const { exchange } = request.query as { exchange?: ExchangeId };
    try {
      return createSuccessResponse(await getAggregatedPortfolioSummary(request.user.id, exchange));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/history', async (request, reply) => {
    const { exchange, symbol, limit } = request.query as { exchange?: ExchangeId; symbol?: string; limit?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required'));
    }
    try {
      return createSuccessResponse(await getAssetHistory(request.user.id, exchange, symbol, limit ? parseInt(limit, 10) : 50));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
