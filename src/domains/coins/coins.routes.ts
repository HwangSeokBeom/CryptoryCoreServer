import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { featureFlags } from '../../config/feature-flags';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  createCoinCommunityPost,
  listCoinCommunity,
  validateCommunityContent,
  voteCoinDirection,
} from './coin-community.service';
import { isValidNormalizedCoinSymbol, normalizeCoinSymbol } from './coin-symbol';

const ANALYSIS_TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '2h'] as const;
type AnalysisTimeframe = typeof ANALYSIS_TIMEFRAMES[number];

const voteSchema = z.object({
  direction: z.enum(['bullish', 'bearish']).optional(),
  vote: z.enum(['bullish', 'bearish']).optional(),
}).transform((value, context) => {
  const direction = value.direction ?? value.vote;
  if (!direction) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'direction must be bullish or bearish',
    });
    return z.NEVER;
  }
  return { direction };
});

function parseLimit(value?: string) {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function isValidTimeframe(value: string): value is AnalysisTimeframe {
  return (ANALYSIS_TIMEFRAMES as readonly string[]).includes(value);
}

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
}

function routePath(request: FastifyRequest) {
  return request.routeOptions?.url ?? request.url.split('?')[0];
}

function logInformationalRoute(request: FastifyRequest, reply: FastifyReply, normalizedSymbol: string | null) {
  logger.info(
    {
      domain: 'informational-route',
      method: request.method,
      path: routePath(request),
      originalUrl: request.url,
      normalizedSymbol,
      status: reply.statusCode,
    },
    `[InformationalRoute] method=${request.method} path=${routePath(request)} originalUrl=${request.url} normalizedSymbol=${normalizedSymbol ?? ''} status=${reply.statusCode}`,
  );
}

function parseRouteSymbol(request: FastifyRequest, reply: FastifyReply) {
  const { symbol: symbolParam } = request.params as { symbol: string };
  const symbol = normalizeCoinSymbol(symbolParam);
  if (!isValidNormalizedCoinSymbol(symbol)) {
    reply.status(400);
    logInformationalRoute(request, reply, symbol || null);
    reply.send(createErrorResponse('symbol is invalid', { field: 'symbol' }, 'INVALID_SYMBOL'));
    return null;
  }
  return symbol;
}

export async function coinRoutes(app: FastifyInstance) {
  app.get('/:symbol/info', async (request, reply) => {
    if (!featureFlags.isCoinInfoEnabled) {
      return reply.status(404).send(createErrorResponse('coin info is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { getCoinInfo } = await import('./coin-info.service');
    const data = await getCoinInfo(symbol);
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });

  app.get('/:symbol/analysis', async (request, reply) => {
    if (!featureFlags.isAnalysisReferenceDataEnabled) {
      return reply.status(404).send(createErrorResponse('analysis is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { timeframe = '1h' } = request.query as { timeframe?: string };
    if (!isValidTimeframe(timeframe)) {
      return reply.status(400).send(createErrorResponse('unsupported timeframe', {
        acceptedValues: ANALYSIS_TIMEFRAMES,
      }, 'INVALID_TIMEFRAME'));
    }

    const { getCoinAnalysis } = await import('./coin-analysis.service');
    const data = await getCoinAnalysis(symbol, timeframe);
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });

  app.get('/:symbol/community', async (request, reply) => {
    if (!featureFlags.isCommunityContentEnabled) {
      return reply.status(404).send(createErrorResponse('community content is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { sort, filter, cursor, limit } = request.query as {
      sort?: string;
      filter?: string;
      cursor?: string;
      limit?: string;
    };
    if (sort && !['latest', 'popular'].includes(sort)) {
      return reply.status(400).send(createErrorResponse('unsupported sort', {
        acceptedValues: ['latest', 'popular'],
      }, 'INVALID_SORT'));
    }
    if (filter && !['all', 'holder', 'profit', 'activity'].includes(filter)) {
      return reply.status(400).send(createErrorResponse('unsupported filter', {
        acceptedValues: ['all', 'holder', 'profit', 'activity'],
      }, 'INVALID_FILTER'));
    }

    const data = listCoinCommunity({
      symbol,
      sort: sort as 'latest' | 'popular' | undefined,
      filter: filter as 'all' | 'holder' | 'profit' | 'activity' | undefined,
      cursor,
      limit: parseLimit(limit),
      userId: request.user?.id ?? null,
    });
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });

  app.post('/:symbol/community', async (request, reply) => {
    if (!featureFlags.isCommunityContentEnabled) {
      return reply.status(404).send(createErrorResponse('community content is unavailable', undefined, 'FEATURE_DISABLED'));
    }
    if (!(await requireAuth(app, request, reply))) {
      return;
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const validation = validateCommunityContent((request.body as { content?: unknown } | null | undefined)?.content);
    if (!validation.ok) {
      return reply.status(400).send(createErrorResponse(validation.message, undefined, 'INVALID_COMMUNITY_CONTENT'));
    }

    const data = createCoinCommunityPost({
      symbol,
      userId: request.user.id,
      authorName: request.user.email ?? null,
      content: validation.content,
    });
    reply.status(201);
    logInformationalRoute(request, reply, symbol);
    return reply.send(createSuccessResponse(data));
  });

  app.post('/:symbol/votes', async (request, reply) => {
    if (!featureFlags.isCommunityContentEnabled) {
      return reply.status(404).send(createErrorResponse('community content is unavailable', undefined, 'FEATURE_DISABLED'));
    }
    if (!(await requireAuth(app, request, reply))) {
      return;
    }

    const parsed = voteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_VOTE'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const data = voteCoinDirection({
      symbol,
      userId: request.user.id,
      direction: parsed.data.direction,
    });
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });
}
