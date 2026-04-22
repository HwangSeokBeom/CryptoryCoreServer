import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { env } from './config/env';
import { logger } from './utils/logger';
import { AppError, createErrorResponse, mapInfrastructureError } from './utils/errors';

// Route imports
import { authRoutes } from './modules/auth/auth.controller';
import { publicMarketRoutes } from './modules/public-market/public-market.controller';
import { privateAccountRoutes } from './modules/private-account/private-account.controller';
import { marketRoutes } from './domains/market-data/market.routes';
import { chartRoutes } from './domains/charts/chart.routes';
import { tradingRoutes } from './domains/trading/trading.routes';
import { portfolioRoutes } from './domains/portfolio/portfolio.routes';
import { kimchiPremiumRoutes } from './domains/kimchi-premium/kimchi-premium.routes';
import { exchangeConnectionRoutes } from './domains/exchange-connections/exchange-connections.routes';
import { exchangeMetadataRoutes } from './domains/exchange-metadata/exchange-metadata.routes';

export async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own Pino logger
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.JWT_SECRET });

  // Decorate JWT types
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send(createErrorResponse('인증이 필요합니다'));
    }
  });

  app.addHook('onRequest', async (request) => {
    const startedAt = Date.now();
    let cancelledLogged = false;

    const maybeLogCancellation = (event: 'aborted' | 'close') => {
      if (cancelledLogged || request.raw.aborted !== true) {
        return;
      }
      cancelledLogged = true;
      logger.warn(
        {
          domain: 'http',
          event: 'client_cancelled_request',
          method: request.method,
          url: request.url,
          requestId: request.id,
          elapsedMs: Date.now() - startedAt,
          signal: event,
        },
        'Client cancelled request',
      );
    };

    request.raw.once('aborted', () => maybeLogCancellation('aborted'));
    request.raw.once('close', () => maybeLogCancellation('close'));
  });

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    const mappedError = mapInfrastructureError(error);
    if (mappedError?.code === 'DATABASE_SCHEMA_MISMATCH') {
      logger.error(
        { err: error, code: mappedError.code, details: mappedError.details },
        'Database schema mismatch detected',
      );
    } else {
      logger.error({ err: error }, 'Unhandled error');
    }

    const responseError = mappedError ?? (error instanceof AppError ? error : null);
    const statusCode = responseError?.statusCode || error.statusCode || 500;
    const message = responseError?.message || 'Internal Server Error';
    reply
      .status(statusCode)
      .send(
        createErrorResponse(
          message,
          responseError?.details,
          responseError?.code,
        ),
      );
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Register routes
  await app.register(authRoutes);
  await app.register(publicMarketRoutes, { prefix: '/api/v1/public' });
  await app.register(privateAccountRoutes, { prefix: '/api/v1/private' });
  await app.register(marketRoutes, { prefix: '/market' });
  await app.register(chartRoutes, { prefix: '/charts' });
  await app.register(kimchiPremiumRoutes, { prefix: '/kimchi-premium' });
  await app.register(tradingRoutes, { prefix: '/trading' });
  await app.register(portfolioRoutes, { prefix: '/portfolio' });
  await app.register(exchangeConnectionRoutes, { prefix: '/exchange-connections' });
  await app.register(exchangeMetadataRoutes, { prefix: '/exchange-metadata' });

  return app;
}
