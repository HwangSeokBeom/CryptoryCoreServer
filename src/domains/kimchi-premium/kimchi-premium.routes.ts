import type { FastifyInstance } from 'fastify';
import { AppError, createErrorResponse, createSuccessResponse } from '../../utils/errors';
import type { DomesticExchangeId } from '../../core/exchange/exchange.types';
import { listComparableKimchiSymbols } from '../market-data/market-data.service';
import { logger } from '../../utils/logger';
import {
  getKimchiPremium,
  getKimchiPremiumBatch,
  getKimchiPremiumList,
  getKimchiPremiumRepresentatives,
  getKimchiPremiumSnapshot,
  getKimchiPremiumSparkline,
} from './kimchi-premium.service';
import { normalizeKimchiPremiumQueryLenient } from './kimchi-premium.request';

function parseDebugFlag(value: string | undefined) {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'debug'].includes(value.trim().toLowerCase());
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

export async function kimchiPremiumRoutes(app: FastifyInstance) {
  app.get('/representatives', async (request, reply) => {
    const { exchange, limit, debug } = request.query as {
      exchange?: string;
      limit?: string;
      debug?: string;
    };

    const normalizedExchange = exchange?.trim().toLowerCase();
    if (!normalizedExchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      }));
    }

    if (!['upbit', 'bithumb', 'coinone', 'korbit'].includes(normalizedExchange)) {
      return reply.status(400).send(createErrorResponse('unsupported domestic exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await getKimchiPremiumRepresentatives({
        exchange: normalizedExchange as DomesticExchangeId,
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
    const { exchange, cursor, limit, debug } = request.query as {
      exchange?: string;
      cursor?: string;
      limit?: string;
      debug?: string;
    };

    const normalizedExchange = exchange?.trim().toLowerCase();
    if (!normalizedExchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      }));
    }

    if (!['upbit', 'bithumb', 'coinone', 'korbit'].includes(normalizedExchange)) {
      return reply.status(400).send(createErrorResponse('unsupported domestic exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await getKimchiPremiumList({
        exchange: normalizedExchange as DomesticExchangeId,
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
    const { exchange, symbols, debug } = request.query as {
      exchange?: string;
      symbols?: string;
      debug?: string;
    };

    const normalizedExchange = exchange?.trim().toLowerCase();
    if (!normalizedExchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      }));
    }

    if (!symbols) {
      return reply.status(400).send(createErrorResponse('symbols query parameter is required', {
        code: 'INVALID_REQUEST',
        field: 'symbols',
        reason: 'REQUIRED',
      }));
    }

    if (!['upbit', 'bithumb', 'coinone', 'korbit'].includes(normalizedExchange)) {
      return reply.status(400).send(createErrorResponse('unsupported domestic exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
        rejectedValue: exchange,
      }));
    }

    try {
      const normalizedQuery = normalizeKimchiPremiumQueryLenient({
        symbols,
        exchange: normalizedExchange,
      });
      const response = await getKimchiPremiumSparkline({
        exchange: normalizedExchange as DomesticExchangeId,
        symbols: normalizedQuery.symbols,
        debug: parseDebugFlag(debug),
      });
      return createSuccessResponse({
        ...response,
        rejectedSymbols: normalizedQuery.rejectedSymbols,
        partial: response.partial || normalizedQuery.rejectedSymbols.length > 0,
      });
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/comparable-symbols', async (request, reply) => {
    const { exchange, limit } = request.query as {
      exchange?: string;
      limit?: string;
    };

    const normalizedExchange = exchange?.trim().toLowerCase();
    if (!normalizedExchange) {
      return reply.status(400).send(createErrorResponse('exchange is required', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'REQUIRED',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
      }));
    }

    if (!['upbit', 'bithumb', 'coinone', 'korbit'].includes(normalizedExchange)) {
      return reply.status(400).send(createErrorResponse('unsupported domestic exchange', {
        code: 'INVALID_REQUEST',
        field: 'exchange',
        reason: 'UNSUPPORTED_VALUE',
        acceptedValues: ['upbit', 'bithumb', 'coinone', 'korbit'],
        rejectedValue: exchange,
      }));
    }

    try {
      return createSuccessResponse(await listComparableKimchiSymbols({
        exchange: normalizedExchange as DomesticExchangeId,
        limit: parsePositiveInteger(limit),
      }));
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/snapshot', async (request, reply) => {
    const query = request.query as {
      symbols?: string;
      venue?: string | string[];
      exchange?: string;
      domesticExchange?: string;
      quoteCurrency?: string;
    };

    try {
      const normalizedQuery = normalizeKimchiPremiumQueryLenient(query);
      const snapshot = await getKimchiPremiumSnapshot(normalizedQuery.symbols, {
        venues: normalizedQuery.venues,
        quoteCurrency: normalizedQuery.quoteCurrency,
      });
      return createSuccessResponse({
        ...snapshot,
        rejectedSymbols: normalizedQuery.rejectedSymbols,
        partial: normalizedQuery.rejectedSymbols.length > 0 || snapshot.status !== 'success',
        meta: {
          requestedCount: normalizedQuery.requestedSymbolCount,
          normalizedCount: normalizedQuery.symbols.length,
          rejectedCount: normalizedQuery.rejectedSymbols.length,
        },
      });
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/batch', async (request, reply) => {
    const query = request.query as {
      symbols?: string;
      venue?: string | string[];
      exchange?: string;
      domesticExchange?: string;
      quoteCurrency?: string;
    };

    try {
      const normalizedQuery = normalizeKimchiPremiumQueryLenient(query);
      return createSuccessResponse(
        await getKimchiPremiumBatch({
          symbols: normalizedQuery.symbols,
          requestedSymbolCount: normalizedQuery.requestedSymbolCount,
          rejectedSymbols: normalizedQuery.rejectedSymbols,
          venues: normalizedQuery.venues,
          quoteCurrency: normalizedQuery.quoteCurrency,
        }),
      );
    } catch (error) {
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });

  app.get('/', async (request, reply) => {
    const query = request.query as {
      symbols?: string;
      venue?: string | string[];
      exchange?: string;
      domesticExchange?: string;
      quoteCurrency?: string;
    };
    logger.info(
      {
        domain: 'kimchi-premium',
        event: 'request_received',
        venue: query.domesticExchange ?? query.venue ?? query.exchange ?? 'upbit',
        quoteCurrency: query.quoteCurrency ?? 'KRW',
        symbolsCount: query.symbols ? query.symbols.split(',').length : 0,
      },
      '[KimchiPremium] request_received',
    );

    try {
      const normalizedQuery = normalizeKimchiPremiumQueryLenient(query);
      logger.info(
        {
          domain: 'kimchi-premium',
          event: 'request_normalized',
          venue: normalizedQuery.venues[0],
          venues: normalizedQuery.venues,
          quoteCurrency: normalizedQuery.quoteCurrency,
          normalizedSymbols: normalizedQuery.symbols,
          requestedSymbolCount: normalizedQuery.requestedSymbolCount,
          rejectedSymbols: normalizedQuery.rejectedSymbols,
        },
        '[KimchiPremium] request_normalized',
      );

      const startedAt = Date.now();
      const entries = await getKimchiPremium(normalizedQuery.symbols, {
          venues: normalizedQuery.venues,
          quoteCurrency: normalizedQuery.quoteCurrency,
      });
      const elapsedMs = Date.now() - startedAt;
      logger.info(
        {
          domain: 'kimchi-premium',
          exchange: normalizedQuery.venues[0],
          requestedCount: normalizedQuery.requestedSymbolCount,
          normalizedCount: normalizedQuery.symbols.length,
          accepted: entries.length,
          rejected: normalizedQuery.rejectedSymbols.length,
          unsupported: entries.filter((entry) => entry.errorCode === 'UNSUPPORTED_SYMBOL' || entry.errorCode === 'SYMBOL_MAPPING_NOT_FOUND').length,
          elapsedMs,
        },
        `[KimchiAPI] exchange=${normalizedQuery.venues[0]} requestedCount=${normalizedQuery.requestedSymbolCount} normalizedCount=${normalizedQuery.symbols.length} accepted=${entries.length} rejected=${normalizedQuery.rejectedSymbols.length} unsupported=${entries.filter((entry) => entry.errorCode === 'UNSUPPORTED_SYMBOL' || entry.errorCode === 'SYMBOL_MAPPING_NOT_FOUND').length} elapsedMs=${elapsedMs}`,
      );

      for (const failure of normalizedQuery.rejectedSymbols) {
        logger.warn(
          {
            domain: 'kimchi-premium',
            exchange: normalizedQuery.venues[0],
            symbolFailure: failure.symbol ?? failure.input,
            reason: failure.reason,
          },
          `[KimchiAPI] exchange=${normalizedQuery.venues[0]} symbolFailure=${failure.symbol ?? failure.input} reason=${failure.reason}`,
        );
      }

      return createSuccessResponse(entries);
    } catch (error) {
      if (error instanceof AppError) {
        logger.warn(
          {
            domain: 'kimchi-premium',
            event: 'invalid_request',
            field: error.details?.field ?? null,
            reason: error.details?.reason ?? null,
            details: error.details,
          },
          '[KimchiPremium] invalid_request',
        );
        return reply.status(error.statusCode).send(createErrorResponse(error.message, error.details));
      }
      throw error;
    }
  });
}
