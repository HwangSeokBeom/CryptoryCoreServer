import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { featureFlags } from '../../config/feature-flags';
import {
  getAssetCoverageAudit,
  getBaseMarketSnapshot,
  getCandlesWithMeta,
  getMarketList,
  getMarketOverview,
  getMarketSummary,
  getMarketSparkline,
  getMarketSnapshot,
  getOrderbook,
  getTickers,
  getTradesWithMeta,
  listMarkets,
  listSymbolSupport,
} from './market-data.service';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';
import { createMarketDataErrorBody, MarketDataAvailabilityError } from './market-data.errors';
import { getGlobalMarketHistory, getMarketDashboard, getMarketTrendSeries } from './market-trends.service';
import { getMarketThemes } from './market-themes.service';
import { getMarketSentiment, voteMarketSentiment } from '../coins/coin-community.service';
import {
  getMarketCandleSnapshot,
  getDefaultQuoteCurrency,
  getMarketExchangeContract,
  getMarketSparklineBatch,
  getMarketTickerList,
  isQuoteCurrencySupported,
  listMarketExchangeContracts,
  normalizeContractSymbolInput,
  parseContractExchange,
  parseContractLimit,
  parseContractQuoteCurrency,
  parseContractTimeframe,
  parseSortOrder,
  parseTickerSort,
  parseTickerSortOrder,
  summarizeTickerSparklines,
} from './contracts/market-data-contract.service';
import { z } from 'zod';

const VALID_EXCHANGES = new Set<ExchangeId>(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);

function parseExchange(exchange: string | undefined) {
  if (!exchange) return null;
  return VALID_EXCHANGES.has(exchange as ExchangeId) ? (exchange as ExchangeId) : null;
}

function parseDebugFlag(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'debug'].includes(value.trim().toLowerCase());
}

function parseBooleanFlag(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError(400, 'batchIndex must be a non-negative integer');
  }

  return parsed;
}

function resolveCandleLimit(interval: string, limit?: string, range?: string) {
  const parsedLimit = parsePositiveInteger(limit);
  if (parsedLimit !== undefined) {
    return parsedLimit;
  }

  if (!range) {
    return 60;
  }

  const normalizedInterval = interval === '1m' ? 60_000 : interval === '5m' ? 300_000 : interval === '15m' ? 900_000 : interval === '30m' ? 1_800_000 : interval === '4h' ? 14_400_000 : 3_600_000;
  const rangeMatch = range.trim().toLowerCase().match(/^(\d+)(m|h|d)$/);
  if (!rangeMatch) {
    throw new AppError(400, 'range must use m, h, or d units');
  }

  const amount = Number.parseInt(rangeMatch[1], 10);
  const unit = rangeMatch[2];
  const rangeMs = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
  return Math.max(Math.min(Math.ceil(rangeMs / normalizedInterval), 500), 1);
}

function normalizeIntervalToContractTimeframe(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  const mapped: Record<string, string> = {
    '1m': '1M',
    '5m': '5M',
    '15m': '15M',
    '1h': '1H',
    '4h': '4H',
    '1d': '1D',
    '1w': '1W',
  };
  return mapped[normalized] ?? value;
}

function routePath(request: FastifyRequest) {
  return request.routeOptions?.url ?? request.url.split('?')[0];
}

function logInformationalRoute(request: FastifyRequest, status: number) {
  logger.info(
    {
      domain: 'informational-route',
      method: request.method,
      path: routePath(request),
      originalUrl: request.url,
      normalizedSymbol: null,
      status,
    },
    `[InformationalRoute] method=${request.method} path=${routePath(request)} originalUrl=${request.url} normalizedSymbol= status=${status}`,
  );
}

