import { FastifyInstance } from 'fastify';
import { EXCHANGE_MAP } from '../../config/constants';
import type { DomesticExchangeId } from '../../core/exchange/exchange.types';
import { createErrorResponse, createSuccessResponse } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { buildUnifiedMarketName, resolveMarketCatalogEntry, toUnifiedSymbol } from './market.normalization';
import {
  serializeCandlesResponse,
  serializeKimchiPremiumResponse,
  serializeOrderbookResponse,
  serializeTickersResponse,
  serializeTradesResponse,
} from './public-market.contract';
import {
  getPublicCandles,
  getPublicCandlesWithMeta,
  getPublicKimchiPremium,
  getPublicOrderbook,
  getPublicTickers,
  getPublicTrades,
  listPublicMarkets,
  searchPublicMarkets,
} from './public-market.service';

function ensureSupportedExchange(exchange: string | undefined) {
  if (!exchange) return null;
  return EXCHANGE_MAP.has(exchange) ? null : createErrorResponse('unsupported exchange');
}

function normalizeKimchiExchange(exchange: string | undefined): DomesticExchangeId | undefined {
  const normalized = exchange?.trim().toLowerCase();
  if (!normalized) return undefined;
  return ['upbit', 'bithumb', 'coinone', 'korbit'].includes(normalized)
    ? normalized as DomesticExchangeId
    : undefined;
}

