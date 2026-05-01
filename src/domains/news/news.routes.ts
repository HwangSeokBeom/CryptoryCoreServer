import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { featureFlags } from '../../config/feature-flags';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { getNewsById, listNews, NEWS_CATEGORIES, normalizeNewsSymbol, parseNewsLimit } from './news.service';

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

export async function newsRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { coin, symbol, category, date, cursor, limit } = request.query as {
      coin?: string;
      symbol?: string;
      category?: string;
      date?: string;
      cursor?: string;
      limit?: string;
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

    const data = listNews({
      coin,
      symbol,
      category: normalizedCategory,
      date,
      cursor,
      limit: safeLimit,
    });
    logInformationalRoute(request, reply);
    logger.info(
      {
        domain: 'news',
        itemCount: data.items.length,
        source: 'static',
        fallbackUsed: false,
      },
      `[News] itemCount=${data.items.length} source=static fallbackUsed=false`,
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