function createMarketContractRouteError(params: {
  error: AppError;
  exchange?: string;
  marketId?: string;
  symbol?: string;
  source: 'ticker' | 'candles';
}) {
  const retryable = params.error.statusCode >= 500 || params.error.code === 'EXCHANGE_UNAVAILABLE' || params.error.code === 'EXCHANGE_REQUEST_FAILED';
  const code = retryable ? 'MARKET_DATA_RETRYABLE_ERROR' : params.error.code ?? 'MARKET_DATA_REQUEST_FAILED';
  return {
    success: false as const,
    status: retryable ? 'retryable_error' : 'error',
    error: {
      code,
      message: params.error.message,
      retryable,
      source: params.source === 'candles' || params.source === 'ticker' ? 'external_exchange' : 'server',
      exchange: params.exchange ?? (params.error.details?.exchange as string | undefined) ?? null,
      marketId: params.marketId ?? null,
      symbol: params.symbol ?? null,
    },
  };
}

function maskUserId(userId?: string | null) {
  if (!userId) {
    return null;
  }
  return userId.length <= 4 ? '****' : `${userId.slice(0, 2)}***${userId.slice(-2)}`;
}

function logSentiment(params: {
  key: string;
  userId?: string | null;
  vote?: string | null;
  status: number;
  participants: number;
}) {
  logger.info(
    {
      domain: 'sentiment',
      scope: 'market',
      key: params.key,
      userIdMasked: maskUserId(params.userId),
      vote: params.vote ?? null,
      status: params.status,
      participants: params.participants,
    },
    `[MarketSentiment] userIdMasked=${maskUserId(params.userId)} vote=${params.vote ?? ''} status=${params.status} participants=${params.participants}`,
  );
}

const sentimentVoteSchema = z.object({
  vote: z.enum(['bullish', 'bearish']).optional(),
  direction: z.enum(['bullish', 'bearish']).optional(),
}).transform((value, context) => {
  const vote = value.vote ?? value.direction;
  if (!vote) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'vote must be bullish or bearish',
    });
    return z.NEVER;
  }
  return { vote };
});

