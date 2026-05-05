import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { env } from './config/env';
import { logger } from './utils/logger';
import { AppError, createErrorResponse, mapInfrastructureError } from './utils/errors';
import { validateAccessSession } from './modules/auth/auth.service';
import { complianceMiddleware } from './middleware/compliance.middleware';

// Route imports
import { authRoutes } from './modules/auth/auth.controller';
import { appConfigRoutes } from './modules/app-config/app-config.controller';
import { openApiRoutes } from './modules/openapi/openapi.controller';
import { publicMarketRoutes } from './modules/public-market/public-market.controller';
import { privateAccountRoutes } from './modules/private-account/private-account.controller';
import { marketRoutes } from './domains/market-data/market.routes';
import { chartRoutes } from './domains/charts/chart.routes';
import { tradingRoutes } from './domains/trading/trading.routes';
import { portfolioRoutes } from './domains/portfolio/portfolio.routes';
import { kimchiPremiumRoutes } from './domains/kimchi-premium/kimchi-premium.routes';
import { exchangeConnectionRoutes } from './domains/exchange-connections/exchange-connections.routes';
import { exchangeMetadataRoutes } from './domains/exchange-metadata/exchange-metadata.routes';
import { newsRoutes } from './domains/news/news.routes';
import { coinRoutes } from './domains/coins/coins.routes';
import { startMarketSnapshotCollector } from './domains/market-data/market-trends.service';
import { translationRoutes } from './domains/translation/translation.routes';
import { userRoutes } from './domains/users/user.routes';
import { communityRoutes } from './domains/community/community.routes';
import { calculatorsRoutes } from './domains/calculators/calculators.routes';
import { priceAlertRoutes } from './domains/alerts/price-alert.routes';
import { pushRoutes } from './domains/push/push.routes';

function getAuthorizationHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function classifyAccessTokenFailure(error: unknown, authorization: string | undefined) {
  const hasAuthorization = Boolean(authorization?.trim());
  const tokenLength = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim().length ?? 0;
  if (!hasAuthorization) {
    return {
      code: 'ACCESS_TOKEN_REQUIRED',
      message: '인증이 필요합니다',
      hasAuthorization,
      tokenLength,
    };
  }

  const errorMessage = error instanceof Error ? error.message : '';
  const errorCode = typeof error === 'object' && error && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  const expired = errorCode.includes('EXPIRED') || /expired/i.test(errorMessage);
  return {
    code: expired ? 'ACCESS_TOKEN_EXPIRED' : 'ACCESS_TOKEN_INVALID',
    message: expired ? 'access token이 만료되었습니다' : '인증이 필요합니다',
    hasAuthorization,
    tokenLength,
  };
}

