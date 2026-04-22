import { COINS, COIN_MAP, EXCHANGES } from '../../config/constants';
import { buildImageFallbackKey, getAssetRegistryMetadata, resolvePreferredAssetImage } from '../../core/exchange/asset.registry';
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

function hasPromotablePreferredImage(preferredImage: ReturnType<typeof resolvePreferredAssetImage>) {
  return Boolean(
    preferredImage.preferredImageSlug
    && preferredImage.preferredImageCoingeckoId
    && !preferredImage.fallbackOnly,
  );
}

function buildAssetImageFields(params: {
  view: AssetMetadataView | undefined;
  assetImageUrl: string | null;
  exchange?: ExchangeId;
  symbol: string;
  rawSymbol?: string | null;
  marketId?: string | null;
  canonicalAssetKey?: string | null;
}) {
  const preferredImage = resolvePreferredAssetImage({
    exchange: params.exchange ?? null,
    canonicalAssetKey: params.canonicalAssetKey ?? null,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol ?? null,
    marketId: params.marketId ?? null,
  });
  const identityMetadata = params.canonicalAssetKey
    ? getAssetRegistryMetadata(params.canonicalAssetKey, params.symbol)
    : null;
  const assetSlug = params.view?.assetSlug ?? preferredImage.preferredImageSlug ?? identityMetadata?.assetSlug ?? null;
  const imageFallbackKey = params.view?.imageFallbackKey ?? buildImageFallbackKey({
    exchange: params.exchange,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol ?? null,
    marketId: params.marketId ?? null,
    canonicalAssetKey: params.canonicalAssetKey ?? null,
    assetSlug,
    coingeckoId: params.view?.coingeckoId ?? preferredImage.preferredImageCoingeckoId ?? null,
  });
  const imageAvailability = params.assetImageUrl
    ? params.view?.fallbackHit ? 'fallback' as const : 'available' as const
    : params.view?.imageAvailability ?? (params.canonicalAssetKey ? 'pending' as const : 'unavailable' as const);
  const promotablePreferredImage = hasPromotablePreferredImage(preferredImage);
  const imageMissingReason = params.assetImageUrl
    ? null
    : !params.canonicalAssetKey
      ? 'unsupported_asset'
      : params.view?.failureReason === 'alias_not_found'
        ? promotablePreferredImage
          ? 'curated_slug_resolved_but_source_merge_failed'
          : preferredImage.imageMissingReason ?? 'alias_miss'
        : params.view?.failureReason === 'coingecko_fetch_failed'
          ? promotablePreferredImage
            ? 'curated_slug_resolved_but_cache_stale'
            : 'upstream_fetch_failed'
          : params.view?.failureReason === 'image_url_empty' || params.view?.failureReason === 'no_image_url' || params.view?.fallbackType === 'default_placeholder' || params.view?.source === 'placeholder'
            ? promotablePreferredImage
              ? 'curated_slug_resolved_but_metadata_missing'
              : 'source_metadata_absent'
            : params.view?.fallbackType === 'stale_cache' || params.view?.source === 'stale_cache'
              ? promotablePreferredImage
                ? 'curated_slug_resolved_but_cache_stale'
                : 'metadata_pending'
            : imageAvailability === 'pending'
              ? promotablePreferredImage
                ? 'curated_slug_resolved_but_cache_stale'
                : preferredImage.imageMissingReason ?? 'metadata_pending'
              : 'no_image_url';
  return {
    imageUrl: params.assetImageUrl,
    imageURL: params.assetImageUrl,
    hasImage: Boolean(params.assetImageUrl),
    imageAvailability,
    imageFailureReason: params.view?.failureReason ?? imageMissingReason,
    imageMissingReason,
    fallbackType: params.view?.fallbackType ?? null,
    assetType: params.view?.assetType ?? identityMetadata?.assetType ?? null,
    canonicalName: params.view?.canonicalName ?? identityMetadata?.canonicalName ?? null,
    fallbackColor: params.view?.fallbackColor ?? identityMetadata?.fallbackColor ?? null,
    fallbackInitials: params.view?.fallbackInitials ?? identityMetadata?.fallbackInitials ?? null,
    assetSlug,
    imageFallbackKey,
    fallbackKey: imageFallbackKey,
    stableImageKey: imageFallbackKey,
    imageLookupKey: imageFallbackKey,
    preferredImageSymbol: params.view?.preferredImageSymbol ?? preferredImage.preferredImageSymbol ?? null,
    preferredImageSlug: params.view?.preferredImageSlug ?? preferredImage.preferredImageSlug ?? assetSlug ?? null,
    imageResolutionSource: params.assetImageUrl
      ? (params.view?.source === 'curated' || params.view?.source === 'coingecko' ? 'direct_slug' : 'alias_map')
      : promotablePreferredImage
        ? preferredImage.resolutionSource.startsWith('registry')
          ? 'registry_identity'
          : preferredImage.resolutionSource.includes('override')
            ? 'alias_map'
            : 'direct_slug'
      : preferredImage.fallbackOnly
        ? 'fallback_only'
        : preferredImage.resolutionSource.startsWith('registry')
          ? 'registry_identity'
          : preferredImage.resolutionSource,
    resolutionStage: params.assetImageUrl
      ? 'projection_applied'
      : preferredImage.fallbackOnly
        ? 'fallback_only'
        : promotablePreferredImage
          ? 'preferred_image_resolved'
          : 'canonical_resolved',
    manualCurationRecommended: params.view?.manualCurationRecommended ?? preferredImage.manualCurationRecommended,
    fallbackOnly: preferredImage.fallbackOnly,
  };
}

