import { COINS, COIN_MAP, EXCHANGES } from '../../config/constants';
import { assetMetadataService } from '../../domains/assets/asset-metadata.service';
import { getKimchiPremium as getCanonicalKimchiPremium } from '../../domains/kimchi-premium/kimchi-premium.service';
import type { DomesticExchangeId, ExchangeId } from '../../core/exchange/exchange.types';
import { getAdapter } from '../../exchanges/ExchangeManager';
import type { NormalizedCandle } from '../../exchanges/ExchangeAdapter';
import { logger } from '../../utils/logger';
import { resolveCandleSnapshot, type CandleResponseMeta } from '../../domains/charts/candle.snapshot';
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

function logAssetImageProjection(params: {
  route: string;
  symbol: string;
  canonicalAssetKey: string | null | undefined;
  assetImageUrl: string | null | undefined;
}) {
  logger.info(
    {
      domain: 'asset-image',
      action: 'projection_included',
      route: params.route,
      symbol: params.symbol,
      canonicalAssetKey: params.canonicalAssetKey ?? null,
      hasImage: Boolean(params.assetImageUrl),
    },
    `[AssetImageDebug] action=projection_included route=${params.route} symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey ?? 'null'} hasImage=${Boolean(params.assetImageUrl)}`,
  );
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
    canonicalAssetKey: symbol,
    assetImageUrl: null,
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
    return decoratePublicTickers(cached);
  }

  if (params.exchange) {
    const adapter = getAdapter(params.exchange);
    if (!adapter) return [];
    const tickers = await adapter.fetchTickers(symbol ? [symbol] : COINS.map((coin) => coin.symbol));
    return decoratePublicTickers(tickers.map((ticker) => mapRestTicker(params.exchange!, ticker)));
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

  return decoratePublicTickers(results.flat());
}

async function decoratePublicTickers(tickers: NormalizedMarketTicker[]) {
  if (tickers.length === 0) {
    return tickers;
  }

  const views = await assetMetadataService.getAssetViews(tickers.map((ticker) => ({
    symbol: ticker.symbol,
    exchangeSymbol: ticker.rawSymbol,
    exchange: ticker.exchange as ExchangeId,
    displayName: COIN_MAP.get(ticker.symbol)?.nameKo ?? COIN_MAP.get(ticker.symbol)?.nameEn ?? ticker.symbol,
    canonicalAssetKey: ticker.canonicalAssetKey ?? ticker.symbol,
  })));

  return tickers.map((ticker) => {
    const view = views.get(ticker.canonicalAssetKey ?? ticker.symbol);
    const projected = {
      ...ticker,
      canonicalAssetKey: view?.canonicalAssetKey ?? ticker.canonicalAssetKey ?? ticker.symbol,
      assetImageUrl: view?.assetImageUrl ?? ticker.assetImageUrl ?? null,
    };
    logAssetImageProjection({
      route: '/api/v1/public/tickers',
      symbol: projected.symbol,
      canonicalAssetKey: projected.canonicalAssetKey,
      assetImageUrl: projected.assetImageUrl,
    });
    return projected;
  });
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
  return (await getPublicCandlesWithMeta(symbol, exchange, period, limit)).items;
}

function buildUnavailableCandleMeta(reason: string): CandleResponseMeta {
  return {
    isRenderable: false,
    freshnessState: 'unavailable',
    lastSuccessfulAt: null,
    source: 'fallback',
    fallbackReason: reason,
    pointCount: 0,
    renderPriority: 'unavailable',
    refreshPriority: 'normal',
    recommendedClientBehavior: 'cold_placeholder_only',
  };
}

