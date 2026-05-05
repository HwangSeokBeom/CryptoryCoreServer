import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { featureFlags } from '../../config/feature-flags';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getNewsById, listNews, NEWS_CATEGORIES, normalizeNewsSymbol, parseNewsLimit, summarizeNews } from './news.service';
import { getNewsOverview } from '../market-data/market-trends.service';

function routePath(request: FastifyRequest) {
  return request.routeOptions?.url ?? request.url.split('?')[0];
}

function logInformationalRoute(request: FastifyRequest, reply: FastifyReply) {
  logger.info(
    {
      domain: 'informational-route',
      method: request.method,
      path: routePath(request),
      originalUrl: request.url,
      normalizedSymbol: null,
      status: reply.statusCode,
    },
    `[InformationalRoute] method=${request.method} path=${routePath(request)} originalUrl=${request.url} normalizedSymbol= status=${reply.statusCode}`,
  );
}

async function tryOptionalAuth(request: FastifyRequest) {
  const authorization = Array.isArray(request.headers.authorization)
    ? request.headers.authorization[0]
    : request.headers.authorization;
  if (!authorization?.trim()) {
    return;
  }
  try {
    await request.jwtVerify();
  } catch {
    // Optional personalization only.
  }
}

export async function newsRoutes(app: FastifyInstance) {
  app.get('/overview', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    await tryOptionalAuth(request);
    const data = await getNewsOverview({ userId: request.user?.id ?? null });
    logInformationalRoute(request, reply);
    return createSuccessResponse(data);
  });

  app.get('/summary', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { date, targetLanguage } = request.query as { date?: string; targetLanguage?: string };
    const data = await summarizeNews({ date, targetLanguage });
    logInformationalRoute(request, reply);
    return createSuccessResponse(data);
  });

  app.get('/', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { coin, symbol, coinName, providerId, coingeckoId, category, date, from, to, cursor, limit, sort, orderBy, direction, fallback, latest } = request.query as {
      coin?: string;
      symbol?: string;
      coinName?: string;
      providerId?: string;
      coingeckoId?: string;
      category?: string;
      date?: string;
      from?: string;
      to?: string;
      cursor?: string;
      limit?: string;
      sort?: string;
      orderBy?: string;
      direction?: string;
      fallback?: string;
      latest?: string;
    };

    const parsedLimit = limit ? Number.parseInt(limit, 10) : undefined;
    const safeLimit = parseNewsLimit(parsedLimit);
    if (safeLimit === null) {
      return reply.status(400).send(createErrorResponse('limit must be an integer between 1 and 100', {
        field: 'limit',
      }, 'INVALID_LIMIT'));
    }

    const normalizedCategory = category?.trim().toLowerCase();
    if (normalizedCategory && !(NEWS_CATEGORIES as readonly string[]).includes(normalizedCategory)) {
      return reply.status(400).send(createErrorResponse('unsupported category', {
        field: 'category',
        acceptedValues: NEWS_CATEGORIES,
      }, 'INVALID_CATEGORY'));
    }

    const requestedSymbol = symbol ?? coin;
    if (requestedSymbol !== undefined && requestedSymbol.trim() && !normalizeNewsSymbol(requestedSymbol)) {
      return reply.status(400).send(createErrorResponse('symbol is invalid', {
        field: 'symbol',
      }, 'INVALID_SYMBOL'));
    }
    if (sort && !['latest', 'oldest', 'popular'].includes(sort)) {
      return reply.status(400).send(createErrorResponse('unsupported sort', {
        field: 'sort',
        acceptedValues: ['latest', 'oldest', 'popular'],
      }, 'INVALID_SORT'));
    }
    if (orderBy && !['publishedAt', 'createdAt', 'relevanceScore'].includes(orderBy)) {
      return reply.status(400).send(createErrorResponse('unsupported orderBy', {
        field: 'orderBy',
        acceptedValues: ['publishedAt', 'createdAt', 'relevanceScore'],
      }, 'INVALID_ORDER_BY'));
    }
    if (direction && !['asc', 'desc'].includes(direction)) {
      return reply.status(400).send(createErrorResponse('unsupported direction', {
        field: 'direction',
        acceptedValues: ['asc', 'desc'],
      }, 'INVALID_DIRECTION'));
    }

    const data = await listNews({
      coin,
      symbol,
      coinName,
      providerId: providerId ?? coingeckoId,
      category: normalizedCategory,
      date,
      from,
      to,
      cursor,
      limit: safeLimit,
      fallback: fallback === 'true' || fallback === '1' || latest === 'true' || latest === '1',
      sort: sort as 'latest' | 'oldest' | 'popular' | undefined,
      orderBy: orderBy as 'publishedAt' | 'createdAt' | 'relevanceScore' | undefined,
      direction: direction as 'asc' | 'desc' | undefined,
    });
    logInformationalRoute(request, reply);
    logger.info(
      {
        domain: 'news',
        scope: data.scope,
        itemCount: data.items.length,
        translatedCount: data.items.filter((item) => item.translated).length,
        source: data.source,
        cacheHit: data.cacheHit,
        providerStatus: data.providerStatus,
        reason: data.reason,
      },
      `[NewsList] scope=${data.scope} itemCount=${data.items.length} translatedCount=${data.items.filter((item) => item.translated).length} source=${data.source} cacheHit=${data.cacheHit} reason=${data.reason ?? ''}`,
    );
    return createSuccessResponse(data);
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

    logInformationalRoute(request, reply);
    logger.info(
      {
        domain: 'news',
        itemCount: item ? 1 : 0,
        source: 'static',
        fallbackUsed: false,
      },
      `[News] itemCount=${item ? 1 : 0} source=static fallbackUsed=false`,
    );
    return createSuccessResponse(item);
  });
}