export async function publicMarketRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    logger.info({ domain: 'public-market', method: request.method, url: request.url }, 'Handling public market route');
  });

  app.get('/markets', async (request, reply) => {
    const { exchange } = request.query as { exchange?: string };
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }
    return createSuccessResponse(listPublicMarkets(exchange));
  });

  app.get('/search', async (request, reply) => {
    const { q, exchange } = request.query as { q?: string; exchange?: string };
    if (!q) {
      return reply.status(400).send(createErrorResponse('q query parameter is required'));
    }
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }

    return createSuccessResponse(searchPublicMarkets(q, exchange));
  });

  app.get('/tickers', async (request, reply) => {
    const { exchange, symbol, marketId } = request.query as { exchange?: string; symbol?: string; marketId?: string };
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }
    if (marketId && !exchange) {
      return reply.status(400).send(createErrorResponse('exchange is required when marketId is provided'));
    }
    const resolvedMarket = exchange && marketId
      ? resolveMarketCatalogEntry({ exchange, marketId })
      : null;
    if (marketId && exchange && !resolvedMarket) {
      return reply.status(400).send(createErrorResponse('marketId is not listed on the requested exchange'));
    }
    const tickers = await getPublicTickers({ exchange, symbol: resolvedMarket?.symbol ?? symbol });
    return createSuccessResponse(serializeTickersResponse(tickers));
  });

  app.get('/orderbook', async (request, reply) => {
    const { exchange, symbol, marketId } = request.query as { exchange?: string; symbol?: string; marketId?: string };
    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }

    const resolvedMarket = resolveMarketCatalogEntry({ exchange, symbol, marketId });
    if (!resolvedMarket) {
      return reply.status(400).send(createErrorResponse('symbol or marketId is not listed on the requested exchange'));
    }

    const orderbook = await getPublicOrderbook(resolvedMarket.symbol, exchange);
    if (!orderbook) {
      return reply.status(404).send(createErrorResponse('orderbook not found'));
    }

    return createSuccessResponse(serializeOrderbookResponse(orderbook));
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
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }

    const resolvedMarket = resolveMarketCatalogEntry({ exchange, symbol, marketId });
    if (!resolvedMarket) {
      return reply.status(400).send(createErrorResponse('symbol or marketId is not listed on the requested exchange'));
    }

    const trades = getPublicTrades(resolvedMarket.symbol, exchange, limit ? parseInt(limit, 10) : 50);
    const unifiedSymbol = toUnifiedSymbol(resolvedMarket.symbol);
    return createSuccessResponse(
      serializeTradesResponse({
        exchange,
        symbol: unifiedSymbol,
        market: buildUnifiedMarketName(exchange, unifiedSymbol),
        marketId: resolvedMarket.marketId,
        rawSymbol: resolvedMarket.rawSymbol,
        canonicalSymbol: resolvedMarket.canonicalSymbol,
        baseCurrency: resolvedMarket.baseCurrency,
        quoteCurrency: resolvedMarket.quoteCurrency,
        baseAsset: resolvedMarket.baseAsset,
        quoteAsset: resolvedMarket.quoteAsset,
        displaySymbol: resolvedMarket.displaySymbol,
        koreanName: resolvedMarket.koreanName,
        englishName: resolvedMarket.englishName,
        iconUrl: resolvedMarket.iconUrl,
        isActive: resolvedMarket.isActive,
        capabilities: resolvedMarket.capabilities,
        items: trades,
      }),
    );
  });

  app.get('/candles', async (request, reply) => {
    const { exchange, symbol, marketId, period, limit } = request.query as {
      exchange?: string;
      symbol?: string;
      marketId?: string;
      period?: string;
      limit?: string;
    };

    if (!exchange || (!symbol && !marketId)) {
      return reply.status(400).send(createErrorResponse('exchange and symbol or marketId are required'));
    }
    const exchangeError = ensureSupportedExchange(exchange);
    if (exchangeError) {
      return reply.status(400).send(exchangeError);
    }

    const resolvedMarket = resolveMarketCatalogEntry({ exchange, symbol, marketId });
    if (!resolvedMarket) {
      return reply.status(400).send(createErrorResponse('symbol or marketId is not listed on the requested exchange'));
    }

    const candles = await getPublicCandlesWithMeta(
      resolvedMarket.symbol,
      exchange,
      period ?? '1h',
      limit ? parseInt(limit, 10) : 60,
    );

    const unifiedSymbol = toUnifiedSymbol(resolvedMarket.symbol);
    return createSuccessResponse(
      serializeCandlesResponse({
        exchange,
        symbol: unifiedSymbol,
        market: buildUnifiedMarketName(exchange, unifiedSymbol),
        marketId: resolvedMarket.marketId,
        rawSymbol: resolvedMarket.rawSymbol,
        canonicalSymbol: resolvedMarket.canonicalSymbol,
        baseCurrency: resolvedMarket.baseCurrency,
        quoteCurrency: resolvedMarket.quoteCurrency,
        baseAsset: resolvedMarket.baseAsset,
        quoteAsset: resolvedMarket.quoteAsset,
        displaySymbol: resolvedMarket.displaySymbol,
        koreanName: resolvedMarket.koreanName,
        englishName: resolvedMarket.englishName,
        iconUrl: resolvedMarket.iconUrl,
        isActive: resolvedMarket.isActive,
        capabilities: resolvedMarket.capabilities,
        interval: period ?? '1h',
        items: candles.items,
        meta: candles.meta,
      }),
    );
  });

  app.get('/kimchi-premium', async (request, reply) => {
    const { symbols, exchange, venue, domesticExchange } = request.query as {
      symbols?: string;
      exchange?: string;
      venue?: string;
      domesticExchange?: string;
    };
    if (!symbols) {
      return reply.status(400).send(createErrorResponse('symbols query parameter is required'));
    }

    const requestedExchange = domesticExchange ?? venue ?? exchange;
    const selectedExchange = normalizeKimchiExchange(requestedExchange);
    if (requestedExchange && !selectedExchange) {
      return reply.status(400).send(createErrorResponse('unsupported domestic exchange'));
    }

    const result = await getPublicKimchiPremium(
      symbols.split(',').map((symbol) => symbol.trim()).filter(Boolean),
      selectedExchange ? { venues: [selectedExchange] } : undefined,
    );

    return createSuccessResponse(serializeKimchiPremiumResponse(result));
  });
}
