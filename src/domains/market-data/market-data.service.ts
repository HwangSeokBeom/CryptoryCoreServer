import { env } from '../../config/env';
import { COINS, COIN_MAP } from '../../config/constants';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
import { isSupportedCanonicalSymbol, toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import type { CanonicalCandle, CanonicalOrderbookSnapshot, CanonicalTickerSnapshot, CanonicalTrade, ExchangeId } from '../../core/exchange/exchange.types';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import { logger } from '../../utils/logger';
import { AppError } from '../../utils/errors';

type FreshMarketData<T> = T & {
  sourceTimestamp: number;
  stale: boolean;
  staleAgeMs: number;
};

function assertSupportedSymbol(symbol: string) {
  const normalized = toCanonicalSymbol(symbol);
  if (!isSupportedCanonicalSymbol(normalized)) {
    throw new AppError(400, `unsupported symbol: ${normalized}`);
  }
  return normalized;
}

function withFreshness<T>(item: T, sourceTimestamp: number): FreshMarketData<T> {
  const staleAgeMs = Math.max(Date.now() - sourceTimestamp, 0);
  return {
    ...item,
    sourceTimestamp,
    stale: staleAgeMs > env.MARKET_DATA_STALE_THRESHOLD_MS,
    staleAgeMs,
  };
}

function fallbackMarkets(exchange: ExchangeId) {
  const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
  return COINS.map((coin) => ({
    exchange,
    exchangeName: provider.metadata.displayName,
    symbol: coin.symbol,
    market: `${coin.symbol}/${provider.metadata.quoteCurrency}`,
    rawSymbol: toExchangeSymbol(exchange, coin.symbol),
    quoteCurrency: provider.metadata.quoteCurrency,
    nameKo: COIN_MAP.get(coin.symbol)?.nameKo,
    nameEn: COIN_MAP.get(coin.symbol)?.nameEn,
  }));
}

function fromCachedTicker(item: ReturnType<typeof publicMarketDataStore.getTickers>[number]): CanonicalTickerSnapshot {
  return {
    exchange: item.exchange as ExchangeId,
    symbol: item.symbol,
    market: item.market,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency as CanonicalTickerSnapshot['quoteCurrency'],
    rawSymbol: item.rawSymbol,
    price: item.price,
    change24h: item.change24h,
    volume24h: item.volume24h,
    high24h: item.high24h,
    low24h: item.low24h,
    timestamp: item.timestamp,
  };
}

function fromCachedOrderbook(item: NonNullable<ReturnType<typeof publicMarketDataStore.getOrderbook>>): CanonicalOrderbookSnapshot {
  return {
    exchange: item.exchange as ExchangeId,
    symbol: item.symbol,
    market: item.market,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency as CanonicalOrderbookSnapshot['quoteCurrency'],
    rawSymbol: item.rawSymbol,
    asks: item.asks.map((level) => ({ price: level.price, quantity: level.qty })),
    bids: item.bids.map((level) => ({ price: level.price, quantity: level.qty })),
    bestAsk: item.bestAsk,
    bestBid: item.bestBid,
    spread: Math.max(item.bestAsk - item.bestBid, 0),
    timestamp: item.timestamp,
  };
}

function fromCachedTrade(item: ReturnType<typeof publicMarketDataStore.getTrades>[number]): CanonicalTrade {
  return {
    exchange: item.exchange as ExchangeId,
    symbol: item.symbol,
    market: item.market,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency as CanonicalTrade['quoteCurrency'],
    rawSymbol: item.rawSymbol,
    tradeId: item.tradeId,
    side: item.side,
    price: item.price,
    quantity: item.quantity,
    notional: item.price * item.quantity,
    timestamp: item.timestamp,
  };
}

export async function listMarkets(exchange?: ExchangeId) {
  const providers = exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();

  const results = await Promise.allSettled(
    providers.map(async (provider) => {
      const markets = await provider.listMarkets();
      return markets.map((item) => ({
        exchange: provider.exchange,
        exchangeName: provider.metadata.displayName,
        symbol: item.symbol,
        market: item.market,
        rawSymbol: item.rawSymbol,
        quoteCurrency: provider.metadata.quoteCurrency,
        nameKo: COIN_MAP.get(item.symbol)?.nameKo,
        nameEn: COIN_MAP.get(item.symbol)?.nameEn,
      }));
    }),
  );

  return results.flatMap((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    const provider = providers[index];
    logger.warn(
      { domain: 'market-routes', exchange: provider.exchange, capability: 'markets', err: result.reason },
      'Falling back to static market catalog',
    );
    return fallbackMarkets(provider.exchange);
  });
}

export async function getTickers(params: { exchange?: ExchangeId; symbol?: string }) {
  const providers = params.exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(params.exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();
  const symbols = params.symbol ? [assertSupportedSymbol(params.symbol)] : undefined;
  const results = await Promise.allSettled(providers.map((provider) => provider.getTickerSnapshot(symbols)));

  return results
    .flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      const provider = providers[index];
      logger.warn(
        { domain: 'market-routes', exchange: provider.exchange, capability: 'ticker', err: result.reason },
        'Falling back to cached ticker data',
      );
      return publicMarketDataStore.getTickers(provider.exchange, symbols?.[0]).map(fromCachedTicker);
    })
    .map((item) => withFreshness(item, item.timestamp));
}

export async function getOrderbook(exchange: ExchangeId, symbol: string): Promise<CanonicalOrderbookSnapshot> {
  const canonical = assertSupportedSymbol(symbol);
  try {
    const orderbook = await exchangeProviderRegistry.getMarketDataProvider(exchange).getOrderbookSnapshot(canonical);
    return withFreshness(orderbook, orderbook.timestamp);
  } catch (error) {
    logger.warn(
      { domain: 'market-routes', exchange, symbol: canonical, capability: 'orderbook', err: error },
      'Falling back to cached orderbook data',
    );
    const cached = publicMarketDataStore.getOrderbook(exchange, canonical);
    if (cached) {
      const snapshot = fromCachedOrderbook(cached);
      return withFreshness(snapshot, snapshot.timestamp);
    }
    throw new AppError(503, `${exchange} orderbook is temporarily unavailable`);
  }
}

export async function getTrades(exchange: ExchangeId, symbol: string, limit?: number): Promise<CanonicalTrade[]> {
  const canonical = assertSupportedSymbol(symbol);
  try {
    const trades = await exchangeProviderRegistry.getMarketDataProvider(exchange).getRecentTrades(canonical, limit);
    if (trades.length > 0) {
      return trades.map((item) => withFreshness(item, item.timestamp));
    }
  } catch (error) {
    logger.warn(
      { domain: 'market-routes', exchange, symbol: canonical, capability: 'trades', err: error },
      'Falling back to cached trade data',
    );
  }

  return publicMarketDataStore.getTrades(exchange, canonical, limit ?? 50).map((item) => withFreshness(fromCachedTrade(item), item.timestamp));
}

export async function getCandles(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  limit?: number,
): Promise<CanonicalCandle[]> {
  const resolved = resolveExchangeInterval(exchange, interval);
  if (!resolved) {
    throw new AppError(400, `${exchange} interval ${interval} is unsupported`);
  }

  return (await exchangeProviderRegistry.getMarketDataProvider(exchange).getCandles(
    assertSupportedSymbol(symbol),
    resolved.resolvedInterval,
    limit,
  )).map((item) => withFreshness(item, item.closeTime));
}

export async function getReferenceTicker(symbol: string) {
  return exchangeProviderRegistry.getReferencePriceSource().getReferenceTicker(symbol);
}