async function requireAuth(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
  await app.authenticate(request, reply);
  return !reply.sent;
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

export async function marketRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    logger.info(
      { domain: 'market-routes', route: '/market/health', status: reply.statusCode },
      '[MarketHealth] ok',
    );
    return createSuccessResponse({
      status: 'ok',
      service: 'market',
      timestamp: Date.now(),
      restPath: '/market',
      websocketPath: '/ws/market',
    });
  });

  app.get('/global/history', async (request, reply) => {
    const { range, interval, currency } = request.query as { range?: string; interval?: string; currency?: string };
    if (range && !['7d', '30d', '90d', '1y'].includes(range)) {
      return reply.status(400).send(createErrorResponse('range must be 7d, 30d, 90d, or 1y', {
        field: 'range',
        acceptedValues: ['7d', '30d', '90d', '1y'],
      }, 'INVALID_RANGE'));
    }
    if (interval && interval !== 'daily') {
      return reply.status(400).send(createErrorResponse('interval must be daily', {
        field: 'interval',
        acceptedValues: ['daily'],
      }, 'INVALID_INTERVAL'));
    }
    const data = await getGlobalMarketHistory({ range, interval, currency });
    logInformationalRoute(request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.get('/trends', async (request, reply) => {
    if (!featureFlags.isMarketTrendsEnabled) {
      return reply.status(404).send(createErrorResponse('market trends are unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const { range, currency } = request.query as { range?: string; currency?: string };
    if (range && !['7d', '30d'].includes(range)) {
      return reply.status(400).send(createErrorResponse('range must be 7d or 30d', {
        field: 'range',
        acceptedValues: ['7d', '30d'],
      }, 'INVALID_RANGE'));
    }
    const data = await getMarketTrendSeries({ range, currency });
    logInformationalRoute(request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.get('/data', async (request, reply) => {
    const { currency } = request.query as { currency?: string };
    const data = await getMarketDashboard({ currency });
    logInformationalRoute(request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.get('/sentiment', async (request, reply) => {
    await tryOptionalAuth(request);
    const data = getMarketSentiment({ userId: request.user?.id ?? null });
    logSentiment({
      key: data.date,
      userId: request.user?.id ?? null,
      vote: data.myVote,
      status: reply.statusCode,
      participants: data.totalParticipants,
    });
    logInformationalRoute(request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.post('/sentiment', async (request, reply) => {
    if (!(await requireAuth(app, request, reply))) {
      logSentiment({
        key: new Date().toISOString().slice(0, 10),
        status: reply.statusCode,
        participants: 0,
      });
      logInformationalRoute(request, reply.statusCode);
      return;
    }

    const parsed = sentimentVoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(createErrorResponse(parsed.error.errors[0].message, undefined, 'INVALID_SENTIMENT_VOTE'));
    }

    const data = voteMarketSentiment({
      userId: request.user.id,
      vote: parsed.data.vote,
    });
    logSentiment({
      key: data.date,
      userId: request.user.id,
      vote: parsed.data.vote,
      status: reply.statusCode,
      participants: data.totalParticipants,
    });
    logInformationalRoute(request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.get('/themes', async (_request, reply) => {
    if (!featureFlags.isMarketThemesEnabled) {
      return reply.status(404).send(createErrorResponse('market themes are unavailable', undefined, 'FEATURE_DISABLED'));
    }

    const data = await getMarketThemes();
    logInformationalRoute(_request, reply.statusCode);
    return createSuccessResponse(data);
  });

  app.get('/overview', async (request, reply) => {
    const { exchange, limit, debug } = request.query as {
      exchange?: string;
      limit?: string;
      debug?: string;
    };

    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await getMarketOverview({
        exchange: parsedExchange,
        limit: parsePositiveInteger(limit),
        debug: parseDebugFlag(debug),
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/list', async (request, reply) => {
    const { exchange, tab, sort, cursor, limit, debug } = request.query as {
      exchange?: string;
      tab?: string;
      sort?: string;
      cursor?: string;
      limit?: string;
      debug?: string;
    };

    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    if (tab && !['all', 'representatives'].includes(tab)) {
      return reply.status(400).send(createErrorResponse('unsupported tab', {
        code: 'INVALID_REQUEST',
        field: 'tab',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['all', 'representatives'],
        rejectedValue: tab,
      }));
    }

    if (sort && !['volume', 'change', 'symbol', 'price'].includes(sort)) {
      return reply.status(400).send(createErrorResponse('unsupported sort', {
        code: 'INVALID_REQUEST',
        field: 'sort',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['volume', 'change', 'symbol', 'price'],
        rejectedValue: sort,
      }));
    }

    try {
      return createSuccessResponse(await getMarketList({
        exchange: parsedExchange,
        tab: (tab as 'all' | 'representatives' | undefined) ?? 'all',
        sort: (sort as 'volume' | 'change' | 'symbol' | 'price' | undefined) ?? 'volume',
        cursor,
        limit: parsePositiveInteger(limit),
        debug: parseDebugFlag(debug),
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/sparkline', async (request, reply) => {
    const { exchange, quoteCurrency, quote, symbols, marketIds, interval, limit, debug, batchIndex, allowStale } = request.query as {
      exchange?: string;
      quoteCurrency?: string;
      quote?: string;
      symbols?: string;
      marketIds?: string;
      interval?: string;
      limit?: string;
      debug?: string;
      batchIndex?: string;
      allowStale?: string;
    };

    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    if (!symbols && !marketIds) {
      return reply.status(400).send(createErrorResponse('symbols or marketIds is required', {
        code: 'INVALID_REQUEST',
        field: 'symbols',
        reason: 'REQUIRED',
      }));
    }

    const requestedQuoteCurrency = quoteCurrency ?? quote;
    const candidateContractExchange = parseContractExchange(exchange);
    if (requestedQuoteCurrency !== undefined || candidateContractExchange) {
      const parsedExchange = candidateContractExchange;
      const parsedQuoteCurrency = parseContractQuoteCurrency(requestedQuoteCurrency ?? (parsedExchange ? getDefaultQuoteCurrency(parsedExchange) : undefined));
      if (!parsedExchange) {
        return reply.status(400).send(createErrorResponse('exchange must be upbit, bithumb, coinone, korbit, or binance', {
          field: 'exchange',
          acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        }, 'INVALID_EXCHANGE'));
      }
      if (!parsedQuoteCurrency) {
        return reply.status(400).send(createErrorResponse('quoteCurrency must be KRW, BTC, USDT, or ETH', {
          field: 'quoteCurrency',
          acceptedValues: ['KRW', 'BTC', 'USDT', 'ETH'],
        }, 'INVALID_QUOTE_CURRENCY'));
      }
      const parsedInterval = parseContractTimeframe(normalizeIntervalToContractTimeframe(interval) ?? '1H');
      if (!parsedInterval) {
        return reply.status(400).send(createErrorResponse('interval must be 1M, 5M, 15M, 1H, 4H, 1D, or 1W', {
          field: 'interval',
          acceptedValues: ['1M', '5M', '15M', '1H', '4H', '1D', '1W'],
        }, 'INVALID_TIMEFRAME'));
      }

      const requestedSymbols = (symbols ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      const requestedMarketIds = (marketIds ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      const startedAt = Date.now();
      let parsedLimit = 24;
      try {
        parsedLimit = parseContractLimit(limit, 24, 60);
      } catch (error) {
        if (error instanceof AppError) {
          return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
        }
        throw error;
      }
      logger.info(
        {
          domain: 'market-contract',
          route: '/market/sparkline',
          source: 'http',
          exchange: parsedExchange,
          quoteCurrency: parsedQuoteCurrency,
          symbolsCount: requestedSymbols.length,
          marketIdsCount: requestedMarketIds.length,
          interval: parsedInterval,
          limit: parsedLimit,
        },
        `[MarketSparkline] request source=http exchange=${parsedExchange} quoteCurrency=${parsedQuoteCurrency} symbolsCount=${requestedSymbols.length} interval=${parsedInterval} limit=${parsedLimit}`,
      );

      try {
        const response = await getMarketSparklineBatch({
          exchange: parsedExchange,
          quoteCurrency: parsedQuoteCurrency,
          symbols: requestedSymbols,
          marketIds: requestedMarketIds,
          interval: parsedInterval,
          limit: parsedLimit,
        });
        const renderable = response.items.filter((item) => item.isRenderable).length;
        const refined = response.items.filter((item) => item.sparklineQuality === 'refined_mini' || item.sparklineQuality === 'prepared_cache').length;
        const derivedFallback = response.items.filter((item) => item.sparklineSource === 'derived_change24h').length;
        const flat = response.items.filter((item) => item.sparklineSource === 'flat_current').length;
        logger.info(
          {
            domain: 'market-contract',
            route: '/market/sparkline',
            source: 'http',
            exchange: parsedExchange,
            quoteCurrency: parsedQuoteCurrency,
            returned: response.items.length,
            renderable,
            refined,
            derivedFallback,
            flat,
            unavailable: response.unavailableSymbols.length,
            elapsedMs: Date.now() - startedAt,
          },
          `[MarketSparkline] response returned=${response.items.length} refined=${refined} derivedFallback=${derivedFallback} flat=${flat} unavailable=${response.unavailableSymbols.length} elapsedMs=${Date.now() - startedAt}`,
        );
        return createSuccessResponse(response);
      } catch (error) {
        if (error instanceof AppError) {
          return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details, error.code));
        }
        throw error;
      }
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await getMarketSparkline({
        exchange: parsedExchange,
        symbols: (symbols ?? '').split(',').map((value) => value.trim()).filter(Boolean),
        batchIndex: parseNonNegativeInteger(batchIndex),
        allowStale: parseBooleanFlag(allowStale),
        debug: parseDebugFlag(debug),
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/base-snapshot', async (request, reply) => {
    const { exchange, symbols, scope, limit } = request.query as {
      exchange?: string;
      symbols?: string;
      scope?: string;
      limit?: string;
    };

    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    if (scope && !['top', 'visible', 'full', 'symbols'].includes(scope)) {
      return reply.status(400).send(createErrorResponse('unsupported scope', {
        code: 'INVALID_REQUEST',
        field: 'scope',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['top', 'visible', 'full', 'symbols'],
        rejectedValue: scope,
      }));
    }

    try {
      return createSuccessResponse(await getBaseMarketSnapshot({
        exchange: parsedExchange,
        symbols: symbols?.split(',').map((value) => value.trim()).filter(Boolean),
        scope:
          scope === 'symbols'
            ? 'symbols'
            : scope === 'top'
              ? 'top'
              : scope === 'visible'
                ? 'visible'
                : scope === 'full'
                  ? 'full'
                  : undefined,
        limit: limit ? parsePositiveInteger(limit) : undefined,
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/snapshot', async (request, reply) => {
    const { exchange, symbols, scope, limit } = request.query as {
      exchange?: string;
      symbols?: string;
      scope?: string;
      limit?: string;
    };

    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    if (scope && !['top', 'visible', 'full', 'symbols'].includes(scope)) {
      return reply.status(400).send(createErrorResponse('unsupported scope', {
        code: 'INVALID_REQUEST',
        field: 'scope',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['top', 'visible', 'full', 'symbols'],
        rejectedValue: scope,
      }));
    }

    try {
      return createSuccessResponse(await getMarketSnapshot({
        exchange: parsedExchange,
        scope:
          scope === 'symbols'
            ? 'symbols'
            : scope === 'top'
              ? 'top'
              : scope === 'visible'
                ? 'visible'
              : scope === 'full'
                ? 'full'
                : undefined,
        symbols: symbols?.split(',').map((value) => value.trim()),
        limit: limit ? parseInt(limit, 10) : undefined,
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/markets', async (request, reply) => {
    const { exchange } = request.query as { exchange?: string };
    if (exchange && !parseExchange(exchange)) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await listMarkets(parseExchange(exchange) ?? undefined));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/exchanges', async () => createSuccessResponse({
    items: listMarketExchangeContracts(),
  }));

  app.get('/tickers', async (request, reply) => {
    const { exchange, symbol, marketId, limit, quoteCurrency, quote, sort, order } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
      limit?: string;
      quoteCurrency?: string;
      quote?: string;
      sort?: string;
      order?: string;
    };
    const requestedQuoteCurrency = quoteCurrency ?? quote;
    const candidateContractExchange = parseContractExchange(exchange);
    if (requestedQuoteCurrency !== undefined || (candidateContractExchange && !symbol && !marketId)) {
      const parsedExchange = candidateContractExchange;
      const parsedQuoteCurrency = parseContractQuoteCurrency(requestedQuoteCurrency ?? (parsedExchange ? getDefaultQuoteCurrency(parsedExchange) : undefined));
      if (!parsedExchange) {
        return reply.status(400).send(createErrorResponse('exchange must be upbit, bithumb, coinone, korbit, or binance', {
          field: 'exchange',
          acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        }, 'INVALID_EXCHANGE'));
      }
      if (!parsedQuoteCurrency) {
        return reply.status(400).send(createErrorResponse('quoteCurrency must be KRW, BTC, USDT, or ETH', {
          field: 'quoteCurrency',
          acceptedValues: ['KRW', 'BTC', 'USDT', 'ETH'],
        }, 'INVALID_QUOTE_CURRENCY'));
      }
      try {
        const startedAt = Date.now();
        const parsedLimit = limit ? parseContractLimit(limit, 100, 500) : 100;
        logger.info(
          {
            domain: 'market-contract',
            route: '/market/tickers',
            source: 'http',
            exchange: parsedExchange,
            quoteCurrency: parsedQuoteCurrency,
            limit: parsedLimit ?? null,
          },
          `[MarketTickers] request source=http exchange=${parsedExchange} quoteCurrency=${parsedQuoteCurrency} limit=${parsedLimit ?? ''}`,
        );
        const response = await getMarketTickerList({
          exchange: parsedExchange,
          quoteCurrency: parsedQuoteCurrency,
          sort: parseTickerSort(sort),
          order: parseTickerSortOrder(sort, order),
          limit: parsedLimit,
        });
        const sparklineSummary = summarizeTickerSparklines(response.items);
        logger.info(
          {
            domain: 'market-contract',
            route: '/market/tickers',
            source: 'http',
            exchange: parsedExchange,
            quoteCurrency: parsedQuoteCurrency,
            count: response.items.length,
            sparklineReady: sparklineSummary.ready,
            sparklineProvider: sparklineSummary.provider,
            sparklineDerived: sparklineSummary.derived,
            sparklineFlat: sparklineSummary.flat,
            sparklineUnavailable: sparklineSummary.unavailable,
            elapsedMs: Date.now() - startedAt,
          },
          `[MarketTickers] response count=${response.items.length} sparklineReady=${sparklineSummary.ready} sparklineProvider=${sparklineSummary.provider} sparklineDerived=${sparklineSummary.derived} flat=${sparklineSummary.flat} unavailable=${sparklineSummary.unavailable} elapsedMs=${Date.now() - startedAt}`,
        );
        return createSuccessResponse(response);
      } catch (error) {
        if (error instanceof AppError) {
          const exchangeContract = getMarketExchangeContract(parsedExchange);
          return reply.status(error.statusCode >= 500 ? 503 : error.statusCode).send({
            success: false,
            error: {
              code: error.code ?? 'PROVIDER_UNAVAILABLE',
              message: error.message,
            },
            data: {
              exchange: parsedExchange,
              quoteCurrency: parsedQuoteCurrency,
              supportedQuotes: exchangeContract.supportedQuotes,
              defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
              items: [],
              diagnostics: {
                requestedExchange: parsedExchange,
                requestedQuoteCurrency: parsedQuoteCurrency,
                supported: isQuoteCurrencySupported(parsedExchange, parsedQuoteCurrency),
                unsupported: !isQuoteCurrencySupported(parsedExchange, parsedQuoteCurrency),
                providerStatus: 'error',
                providerLatencyMs: null,
                rawCount: 0,
                mappedCount: 0,
                returnedCount: 0,
                omittedCount: 0,
                zeroPriceCount: 0,
                zeroVolumeCount: 0,
                staleCount: 0,
                reason: error.code === 'EXCHANGE_UNAVAILABLE' ? 'provider_timeout' : error.code ?? 'provider_error',
              },
            },
          });
        }
        throw error;
      }
    }

    if (exchange && !parseExchange(exchange)) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }
    if (marketId && !exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required when marketId is provided'));
    }

    try {
      return createSuccessResponse(await getTickers({
        exchange: parseExchange(exchange) ?? undefined,
        symbol,
        marketId,
        limit: limit ? parseInt(limit, 10) : undefined,
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/symbols', async (request, reply) => {
    const { exchange } = request.query as { exchange?: string };
    if (!exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
      }));
    }

    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await listSymbolSupport(parsedExchange));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/symbols/audit', async (request, reply) => {
    const { exchange, refresh } = request.query as {
      exchange?: string;
      refresh?: string;
    };

    const parsedExchange = parseExchange(exchange);
    if (exchange && !parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await getAssetCoverageAudit({
        exchange: parsedExchange ?? undefined,
        refresh: parseBooleanFlag(refresh) ?? false,
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/orderbook', async (request, reply) => {
    const { exchange, symbol, marketId } = request.query as { exchange?: string; symbol?: string; marketId?: string };
    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getOrderbook(parsedExchange, { symbol, marketId }));
    } catch (error) {
      if (error instanceof MarketDataAvailabilityError) {
        return reply.status(error.statusCode).send(createMarketDataErrorBody(error));
      }
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/trades', async (request, reply) => {
    const { exchange, symbol, marketId, limit } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
      limit?: string;
    };
    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      const response = await getTradesWithMeta(parsedExchange, { symbol, marketId }, limit ? parseInt(limit, 10) : 50);
      return {
        ...createSuccessResponse(response.items),
        total: response.total,
        metadata: response.metadata,
      };
    } catch (error) {
      if (error instanceof MarketDataAvailabilityError) {
        return reply.status(error.statusCode).send(createMarketDataErrorBody(error));
      }
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/candles', async (request, reply) => {
    const { exchange, symbol, marketId, interval, limit, range, quoteCurrency, quote, timeframe } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
      interval?: string;
      limit?: string;
      range?: string;
      quoteCurrency?: string;
      quote?: string;
      timeframe?: string;
    };
    const requestedQuoteCurrency = quoteCurrency ?? quote;
    if (requestedQuoteCurrency !== undefined || timeframe !== undefined) {
      const parsedExchange = parseContractExchange(exchange);
      const parsedQuoteCurrency = parseContractQuoteCurrency(requestedQuoteCurrency);
      const requestedTimeframe = timeframe ?? normalizeIntervalToContractTimeframe(interval);
      const parsedTimeframe = parseContractTimeframe(requestedTimeframe);
      if (!parsedExchange) {
        return reply.status(400).send(createErrorResponse('exchange must be upbit or bithumb', {
          field: 'exchange',
          acceptedValues: ['upbit', 'bithumb'],
        }, 'INVALID_EXCHANGE'));
      }
      const requestedMarket = symbol?.trim() || marketId?.trim();
      if (!requestedMarket) {
        return reply.status(400).send(createErrorResponse('symbol or marketId is required', { field: 'symbol' }, 'INVALID_SYMBOL'));
      }
      if (!parsedQuoteCurrency) {
        return reply.status(400).send(createErrorResponse('quote or quoteCurrency must be KRW or BTC', {
          field: quoteCurrency !== undefined ? 'quoteCurrency' : 'quote',
          acceptedValues: ['KRW', 'BTC'],
        }, 'INVALID_QUOTE_CURRENCY'));
      }
      if (!parsedTimeframe) {
        return reply.status(400).send(createErrorResponse('timeframe must be 1M, 5M, 15M, 1H, 4H, 1D, or 1W', {
          field: timeframe !== undefined ? 'timeframe' : 'interval',
          acceptedValues: ['1M', '5M', '15M', '1H', '4H', '1D', '1W'],
        }, 'INVALID_TIMEFRAME'));
      }
      let normalizedSymbol = requestedMarket;
      let normalizedMarket = requestedMarket;
      try {
        const startedAt = Date.now();
        const parsedLimit = parseContractLimit(limit, 200, 500);
        normalizedSymbol = normalizeContractSymbolInput(parsedExchange, requestedMarket, parsedQuoteCurrency);
        normalizedMarket = `${parsedQuoteCurrency}-${normalizedSymbol}`;
        logger.info(
          {
            domain: 'market-contract',
            route: '/market/candles',
            source: 'http',
            selectedOnly: true,
            exchange: parsedExchange,
            symbol: normalizedSymbol,
            quoteCurrency: parsedQuoteCurrency,
            timeframe: parsedTimeframe,
            limit: parsedLimit,
          },
          `[MarketCandles] request source=http selectedOnly=true exchange=${parsedExchange} symbol=${normalizedSymbol} quoteCurrency=${parsedQuoteCurrency} timeframe=${parsedTimeframe} limit=${parsedLimit}`,
        );
        const response = await getMarketCandleSnapshot({
          exchange: parsedExchange,
          symbol: normalizedSymbol,
          quoteCurrency: parsedQuoteCurrency,
          timeframe: parsedTimeframe,
          limit: parsedLimit,
        });
        logger.info(
          {
            domain: 'market-contract',
            route: '/market/candles',
            source: 'http',
            selectedOnly: true,
            exchange: parsedExchange,
            symbol: normalizedSymbol,
            quoteCurrency: parsedQuoteCurrency,
            timeframe: parsedTimeframe,
            pointCount: response.candles.length,
            elapsedMs: Date.now() - startedAt,
            cacheHit: response.meta.source === 'last_known_good',
          },
          `[MarketCandles] response pointCount=${response.candles.length} elapsedMs=${Date.now() - startedAt} cacheHit=${response.meta.source === 'last_known_good'}`,
        );
        return createSuccessResponse(response);
      } catch (error) {
        if (error instanceof AppError) {
          const retryable = error.statusCode >= 500 || error.code === 'EXCHANGE_UNAVAILABLE' || error.code === 'EXCHANGE_REQUEST_FAILED';
          if (retryable) {
            logger.warn(
              {
                domain: 'market-routes',
                route: '/market/candles',
                exchange: parsedExchange,
                marketId: requestedMarket,
                retryable: true,
                err: error,
              },
              '[MarketCandles] retryable_error',
            );
            return reply.status(200).send(createSuccessResponse({
              exchange: parsedExchange,
              symbol: normalizedSymbol,
              quoteCurrency: parsedQuoteCurrency,
              market: normalizedMarket,
              marketId: normalizedMarket,
              displaySymbol: `${normalizedSymbol}/${parsedQuoteCurrency}`,
              timeframe: parsedTimeframe,
              source: parsedExchange,
              status: 'retryable_error',
              points: [],
              candles: [],
              stale: false,
              meta: {
                freshnessState: 'unavailable',
                source: 'external_exchange',
                fallbackReason: error.message,
                pointCount: 0,
              },
              emptyState: {
                isEmpty: false,
                reason: null,
              },
              error: {
                code: 'MARKET_DATA_RETRYABLE_ERROR',
                message: error.message,
                retryable: true,
                source: 'external_exchange',
                exchange: parsedExchange,
                marketId: requestedMarket,
              },
              summary: {
                currentPrice: null,
                high24h: null,
                low24h: null,
                changeRate24h: null,
                volume24h: null,
              },
            }));
          }
          return reply.status(error.statusCode).send(createMarketContractRouteError({
            error,
            exchange: parsedExchange,
            marketId: requestedMarket,
            symbol: requestedMarket,
            source: 'candles',
          }));
        }
        throw error;
      }
    }

    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      const response = await getCandlesWithMeta(
        parsedExchange,
        { symbol, marketId },
        interval ?? '1h',
        resolveCandleLimit(interval ?? '1h', limit, range),
      );
      logger.info(
        {
          domain: 'market-routes',
          route: '/market/candles',
          exchange: parsedExchange,
          symbol: response.metadata.canonicalSymbol,
          marketId: response.metadata.marketId,
          staleCount: response.meta.freshnessState === 'stale' ? 1 : 0,
          unavailableCount: response.meta.freshnessState === 'unavailable' ? 1 : 0,
          meta: response.meta,
        },
        `[ResponseMetaDebug] route=/market/candles staleCount=${response.meta.freshnessState === 'stale' ? 1 : 0} unavailableCount=${response.meta.freshnessState === 'unavailable' ? 1 : 0}`,
      );
      return {
        ...createSuccessResponse(response.items),
        meta: response.meta,
        metadata: response.metadata,
        total: response.items.length,
      };
    } catch (error) {
      if (error instanceof MarketDataAvailabilityError) {
        return reply.status(error.statusCode).send(createMarketDataErrorBody(error));
      }
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/summary', async (request, reply) => {
    const { exchange, symbol, marketId } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
    };
    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getMarketSummary({ exchange: parsedExchange, symbol, marketId }));
    } catch (error) {
      if (error instanceof MarketDataAvailabilityError) {
        return reply.status(error.statusCode).send(createMarketDataErrorBody(error));
      }
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