export async function buildApp() {
  const app = Fastify({
    logger: false, // We use our own Pino logger
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: env.JWT_SECRET });

  // Decorate JWT types
  app.decorate('authenticate', async (request: any, reply: any) => {
    const authorization = getAuthorizationHeader(request.headers.authorization);
    try {
      if (!authorization?.trim()) {
        throw new Error('missing authorization header');
      }
      await request.jwtVerify();
      const sessionId = request.user?.sid ?? request.user?.sessionId;
      if (sessionId && typeof validateAccessSession === 'function') {
        const active = await validateAccessSession(request.user.id, sessionId);
        if (!active) {
          return reply.status(401).send(createErrorResponse('세션이 만료되었거나 폐기되었습니다', undefined, 'SESSION_INVALID'));
        }
      }
    } catch (error) {
      const failure = classifyAccessTokenFailure(error, authorization);
      logger.warn(
        {
          domain: 'auth',
          action: 'session_restore_failed',
          hasAuthorization: failure.hasAuthorization,
          tokenLength: failure.tokenLength,
          authFailureCode: failure.code,
        },
        `[AuthDebug] action=session_restore_failed hasAuthorization=${failure.hasAuthorization} tokenLength=${failure.tokenLength} authFailureCode=${failure.code}`,
      );
      request.authFailureCode = failure.code;
      reply
        .status(401)
        .send(createErrorResponse(
          failure.message,
          {
            hasAuthorization: failure.hasAuthorization,
            tokenLength: failure.tokenLength,
          },
          failure.code,
        ));
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

  app.addHook('onRequest', complianceMiddleware);

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    const mappedError = mapInfrastructureError(error);
    const responseError = mappedError ?? (error instanceof AppError ? error : null);
    if (mappedError?.code === 'DATABASE_SCHEMA_MISMATCH') {
      logger.error(
        { err: error, code: mappedError.code, details: mappedError.details },
        'Database schema mismatch detected',
      );
    } else if (responseError instanceof AppError) {
      const logLevel = responseError.statusCode >= 500 && process.env.NODE_ENV !== 'test' ? 'error' : 'warn';
      logger[logLevel](
        { err: error, code: responseError.code, statusCode: responseError.statusCode },
        responseError.statusCode < 500 ? 'Handled client error' : 'Handled application error',
      );
    } else {
      logger.error({ err: error }, 'Unhandled error');
    }

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
  app.get('/health', async (_request, reply) => {
    logger.info(
      { domain: 'health', route: '/health', status: reply.statusCode },
      '[Health] ok',
    );
    return {
      status: 'ok',
      timestamp: Date.now(),
      server: {
        port: env.PORT,
        restBaseURL: `http://127.0.0.1:${env.PORT}`,
        marketBaseURL: `http://127.0.0.1:${env.PORT}/market`,
        marketWebSocketURL: `ws://127.0.0.1:${env.PORT}/ws/market`,
      },
      providers: {
        coinmarketcap: env.COINMARKETCAP_API_KEY ? 'configured' : 'degraded',
      },
    };
  });

  // Register routes
  await app.register(authRoutes);
  await app.register(appConfigRoutes);
  await app.register(openApiRoutes);
  await app.register(publicMarketRoutes, { prefix: '/api/v1/public' });
  await app.register(privateAccountRoutes, { prefix: '/api/v1/private' });
  await app.register(marketRoutes, { prefix: '/market' });
  await app.register(chartRoutes, { prefix: '/charts' });
  await app.register(kimchiPremiumRoutes, { prefix: '/kimchi-premium' });
  await app.register(newsRoutes, { prefix: '/news' });
  await app.register(coinRoutes, { prefix: '/coins' });
  await app.register(translationRoutes, { prefix: '/translate' });
  await app.register(translationRoutes, { prefix: '/translations' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(communityRoutes, { prefix: '/community' });
  await app.register(calculatorsRoutes, { prefix: '/calculators' });
  await app.register(priceAlertRoutes, { prefix: '/alerts' });
  await app.register(pushRoutes, { prefix: '/push' });
  await app.register(newsRoutes, { prefix: '/api/v1/news' });
  await app.register(coinRoutes, { prefix: '/api/v1/coins' });
  await app.register(marketRoutes, { prefix: '/api/v1/market' });
  await app.register(marketRoutes, { prefix: '/market-data' });
  await app.register(marketRoutes, { prefix: '/api/v1/market-data' });
  await app.register(translationRoutes, { prefix: '/api/v1/translate' });
  await app.register(translationRoutes, { prefix: '/api/v1/translations' });
  await app.register(userRoutes, { prefix: '/api/v1/users' });
  await app.register(communityRoutes, { prefix: '/api/v1/community' });
  await app.register(calculatorsRoutes, { prefix: '/api/v1/calculators' });
  await app.register(priceAlertRoutes, { prefix: '/api/v1/alerts' });
  await app.register(pushRoutes, { prefix: '/api/v1/push' });
  await app.register(tradingRoutes, { prefix: '/trading' });
  await app.register(portfolioRoutes, { prefix: '/portfolio' });
  await app.register(exchangeConnectionRoutes, { prefix: '/exchange-connections' });
  await app.register(exchangeMetadataRoutes, { prefix: '/exchange-metadata' });

  startMarketSnapshotCollector();

  return app;
}
