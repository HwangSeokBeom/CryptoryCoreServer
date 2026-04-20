import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import {
  getBaseMarketSnapshot,
  getCandlesWithMeta,
  getMarketList,
  getMarketOverview,
  getMarketSparkline,
  getMarketSnapshot,
  getOrderbook,
  getTickers,
  getTrades,
  listMarkets,
  listSymbolSupport,
} from './market-data.service';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';

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

export async function marketRoutes(app: FastifyInstance) {
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
    const { exchange, symbols, debug, batchIndex, allowStale } = request.query as {
      exchange?: string;
      symbols?: string;
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

    if (!symbols) {
      return reply.status(400).send(createErrorResponse('symbols is required', {
        code: 'INVALID_REQUEST',
        field: 'symbols',
        reason: 'REQUIRED',
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
      return createSuccessResponse(await getMarketSparkline({
        exchange: parsedExchange,
        symbols: symbols.split(',').map((value) => value.trim()).filter(Boolean),
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

  app.get('/tickers', async (request, reply) => {
    const { exchange, symbol, limit } = request.query as { exchange?: string; symbol?: string; limit?: string };
    if (exchange && !parseExchange(exchange)) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getTickers({
        exchange: parseExchange(exchange) ?? undefined,
        symbol,
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

  app.get('/orderbook', async (request, reply) => {
    const { exchange, symbol } = request.query as { exchange?: string; symbol?: string };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getOrderbook(parsedExchange, symbol));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/trades', async (request, reply) => {
    const { exchange, symbol, limit } = request.query as { exchange?: string; symbol?: string; limit?: string };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      return createSuccessResponse(await getTrades(parsedExchange, symbol, limit ? parseInt(limit, 10) : 50));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/candles', async (request, reply) => {
    const { exchange, symbol, interval, limit, range } = request.query as {
      exchange?: string;
      symbol?: string;
      interval?: string;
      limit?: string;
      range?: string;
    };
    if (!exchange || !symbol) {
      return reply.status(400).send(createErrorResponse('exchange and symbol are required'));
    }
    const parsedExchange = parseExchange(exchange);
    if (!parsedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported exchange'));
    }

    try {
      const response = await getCandlesWithMeta(
        parsedExchange,
        symbol,
        interval ?? '1h',
        resolveCandleLimit(interval ?? '1h', limit, range),
      );
      logger.info(
        {
          domain: 'market-routes',
          route: '/market/candles',
          exchange: parsedExchange,
          symbol,
          staleCount: response.meta.freshnessState === 'stale' ? 1 : 0,
          unavailableCount: response.meta.freshnessState === 'unavailable' ? 1 : 0,
          meta: response.meta,
        },
        `[ResponseMetaDebug] route=/market/candles staleCount=${response.meta.freshnessState === 'stale' ? 1 : 0} unavailableCount=${response.meta.freshnessState === 'unavailable' ? 1 : 0}`,
      );
      return {
        ...createSuccessResponse(response.items),
        meta: response.meta,
      };
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
