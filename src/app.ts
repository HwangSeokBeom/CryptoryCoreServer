import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { env } from './config/env';
import { logger } from './utils/logger';
import { createErrorResponse } from './utils/errors';

// Route imports
import { authRoutes } from './modules/auth/auth.controller';
import { publicMarketRoutes } from './modules/public-market/public-market.controller';
import { privateAccountRoutes } from './modules/private-account/private-account.controller';
import { marketRoutes } from './domains/market-data/market.routes';
import { tradingRoutes } from './domains/trading/trading.routes';
import { portfolioRoutes } from './domains/portfolio/portfolio.routes';
import { kimchiPremiumRoutes } from './domains/kimchi-premium/kimchi-premium.routes';
import { exchangeConnectionRoutes } from './domains/exchange-connections/exchange-connections.routes';

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

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    logger.error({ err: error }, 'Unhandled error');
    const statusCode = error.statusCode || 500;
    reply.status(statusCode).send(createErrorResponse(error.message || 'Internal Server Error'));
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  // Register routes
  await app.register(authRoutes);
  await app.register(publicMarketRoutes, { prefix: '/api/v1/public' });
  await app.register(privateAccountRoutes, { prefix: '/api/v1/private' });
  await app.register(marketRoutes, { prefix: '/market' });
  await app.register(kimchiPremiumRoutes, { prefix: '/kimchi-premium' });
  await app.register(tradingRoutes, { prefix: '/trading' });
  await app.register(portfolioRoutes, { prefix: '/portfolio' });
  await app.register(exchangeConnectionRoutes, { prefix: '/exchange-connections' });

  return app;
}