async function getAssetViewsForProjection(
  lookups: AssetMetadataLookup[],
  context: string,
  options?: { eager?: boolean },
): Promise<Map<string, AssetMetadataView>> {
  const service = assetMetadataService as typeof assetMetadataService & {
    getAssetViewsEager?: (
      lookups: AssetMetadataLookup[],
    ) => Promise<Map<string, AssetMetadataView>>;
    getAssetViewsSafely?: (
      lookups: AssetMetadataLookup[],
      context: string,
    ) => Promise<Map<string, AssetMetadataView>>;
  };

  if (options?.eager && typeof service.getAssetViewsEager === 'function') {
    try {
      return await service.getAssetViewsEager(lookups);
    } catch (error) {
      logger.warn(
        {
          domain: 'asset-image',
          action: 'asset_view_lookup_failed',
          context,
          eager: true,
          err: error,
        },
        `[AssetImageDebug] action=asset_view_lookup_failed context=${context} eager=true`,
      );
      return new Map<string, AssetMetadataView>();
    }
  }

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

function buildImageDebugPayload(params: {
  canonicalSymbol: string;
  assetSlug?: string | null;
  preferredImageSlug?: string | null;
  imageResolutionSource?: string | null;
  imageMissingReason?: string | null;
}) {
  return {
    canonicalSymbol: params.canonicalSymbol,
    assetSlug: params.assetSlug ?? null,
    preferredImageSlug: params.preferredImageSlug ?? null,
    imageResolutionSource: params.imageResolutionSource ?? null,
    imageMissingReason: params.imageMissingReason ?? null,
  };
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
  debug?: boolean;
}): Promise<NormalizedMarketTicker[]> {
  const symbol = params.symbol ? toUnifiedSymbol(params.symbol) : undefined;
  const cached = publicMarketDataStore.getTickers(params.exchange, symbol);
  if (cached.length > 0) {
    return decoratePublicTickers(cached, { debug: params.debug });
  }

  if (params.exchange) {
    const adapter = getAdapter(params.exchange);
    if (!adapter) return [];
    const tickers = await adapter.fetchTickers(symbol ? [symbol] : COINS.map((coin) => coin.symbol));
    return decoratePublicTickers(tickers.map((ticker) => mapRestTicker(params.exchange!, ticker)), { debug: params.debug });
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

  return decoratePublicTickers(results.flat(), { debug: params.debug });
}

async function decoratePublicTickers(tickers: NormalizedMarketTicker[], options?: { debug?: boolean }) {
  if (tickers.length === 0) {
    return tickers;
  }

  const views = await getAssetViewsForProjection(tickers.map((ticker) => ({
    symbol: ticker.symbol,
    exchangeSymbol: ticker.rawSymbol,
    exchange: ticker.exchange as ExchangeId,
    displayName: COIN_MAP.get(ticker.symbol)?.nameEn ?? COIN_MAP.get(ticker.symbol)?.nameKo ?? ticker.symbol,
    canonicalAssetKey: ticker.canonicalAssetKey ?? ticker.symbol,
  })), '/api/v1/public/tickers', {
    eager: options?.debug,
  });

  return tickers.map((ticker) => {
    const view = views.get(ticker.canonicalAssetKey ?? ticker.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? ticker.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, ticker.assetImageUrl ?? ticker.iconUrl ?? null);
    const imageFields = buildAssetImageFields({
      view,
      assetImageUrl,
      exchange: ticker.exchange as ExchangeId,
      symbol: ticker.symbol,
      rawSymbol: ticker.rawSymbol,
      marketId: ticker.marketId ?? ticker.rawSymbol,
      canonicalAssetKey,
    });
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
      ...(options?.debug
        ? {
          imageDebug: buildImageDebugPayload({
            canonicalSymbol: ticker.canonicalSymbol ?? metadata.canonicalSymbol,
            assetSlug: imageFields.assetSlug,
            preferredImageSlug: imageFields.preferredImageSlug,
            imageResolutionSource: imageFields.imageResolutionSource,
            imageMissingReason: imageFields.imageMissingReason,
          }),
        }
        : {}),
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

export async function getPublicKimchiPremium(symbols: string[], options?: { venues?: DomesticExchangeId[]; debug?: boolean }) {
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
  })), '/api/v1/public/kimchi-premium', {
    eager: options?.debug,
  });

  return rows.map((row) => {
    const view = views.get(row.canonicalAssetKey ?? row.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? row.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, row.assetImageUrl ?? null);
    const imageFields = buildAssetImageFields({
      view,
      assetImageUrl,
      symbol: row.symbol,
      canonicalAssetKey,
    });
    const projected = {
      ...row,
      canonicalAssetKey,
      iconUrl: assetImageUrl,
      assetImageUrl,
      ...imageFields,
      ...(options?.debug
        ? {
          imageDebug: buildImageDebugPayload({
            canonicalSymbol: row.symbol,
            assetSlug: imageFields.assetSlug,
            preferredImageSlug: imageFields.preferredImageSlug,
            imageResolutionSource: imageFields.imageResolutionSource,
            imageMissingReason: imageFields.imageMissingReason,
          }),
        }
        : {}),
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
