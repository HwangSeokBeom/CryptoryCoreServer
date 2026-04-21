import { COINS, COIN_MAP, EXCHANGES } from '../../config/constants';
import {
  assetMetadataService,
  type AssetImageAvailability,
  type AssetMetadataLookup,
  type AssetMetadataView,
} from '../../domains/assets/asset-metadata.service';
import { getKimchiPremium as getCanonicalKimchiPremium } from '../../domains/kimchi-premium/kimchi-premium.service';
import type { DomesticExchangeId, ExchangeId, QuoteCurrency } from '../../core/exchange/exchange.types';
import { buildCanonicalMarketMetadata } from '../../core/exchange/market-metadata';
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
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  fallbackType?: string | null;
}) {
  logger.info(
    {
      domain: 'asset-image',
      action: 'projection_included',
      route: params.route,
      symbol: params.symbol,
      canonicalAssetKey: params.canonicalAssetKey ?? null,
      hasImage: Boolean(params.assetImageUrl),
      imageAvailability: params.imageAvailability ?? null,
      imageFailureReason: params.imageFailureReason ?? null,
      fallbackType: params.fallbackType ?? null,
    },
    `[AssetImageDebug] action=projection_included route=${params.route} symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey ?? 'null'} hasImage=${Boolean(params.assetImageUrl)} availability=${params.imageAvailability ?? 'null'}`,
  );
}

function isDefaultPlaceholderAssetImage(view: AssetMetadataView | undefined, imageUrl: string | null | undefined) {
  return Boolean(imageUrl)
    && (view?.fallbackType === 'default_placeholder'
      || view?.source === 'placeholder');
}

function toUsableAssetImageUrl(view: AssetMetadataView | undefined, fallbackUrl: string | null | undefined) {
  const imageUrl = view?.assetImageUrl ?? fallbackUrl ?? null;
  return isDefaultPlaceholderAssetImage(view, imageUrl) ? null : imageUrl;
}

function buildAssetImageFields(view: AssetMetadataView | undefined, assetImageUrl: string | null, canonicalAssetKey?: string | null) {
  const imageAvailability = assetImageUrl
    ? view?.fallbackHit ? 'fallback' as const : 'available' as const
    : view?.imageAvailability ?? (canonicalAssetKey ? 'pending' as const : 'unavailable' as const);
  return {
    imageUrl: assetImageUrl,
    imageURL: assetImageUrl,
    hasImage: Boolean(assetImageUrl),
    imageAvailability,
    imageFailureReason: view?.failureReason ?? null,
    fallbackType: view?.fallbackType ?? null,
    assetType: view?.assetType ?? null,
    canonicalName: view?.canonicalName ?? null,
    fallbackColor: view?.fallbackColor ?? null,
    fallbackInitials: view?.fallbackInitials ?? null,
  };
}

