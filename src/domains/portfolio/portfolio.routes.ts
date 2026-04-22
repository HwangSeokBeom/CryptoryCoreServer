import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';
import {
  getAggregatedPortfolioSummary,
  getAssetHistoryRouteResponse,
  getPortfolioSnapshotRouteResponse,
} from './portfolio.service';

export async function portfolioRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/summary', async (request, reply) => {
    const { exchange } = request.query as { exchange?: ExchangeId };
    try {
      if (exchange) {
        const response = await getPortfolioSnapshotRouteResponse(request.user.id, exchange);
        return {
          ...createSuccessResponse(response.data),
          status: response.routeStatus,
          warningMessage: response.warningMessage,
          partialFailureMessage: response.partialFailureMessage,
          unavailableReason: response.unavailableReason,
          privateStreamingStatus: response.privateStreamingStatus,
          pollingFallbackRecommended: response.pollingFallbackRecommended,
        };
      }

      const summary = await getAggregatedPortfolioSummary(request.user.id);
      if (summary.partialSuccess) {
        logger.info(
          {
            domain: 'portfolio',
            event: 'portfolio_partial_success',
            userId: request.user.id,
            failureCount: summary.failures.length,
            connectedExchanges: summary.connectedExchanges,
          },
          'Portfolio summary returned partial data',
        );
      }
      return {
        ...createSuccessResponse(summary),
        status: summary.partialSuccess ? 'partial_data' : 'ok',
        partialFailureMessage: summary.partialSuccess ? '일부 거래소 데이터만 반영되었습니다.' : undefined,
      };
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
      const response = await getAssetHistoryRouteResponse(
        request.user.id,
        exchange,
        symbol,
        limit ? parseInt(limit, 10) : 50,
      );
      return {
        ...createSuccessResponse(response.data),
        status: response.routeStatus,
        warningMessage: response.warningMessage,
        partialFailureMessage: response.partialFailureMessage,
        unavailableReason: response.unavailableReason,
        privateStreamingStatus: response.privateStreamingStatus,
        pollingFallbackRecommended: response.pollingFallbackRecommended,
      };
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