export async function getPublicCandlesWithMeta(
  symbol: string,
  exchange: string,
  period: string,
  limit: number,
): Promise<{ items: NormalizedCandle[]; meta: CandleResponseMeta }> {
  const unifiedSymbol = toUnifiedSymbol(symbol);
  if (!isSupportedSymbol(unifiedSymbol)) {
    return { items: [], meta: buildUnavailableCandleMeta('unsupported_symbol') };
  }

  const adapter = getAdapter(exchange);
  if (!adapter) {
    return { items: [], meta: buildUnavailableCandleMeta('unsupported_exchange') };
  }
  const snapshot = await resolveCandleSnapshot({
    exchange: exchange as Parameters<typeof resolveCandleSnapshot>[0]['exchange'],
    symbol: unifiedSymbol,
    interval: period,
    limit,
  });

  if (snapshot.support === 'unsupported' || snapshot.status === 'unavailable' || snapshot.status === 'failed') {
    return { items: [], meta: snapshot.meta };
  }

  return {
    items: snapshot.items.map((item) => ({
      time: item.closeTime,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    })),
    meta: snapshot.meta,
  };
}

export async function getPublicKimchiPremium(symbols: string[], options?: { venues?: DomesticExchangeId[] }) {
  const results = await getCanonicalKimchiPremium(symbols.map((symbol) => toUnifiedSymbol(symbol)), options);
  const rows = results.map((item) => ({
    symbol: item.symbol,
    canonicalAssetKey: item.symbol,
    assetImageUrl: null,
    nameKo: item.nameKo,
    nameEn: item.nameEn,
    status: item.status,
    selectedExchange: item.selectedExchange,
    sourceExchange: item.sourceExchange,
    freshnessState: item.freshnessState,
    freshnessReason: item.freshnessReason,
    displayMeta: item.displayMeta,
    stableStatus: item.stableStatus,
    hasUsableDomesticPrice: item.hasUsableDomesticPrice,
    hasUsableReferencePrice: item.hasUsableReferencePrice,
    hasUsableFxRate: item.hasUsableFxRate,
    lastSuccessfulDomesticAt: item.lastSuccessfulDomesticAt,
    lastSuccessfulReferenceAt: item.lastSuccessfulReferenceAt,
    lastSuccessfulFxAt: item.lastSuccessfulFxAt,
    delayBucket: item.delayBucket,
    displayHint: item.displayHint,
    updatedAt: item.updatedAt,
    computedAt: item.computedAt,
    domesticPriceTimestamp: item.domesticPriceTimestamp,
    globalPriceTimestamp: item.globalPriceTimestamp,
    fxRateTimestamp: item.fxRateTimestamp,
    freshnessMs: item.freshnessMs,
    missingFields: item.missingFields,
    failureStage: item.failureStage,
    binanceKrwPrice: item.binanceKrwPrice,
    convertedReferencePrice: item.krwConvertedReference,
    domesticPrice: item.domesticPrice,
    premiumPercent: item.premiumPercent,
    sparkline: item.sparkline,
    sparklinePoints: item.sparklinePoints,
    sparklinePointCount: item.sparklinePointCount,
    sparklineStatus: item.sparklineStatus,
    pointCount: item.pointCount,
    rangeMin: item.rangeMin,
    rangeMax: item.rangeMax,
    lastUpdatedAt: item.sparklineLastUpdatedAt,
    premiums: item.domestic.map((premium) => ({
      exchange: premium.exchange,
      exchangeName: EXCHANGES.find((exchange) => exchange.id === premium.exchange)?.name ?? premium.exchange,
      domesticPrice: premium.priceKrw,
      premiumPercent: premium.premiumPercent,
      reason: premium.reason ?? null,
    })),
  }));
  if (rows.length === 0) {
    return rows;
  }

  const views = await assetMetadataService.getAssetViews(rows.map((row) => ({
    symbol: row.symbol,
    displayName: row.nameKo ?? row.nameEn ?? row.symbol,
    canonicalAssetKey: row.canonicalAssetKey,
  })));

  return rows.map((row) => {
    const view = views.get(row.canonicalAssetKey ?? row.symbol);
    const projected = {
      ...row,
      canonicalAssetKey: view?.canonicalAssetKey ?? row.canonicalAssetKey ?? row.symbol,
      assetImageUrl: view?.assetImageUrl ?? row.assetImageUrl ?? null,
    };
    logAssetImageProjection({
      route: '/api/v1/public/kimchi-premium',
      symbol: projected.symbol,
      canonicalAssetKey: projected.canonicalAssetKey,
      assetImageUrl: projected.assetImageUrl,
    });
    return projected;
  });
}
