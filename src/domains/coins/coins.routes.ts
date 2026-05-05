import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { featureFlags } from '../../config/feature-flags';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { listBlockedUsers } from '../users/user-relationship.service';
import {
  createCoinCommunityPost,
  createCommunityComment,
  getCoinSentiment,
  likeCommunityItem,
  listCommunityComments,
  listCoinCommunity,
  unlikeCommunityItem,
  validateCommunityContent,
  voteCoinDirection,
  voteCoinSentiment,
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

async function tryOptionalAuth(request: FastifyRequest) {
  if (!getAuthorizationHeader(request)?.trim()) {
    return;
  }
  try {
    await request.jwtVerify();
  } catch {
    // Optional personalization only. Public GET routes still return anonymous DTOs.
  }
}

function getAuthorizationHeader(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  return Array.isArray(authorization) ? authorization[0] : authorization;
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

function logCommunity(params: {
  request: FastifyRequest;
  symbol: string;
  authRequired: boolean;
  authOk: boolean;
  userId?: string | null;
  itemCount: number;
  participantCount: number;
}) {
  logger.info(
    {
      domain: 'coin-community',
      method: params.request.method,
      symbol: params.symbol,
      userIdMasked: maskUserId(params.userId),
      authRequired: params.authRequired,
      authOk: params.authOk,
      itemCount: params.itemCount,
      participantCount: params.participantCount,
    },
    `[Community] method=${params.request.method} symbol=${params.symbol} userIdMasked=${maskUserId(params.userId)} authRequired=${params.authRequired} authOk=${params.authOk} itemCount=${params.itemCount} participantCount=${params.participantCount}`,
  );
}

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

function logCommunityContract(params: { endpoint: string; status: number; bodyShape: string }) {
  logger.info(
    {
      domain: 'coin-community-contract',
      endpoint: params.endpoint,
      status: params.status,
      bodyShape: params.bodyShape,
    },
    `[CommunityContract] endpoint=${params.endpoint} status=${params.status} bodyShape=${params.bodyShape}`,
  );
}

function logCommunityLike(params: {
  symbol: string;
  itemId: string;
  userId?: string | null;
  action: 'like' | 'unlike';
  status: number;
  likeCount: number;
}) {
  logger.info(
    {
      domain: 'coin-community-like',
      symbol: params.symbol,
      itemId: params.itemId,
      userIdMasked: maskUserId(params.userId),
      action: params.action,
      status: params.status,
      likeCount: params.likeCount,
    },
    `[CommunityLike] symbol=${params.symbol} itemId=${params.itemId} userIdMasked=${maskUserId(params.userId)} action=${params.action} status=${params.status} likeCount=${params.likeCount}`,
  );
}

function logCommunityComment(params: {
  symbol: string;
  itemId: string;
  userId?: string | null;
  action: 'list' | 'create';
  status: number;
  commentCount: number;
}) {
  logger.info(
    {
      domain: 'coin-community-comment',
      symbol: params.symbol,
      itemId: params.itemId,
      userIdMasked: maskUserId(params.userId),
      action: params.action,
      status: params.status,
      commentCount: params.commentCount,
    },
    `[CommunityComment] symbol=${params.symbol} itemId=${params.itemId} userIdMasked=${maskUserId(params.userId)} action=${params.action} status=${params.status} commentCount=${params.commentCount}`,
  );
}

function logSentiment(params: {
  scope: 'coin' | 'market';
  key: string;
  userId?: string | null;
  vote?: string | null;
  status: number;
  participants: number;
}) {
  logger.info(
    {
      domain: 'sentiment',
      scope: params.scope,
      key: params.key,
      userIdMasked: maskUserId(params.userId),
      vote: params.vote ?? null,
      status: params.status,
      participants: params.participants,
    },
    params.scope === 'coin'
      ? `[CoinSentiment] symbol=${params.key} userIdMasked=${maskUserId(params.userId)} vote=${params.vote ?? ''} status=${params.status} participants=${params.participants}`
      : `[MarketSentiment] userIdMasked=${maskUserId(params.userId)} vote=${params.vote ?? ''} status=${params.status} participants=${params.participants}`,
  );
}

function logCommunityAuth(request: FastifyRequest, symbol: string | null, authFailureCode: string) {
  const authorization = getAuthorizationHeader(request);
  logger.warn(
    {
      domain: 'coin-community-auth',
      method: request.method,
      symbol,
      hasAuthorization: Boolean(authorization?.trim()),
      tokenLength: authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim().length ?? 0,
      authFailureCode,
    },
    `[CommunityAuth] method=${request.method} symbol=${symbol ?? ''} hasAuthorization=${Boolean(authorization?.trim())} authFailureCode=${authFailureCode}`,
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

function parseRouteSymbolForLog(request: FastifyRequest) {
  const { symbol: symbolParam } = request.params as { symbol?: string };
  if (!symbolParam) {
    return null;
  }
  const symbol = normalizeCoinSymbol(symbolParam);
  return isValidNormalizedCoinSymbol(symbol) ? symbol : null;
}

export async function coinRoutes(app: FastifyInstance) {
  async function handleCoinInfo(request: FastifyRequest, reply: FastifyReply) {
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
  }

  app.get('/:symbol', handleCoinInfo);

  app.get('/:symbol/info', async (request, reply) => {
    return handleCoinInfo(request, reply);
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

  app.get('/:symbol/news', async (request, reply) => {
    if (!featureFlags.isNewsEnabled) {
      return reply.status(404).send(createErrorResponse('news is unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { category, date, from, to, cursor, limit, sort, orderBy, direction, fallback, latest } = request.query as {
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
    const { NEWS_CATEGORIES, listNews, parseNewsLimit } = await import('../news/news.service');
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
      symbol,
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
    logger.info(
      {
        domain: 'coin-news',
        symbol,
        itemCount: data.items.length,
        emptyReason: data.emptyState.reason,
        status: reply.statusCode,
      },
      `[CoinNews] symbol=${symbol} itemCount=${data.items.length} emptyReason=${data.emptyState.reason ?? ''} status=${reply.statusCode}`,
    );
    logInformationalRoute(request, reply, symbol);
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
    await tryOptionalAuth(request);
    if (request.user?.id) {
      await listBlockedUsers(request.user.id);
    }
    const { sort, filter, cursor, limit, orderBy, direction } = request.query as {
      sort?: string;
      filter?: string;
      cursor?: string;
      limit?: string;
      orderBy?: string;
      direction?: string;
    };
    if (sort && !['latest', 'oldest', 'popular'].includes(sort)) {
      return reply.status(400).send(createErrorResponse('unsupported sort', {
        acceptedValues: ['latest', 'oldest', 'popular'],
      }, 'INVALID_SORT'));
    }
    if (orderBy && !['createdAt', 'likeCount', 'commentCount'].includes(orderBy)) {
      return reply.status(400).send(createErrorResponse('unsupported orderBy', {
        acceptedValues: ['createdAt', 'likeCount', 'commentCount'],
      }, 'INVALID_ORDER_BY'));
    }
    if (direction && !['asc', 'desc'].includes(direction)) {
      return reply.status(400).send(createErrorResponse('unsupported direction', {
        acceptedValues: ['asc', 'desc'],
      }, 'INVALID_DIRECTION'));
    }
    if (filter && !['all', 'holder', 'profit', 'activity'].includes(filter)) {
      return reply.status(400).send(createErrorResponse('unsupported filter', {
        acceptedValues: ['all', 'holder', 'profit', 'activity'],
      }, 'INVALID_FILTER'));
    }

    const data = listCoinCommunity({
      symbol,
      sort: sort as 'latest' | 'oldest' | 'popular' | undefined,
      orderBy: orderBy as 'createdAt' | 'likeCount' | 'commentCount' | undefined,
      direction: direction as 'asc' | 'desc' | undefined,
      filter: filter as 'all' | 'holder' | 'profit' | 'activity' | undefined,
      cursor,
      limit: parseLimit(limit),
      userId: request.user?.id ?? null,
    });
    logCommunity({
      request,
      symbol: data.symbol,
      authRequired: false,
      authOk: Boolean(request.user?.id),
      userId: request.user?.id ?? null,
      itemCount: data.items.length,
      participantCount: data.summary.participantCount,
    });
    logCommunityContract({
      endpoint: 'GET /coins/:symbol/community',
      status: reply.statusCode,
      bodyShape: 'success.data{symbol,items,pagination,summary}',
    });
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });

  app.post('/:symbol/community', async (request, reply) => {
    if (!featureFlags.isCommunityContentEnabled) {
      return reply.status(404).send(createErrorResponse('community content is unavailable', undefined, 'FEATURE_DISABLED'));
    }
    if (!(await requireAuth(app, request, reply))) {
      const symbolForLog = parseRouteSymbolForLog(request);
      logCommunityAuth(
        request,
        symbolForLog,
        (request as FastifyRequest & { authFailureCode?: string }).authFailureCode ?? 'ACCESS_TOKEN_INVALID',
      );
      logCommunity({
        request,
        symbol: symbolForLog ?? '',
        authRequired: true,
        authOk: false,
        userId: null,
        itemCount: 0,
        participantCount: 0,
      });
      logInformationalRoute(request, reply, symbolForLog);
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
    logCommunity({
      request,
      symbol,
      userId: request.user.id,
      authRequired: true,
      authOk: true,
      itemCount: data.summary.itemCount,
      participantCount: data.summary.participantCount,
    });
    logCommunityContract({
      endpoint: 'POST /coins/:symbol/community',
      status: reply.statusCode,
      bodyShape: 'success.data{item,summary}',
    });
    logInformationalRoute(request, reply, symbol);
    return reply.send(createSuccessResponse(data));
  });

  app.post('/:symbol/community/:itemId/like', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { itemId } = request.params as { itemId: string };
    const data = likeCommunityItem({ symbol, itemId, userId: request.user.id });
    if (!data) {
      return reply.status(404).send(createErrorResponse('community item not found', undefined, 'COMMUNITY_ITEM_NOT_FOUND'));
    }
    logCommunityLike({ symbol, itemId, userId: request.user.id, action: 'like', status: reply.statusCode, likeCount: data.likeCount });
    return createSuccessResponse(data);
  });

  app.delete('/:symbol/community/:itemId/like', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { itemId } = request.params as { itemId: string };
    const data = unlikeCommunityItem({ symbol, itemId, userId: request.user.id });
    if (!data) {
      return reply.status(404).send(createErrorResponse('community item not found', undefined, 'COMMUNITY_ITEM_NOT_FOUND'));
    }
    logCommunityLike({ symbol, itemId, userId: request.user.id, action: 'unlike', status: reply.statusCode, likeCount: data.likeCount });
    return createSuccessResponse(data);
  });

  app.get('/:symbol/community/:itemId/comments', async (request, reply) => {
    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    await tryOptionalAuth(request);
    if (request.user?.id) {
      await listBlockedUsers(request.user.id);
    }
    const { itemId } = request.params as { itemId: string };
    const { cursor, limit, sort, direction } = request.query as { cursor?: string; limit?: string; sort?: string; direction?: string };
    if (sort && !['latest', 'oldest'].includes(sort)) {
      return reply.status(400).send(createErrorResponse('unsupported sort', {
        acceptedValues: ['latest', 'oldest'],
      }, 'INVALID_SORT'));
    }
    if (direction && !['asc', 'desc'].includes(direction)) {
      return reply.status(400).send(createErrorResponse('unsupported direction', {
        acceptedValues: ['asc', 'desc'],
      }, 'INVALID_DIRECTION'));
    }
    const data = listCommunityComments({
      symbol,
      itemId,
      cursor,
      limit: parseLimit(limit),
      userId: request.user?.id ?? null,
      sort: sort as 'latest' | 'oldest' | undefined,
      direction: direction as 'asc' | 'desc' | undefined,
    });
    if (!data) {
      return reply.status(404).send(createErrorResponse('community item not found', undefined, 'COMMUNITY_ITEM_NOT_FOUND'));
    }
    logCommunityComment({ symbol, itemId, userId: request.user?.id ?? null, action: 'list', status: reply.statusCode, commentCount: data.summary.commentCount });
    return createSuccessResponse(data);
  });

  app.post('/:symbol/community/:itemId/comments', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      return;
    }
    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const { itemId } = request.params as { itemId: string };
    const validation = validateCommunityContent((request.body as { content?: unknown } | null | undefined)?.content);
    if (!validation.ok) {
      return reply.status(400).send(createErrorResponse('comment content is required', undefined, 'INVALID_COMMENT_CONTENT'));
    }
    const data = createCommunityComment({
      symbol,
      itemId,
      userId: request.user.id,
      authorName: request.user.email ?? null,
      content: validation.content,
    });
    if (!data) {
      return reply.status(404).send(createErrorResponse('community item not found', undefined, 'COMMUNITY_ITEM_NOT_FOUND'));
    }
    logCommunityComment({ symbol, itemId, userId: request.user.id, action: 'create', status: reply.statusCode, commentCount: data.summary.commentCount });
    return createSuccessResponse(data);
  });

  app.get('/:symbol/sentiment', async (request, reply) => {
    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    await tryOptionalAuth(request);

    const data = getCoinSentiment({
      symbol,
      userId: request.user?.id ?? null,
    });
    logSentiment({
      scope: 'coin',
      key: symbol,
      userId: request.user?.id ?? null,
      vote: data.myVote,
      status: reply.statusCode,
      participants: data.totalParticipants,
    });
    logInformationalRoute(request, reply, symbol);
    return createSuccessResponse(data);
  });

  app.post('/:symbol/sentiment', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      const symbolForLog = parseRouteSymbolForLog(request);
      logSentiment({
        scope: 'coin',
        key: symbolForLog ?? '',
        userId: null,
        status: reply.statusCode,
        participants: 0,
      });
      logInformationalRoute(request, reply, symbolForLog);
      return;
    }

    const parsed = voteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_SENTIMENT_VOTE'));
    }

    const symbol = parseRouteSymbol(request, reply);
    if (!symbol) {
      return;
    }
    const data = voteCoinSentiment({
      symbol,
      userId: request.user.id,
      vote: parsed.data.direction,
    });
    logSentiment({
      scope: 'coin',
      key: symbol,
      userId: request.user.id,
      vote: parsed.data.direction,
      status: reply.statusCode,
      participants: data.totalParticipants,
    });
    logInformationalRoute(request, reply, symbol);
    return createSuccessResponse(data);
  });

  app.post('/:symbol/votes', async (request, reply) => {
    if (!featureFlags.isCommunityContentEnabled) {
      return reply.status(404).send(createErrorResponse('community content is unavailable', undefined, 'FEATURE_DISABLED'));
    }
    if (!(await requireAuth(app, request, reply))) {
      const symbolForLog = parseRouteSymbolForLog(request);
      logCommunityAuth(
        request,
        symbolForLog,
        (request as FastifyRequest & { authFailureCode?: string }).authFailureCode ?? 'ACCESS_TOKEN_INVALID',
      );
      logCommunity({
        request,
        symbol: symbolForLog ?? '',
        authRequired: true,
        authOk: false,
        userId: null,
        itemCount: 0,
        participantCount: 0,
      });
      logInformationalRoute(request, reply, symbolForLog);
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
    logCommunity({
      request,
      symbol: data.symbol,
      authRequired: true,
      authOk: true,
      userId: request.user.id,
      itemCount: 0,
      participantCount: data.vote.participantCount,
    });
    logInformationalRoute(request, reply, data.symbol);
    return createSuccessResponse(data);
  });
}