async function getAssetViewsForProjection(
  lookups: AssetMetadataLookup[],
  context: string,
): Promise<Map<string, AssetMetadataView>> {
  const service = assetMetadataService as typeof assetMetadataService & {
    getAssetViewsSafely?: (
      lookups: AssetMetadataLookup[],
      context: string,
    ) => Promise<Map<string, AssetMetadataView>>;
  };

  if (typeof service.getAssetViewsSafely === 'function') {
    return service.getAssetViewsSafely(lookups, context);
  }

  try {
    return await service.getAssetViews(lookups);
  } catch (error) {
    logger.warn(
      {
        domain: 'asset-image',
        action: 'asset_view_lookup_failed',
        context,
        err: error,
      },
      `[AssetImageDebug] action=asset_view_lookup_failed context=${context}`,
    );
    return new Map<string, AssetMetadataView>();
  }
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
  const rawSymbol = toExchangeMarketSymbol(exchange, symbol);
  const metadata = buildCanonicalMarketMetadata({
    exchange: exchange as ExchangeId,
    symbol,
    marketId: rawSymbol,
    rawSymbol,
    baseAsset: symbol,
    quoteAsset: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    isActive: true,
    capabilities: {
      candles: true,
      orderbook: true,
      trades: true,
    },
  });
  return {
    channel: 'tickers',
    exchange,
    marketId: metadata.marketId,
    canonicalSymbol: metadata.canonicalSymbol,
    baseAsset: metadata.baseAsset,
    quoteAsset: metadata.quoteAsset,
    displaySymbol: metadata.displaySymbol,
    koreanName: metadata.koreanName,
    englishName: metadata.englishName,
    iconUrl: metadata.iconUrl,
    isActive: metadata.isActive,
    capabilities: metadata.capabilities,
    symbol,
    canonicalAssetKey: symbol,
    assetImageUrl: metadata.iconUrl,
    market: buildUnifiedMarketName(exchange, symbol),
    baseCurrency: symbol,
    quoteCurrency: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    rawSymbol,
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

  const views = await getAssetViewsForProjection(tickers.map((ticker) => ({
    symbol: ticker.symbol,
    exchangeSymbol: ticker.rawSymbol,
    exchange: ticker.exchange as ExchangeId,
    displayName: COIN_MAP.get(ticker.symbol)?.nameKo ?? COIN_MAP.get(ticker.symbol)?.nameEn ?? ticker.symbol,
    canonicalAssetKey: ticker.canonicalAssetKey ?? ticker.symbol,
  })), '/api/v1/public/tickers');

  return tickers.map((ticker) => {
    const view = views.get(ticker.canonicalAssetKey ?? ticker.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? ticker.canonicalAssetKey ?? ticker.symbol;
    const assetImageUrl = toUsableAssetImageUrl(view, ticker.assetImageUrl ?? ticker.iconUrl ?? null);
    const imageFields = buildAssetImageFields(view, assetImageUrl, canonicalAssetKey);
    const metadata = buildCanonicalMarketMetadata({
      exchange: ticker.exchange as ExchangeId,
      symbol: ticker.canonicalSymbol ?? ticker.symbol,
      marketId: ticker.marketId ?? ticker.rawSymbol,
      rawSymbol: ticker.rawSymbol,
      baseAsset: ticker.baseAsset ?? ticker.baseCurrency,
      quoteAsset: (ticker.quoteAsset ?? ticker.quoteCurrency) as QuoteCurrency,
      isActive: ticker.isActive,
      capabilities: ticker.capabilities,
    });
    const projected = {
      ...ticker,
      marketId: ticker.marketId ?? metadata.marketId,
      canonicalSymbol: ticker.canonicalSymbol ?? metadata.canonicalSymbol,
      baseAsset: ticker.baseAsset ?? metadata.baseAsset,
      quoteAsset: ticker.quoteAsset ?? metadata.quoteAsset,
      displaySymbol: ticker.displaySymbol ?? metadata.displaySymbol,
      koreanName: ticker.koreanName ?? metadata.koreanName,
      englishName: ticker.englishName ?? metadata.englishName,
      isActive: ticker.isActive ?? metadata.isActive,
      capabilities: ticker.capabilities ?? metadata.capabilities,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? ticker.iconUrl ?? metadata.iconUrl,
      assetImageUrl,
      ...imageFields,
    };
    logAssetImageProjection({
      route: '/api/v1/public/tickers',
      symbol: projected.symbol,
      canonicalAssetKey: projected.canonicalAssetKey,
      assetImageUrl: projected.assetImageUrl,
      imageAvailability: projected.imageAvailability,
      imageFailureReason: projected.imageFailureReason,
      fallbackType: projected.fallbackType,
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
  const rawSymbol = toExchangeMarketSymbol(exchange, unifiedSymbol);
  const metadata = buildCanonicalMarketMetadata({
    exchange: exchange as ExchangeId,
    symbol: unifiedSymbol,
    marketId: rawSymbol,
    rawSymbol,
    baseAsset: unifiedSymbol,
    quoteAsset: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    isActive: true,
    capabilities: {
      candles: true,
      orderbook: true,
      trades: true,
    },
  });

  return {
    channel: 'orderbook',
    exchange,
    marketId: metadata.marketId,
    canonicalSymbol: metadata.canonicalSymbol,
    baseAsset: metadata.baseAsset,
    quoteAsset: metadata.quoteAsset,
    displaySymbol: metadata.displaySymbol,
    koreanName: metadata.koreanName,
    englishName: metadata.englishName,
    iconUrl: metadata.iconUrl,
    isActive: metadata.isActive,
    capabilities: metadata.capabilities,
    symbol: unifiedSymbol,
    market: buildUnifiedMarketName(exchange, unifiedSymbol),
    baseCurrency: unifiedSymbol,
    quoteCurrency: EXCHANGES.find((item) => item.id === exchange)?.quoteCurrency ?? 'KRW',
    rawSymbol,
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

  const views = await getAssetViewsForProjection(rows.map((row) => ({
    symbol: row.symbol,
    displayName: row.nameKo ?? row.nameEn ?? row.symbol,
    canonicalAssetKey: row.canonicalAssetKey,
  })), '/api/v1/public/kimchi-premium');

  return rows.map((row) => {
    const view = views.get(row.canonicalAssetKey ?? row.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? row.canonicalAssetKey ?? row.symbol;
    const assetImageUrl = toUsableAssetImageUrl(view, row.assetImageUrl ?? null);
    const imageFields = buildAssetImageFields(view, assetImageUrl, canonicalAssetKey);
    const projected = {
      ...row,
      canonicalAssetKey,
      iconUrl: assetImageUrl,
      assetImageUrl,
      ...imageFields,
    };
    logAssetImageProjection({
      route: '/api/v1/public/kimchi-premium',
      symbol: projected.symbol,
      canonicalAssetKey: projected.canonicalAssetKey,
      assetImageUrl: projected.assetImageUrl,
      imageAvailability: projected.imageAvailability,
      imageFailureReason: projected.imageFailureReason,
      fallbackType: projected.fallbackType,
    });
    return projected;
  });
}
