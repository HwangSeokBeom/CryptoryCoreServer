import { COINS, COIN_MAP, EXCHANGES } from '../../config/constants';
import { getKimchiPremium as getCanonicalKimchiPremium } from '../../domains/kimchi-premium/kimchi-premium.service';
import { getAdapter } from '../../exchanges/ExchangeManager';
import type { NormalizedCandle } from '../../exchanges/ExchangeAdapter';
import { logger } from '../../utils/logger';
import { publicMarketDataStore } from './market.data.store';
import {
  buildUnifiedMarketName,
  getMarketCatalog,
  isDomesticExchange,
  isSupportedSymbol,
  searchMarketCatalog,
  toExchangeMarketSymbol,
  toUnifiedSymbol,
} from './market.normalization';
import type {
  MarketCatalogEntry,
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
} from './market.types';

export function listPublicMarkets(exchange?: string): MarketCatalogEntry[] {
  const catalog = getMarketCatalog();
  if (!exchange) return catalog;
  return catalog.filter((entry) => entry.exchange === exchange);
}

export function searchPublicMarkets(query: string, exchange?: string): MarketCatalogEntry[] {
  const matches = searchMarketCatalog(query);
  if (!exchange) return matches;
  return matches.filter((entry) => entry.exchange === exchange);
}

function mapRestTicker(exchange: string, ticker: {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}): NormalizedMarketTicker {
  const symbol = toUnifiedSymbol(ticker.symbol);
  return {
    channel: 'tickers',
    exchange,
    symbol,
    market: buildUnifiedMarketName(exchange, symbol),
    baseCurrency: symbol,
    quoteCurrency: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    rawSymbol: toExchangeMarketSymbol(exchange, symbol),
    timestamp: ticker.timestamp,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
  };
}

export async function getPublicTickers(params: {
  exchange?: string;
  symbol?: string;
}): Promise<NormalizedMarketTicker[]> {
  const symbol = params.symbol ? toUnifiedSymbol(params.symbol) : undefined;
  const cached = publicMarketDataStore.getTickers(params.exchange, symbol);
  if (cached.length > 0) {
    return cached;
  }

  if (params.exchange) {
    const adapter = getAdapter(params.exchange);
    if (!adapter) return [];
    const tickers = await adapter.fetchTickers(symbol ? [symbol] : COINS.map((coin) => coin.symbol));
    return tickers.map((ticker) => mapRestTicker(params.exchange!, ticker));
  }

  const results = await Promise.all(
    EXCHANGES.map(async (exchange) => {
      try {
        const adapter = getAdapter(exchange.id);
        if (!adapter) return [];
        const tickers = await adapter.fetchTickers(symbol ? [symbol] : COINS.map((coin) => coin.symbol));
        return tickers.map((ticker) => mapRestTicker(exchange.id, ticker));
      } catch (err) {
        logger.warn({ domain: 'public-market', exchange: exchange.id, err }, 'Failed to fetch fallback public tickers');
        return [];
      }
    }),
  );

  return results.flat();
}

export async function getPublicOrderbook(
  symbol: string,
  exchange: string,
): Promise<NormalizedMarketOrderbook | null> {
  const unifiedSymbol = toUnifiedSymbol(symbol);
  const cached = publicMarketDataStore.getOrderbook(exchange, unifiedSymbol);
  if (cached) return cached;

  const adapter = getAdapter(exchange);
  if (!adapter) return null;
  const orderbook = await adapter.fetchOrderbook(unifiedSymbol, 15);

  return {
    channel: 'orderbook',
    exchange,
    symbol: unifiedSymbol,
    market: buildUnifiedMarketName(exchange, unifiedSymbol),
    baseCurrency: unifiedSymbol,
    quoteCurrency: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    rawSymbol: toExchangeMarketSymbol(exchange, unifiedSymbol),
    timestamp: Date.now(),
    asks: orderbook.asks,
    bids: orderbook.bids,
    bestAsk: orderbook.asks[0]?.price ?? 0,
    bestBid: orderbook.bids[0]?.price ?? 0,
  };
}

export function getPublicTrades(
  symbol: string,
  exchange: string,
  limit = 50,
): NormalizedMarketTrade[] {
  return publicMarketDataStore.getTrades(exchange, toUnifiedSymbol(symbol), limit);
}

export async function getPublicCandles(
  symbol: string,
  exchange: string,
  period: string,
  limit: number,
): Promise<NormalizedCandle[]> {
  const unifiedSymbol = toUnifiedSymbol(symbol);
  if (!isSupportedSymbol(unifiedSymbol)) return [];

  const adapter = getAdapter(exchange);
  if (!adapter) return [];
  return adapter.fetchCandles(unifiedSymbol, period, limit);
}

export async function getPublicKimchiPremium(symbols: string[]) {
  const results = await getCanonicalKimchiPremium(symbols.map((symbol) => toUnifiedSymbol(symbol)));

  return results.map((item) => ({
    symbol: item.symbol,
    nameKo: item.nameKo,
    nameEn: item.nameEn,
    binanceKrwPrice: item.binanceKrwPrice,
    premiums: item.domestic.map((premium) => ({
      exchange: premium.exchange,
      exchangeName: EXCHANGES.find((exchange) => exchange.id === premium.exchange)?.name ?? premium.exchange,
      domesticPrice: premium.priceKrw,
      premiumPercent: premium.premiumPercent,
    })),
  }));
}
