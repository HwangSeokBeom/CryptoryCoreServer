import { COIN_MAP } from '../../config/constants';
import {
  buildImageFallbackKey,
  getAssetRegistryMetadata,
  isKnownAssetRegistryKey,
  resolvePreferredAssetImage,
} from '../../core/exchange/asset.registry';
import { DEFAULT_COIN_PLACEHOLDER_ICON_URL, resolveIconUrl } from '../../core/exchange/icon.resolver';
import { buildResolvedMarketCapabilityFlags } from '../../core/exchange/market.contract';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
import { resolveCanonicalAssetKey as resolveCanonicalAssetImageKey, toCanonicalMarket, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import { EXCHANGE_IDS } from '../../core/exchange/exchange.types';
import {
  assetMetadataService,
  hasCuratedAssetMetadata,
  type AssetImageAvailability,
  type AssetMetadataLookup,
  type AssetMetadataView,
} from '../assets/asset-metadata.service';
import type {
  CanonicalCandle,
  CanonicalMarketCapabilities,
  CanonicalMarketMetadata,
  ExchangeMarketDescriptor,
  MarketCapabilityChannel,
  MarketCapabilitySnapshot,
  MarketDataMode,
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  ExchangeId,
  MarketSymbolSupportEntry,
  QuoteCurrency,
  SnapshotErrorCode,
  SnapshotItemStatus,
  SnapshotOverallStatus,
  SnapshotPartialFailure,
  SnapshotSource,
} from '../../core/exchange/exchange.types';
import {
  buildCanonicalMarketMetadataFromDescriptor,
  resolveExchangeMarketInput,
} from '../../core/exchange/market-metadata';
import type { ExchangeMarketDataProvider } from '../../core/exchange/provider.interfaces';
import {
  createFreshnessMetadata,
  getExchangeTickerLoads,
  resolveTickerDataMode,
} from './ticker-snapshot.resolver';
import { resolveCandleSnapshot, type CandleResponseMeta } from '../charts/candle.snapshot';
import { marketIngestHealth } from './market.ingest-health';
import {
  compareRepresentativeSymbols,
  DEFAULT_COMPARABLE_KIMCHI_SYMBOL_LIMIT,
  DEFAULT_MARKET_LIST_LIMIT,
  DEFAULT_MARKET_OVERVIEW_LIMIT,
  DEFAULT_TOP_SNAPSHOT_LIMIT,
  DEFAULT_VISIBLE_SNAPSHOT_LIMIT,
  getRepresentativeMarketSymbolRank,
  getRepresentativeSymbolsForExchange,
  PRIORITY_FRESHNESS_TARGET_MS,
  SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT,
} from './market-priority';
import { marketTrendProjectionStore } from './market-trend.projection';
import { marketEventBus } from '../../modules/public-market/market.event-bus';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import type { NormalizedMarketTicker, NormalizedMarketTrade } from '../../modules/public-market/market.types';
import { logger } from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { buildMarketDataError } from './market-data.errors';

type FreshMarketData<T> = T & {
  dataMode: 'streaming' | 'snapshot' | 'cached_snapshot';
  isStale: boolean;
  lastUpdatedAt: number | null;
  sourceTimestamp: number | null;
  cacheAgeMs: number | null;
  stale: boolean;
  staleAgeMs: number | null;
};

export type MarketCandlesResponse = {
  items: Array<FreshMarketData<CanonicalCandle>>;
  meta: CandleResponseMeta;
  metadata: MarketResponseMetadata;
};

type MarketLookupRequest = string | { symbol?: string; marketId?: string };

type MarketAvailabilityState = 'available' | 'unavailable' | 'unsupported';

type MarketAvailability = {
  candles: MarketAvailabilityState;
  orderbook: MarketAvailabilityState;
  trades: MarketAvailabilityState;
};

type MarketResponseMetadata = CanonicalMarketMetadata & {
  availability: MarketAvailability;
  isChartAvailable: boolean;
  isOrderBookAvailable: boolean;
  isTradesAvailable: boolean;
  unavailableReason: string | null;
};

export type MarketTradesResponse = {
  items: Array<FreshMarketData<CanonicalTrade>>;
  total: number;
  metadata: MarketResponseMetadata;
};

export type MarketSummaryResponse = {
  metadata: MarketResponseMetadata;
  latestTicker: FreshMarketData<CanonicalTickerSnapshot> | null;
  market: MarketResponseMetadata;
  updatedAt: number | null;
};

type SparklinePoint = {
  price: number;
  timestamp: number;
};

type TickerSparklineSource = 'history' | 'derived_change24h' | 'flat_current';
type StableResponseFreshnessBucket = 'fresh' | 'slightly_delayed' | 'delayed' | 'stale' | 'unavailable';
type MarketSparklineResponseSource = 'fresh_cache' | 'stale_cache' | 'provider_fetch' | 'mixed';
type MarketSparklineSymbolSource = Exclude<MarketSparklineResponseSource, 'mixed'>;
type MarketSparklineRenderPriority = 'live' | 'cached' | 'stale' | 'unavailable';
type MarketSparklineLatencyBucket = 'instant' | 'fast' | 'delayed' | 'unavailable';
type MarketSparklineFallbackReason =
  | 'provider_slow'
  | 'provider_empty'
  | 'provider_missing'
  | 'provider_error'
  | 'stale_cache'
  | 'insufficient_points'
  | 'unsupported'
  | 'no_cache';

type MarketSparklineSymbolMeta = {
  symbol: string;
  source: MarketSparklineSymbolSource;
  isRenderable: boolean;
  usable: boolean;
  renderPriority: MarketSparklineRenderPriority;
  pointCount: number;
  lastSuccessfulGraphAt: string | null;
  graphLatencyBucket: MarketSparklineLatencyBucket;
  freshnessBucket: StableResponseFreshnessBucket;
  generatedAt: number;
  fallbackReason?: MarketSparklineFallbackReason;
};

type MarketTickerRow = FreshMarketData<CanonicalTickerSnapshot> & {
  current: number;
  percent: number;
  previousPrice24h: number | null;
  sparkline: number[];
  sparklinePoints: SparklinePoint[];
  sparklineSource: TickerSparklineSource;
};

function assertSupportedSymbol(symbol: string) {
  const normalized = toCanonicalSymbol(symbol);
  if (!normalized) {
    throw new AppError(400, 'symbol is required');
  }
  return normalized;
}

function looksLikeExplicitMarketId(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return /[-_/]/.test(trimmed)
    || /^[a-z0-9]+_(krw|usd|usdt|usdc|fdusd|busd|tusd|usdp|dai|eur|try|brl)$/i.test(trimmed);
}

function normalizeMarketLookupRequest(input: MarketLookupRequest): { symbol?: string; marketId?: string } {
  if (typeof input !== 'string') {
    return input;
  }

  return looksLikeExplicitMarketId(input)
    ? { marketId: input }
    : { symbol: input };
}

function buildAvailability(metadata: CanonicalMarketMetadata, unavailable?: {
  target: 'candles' | 'orderbook' | 'trades';
  state?: MarketAvailabilityState;
  reason?: string | null;
}): MarketResponseMetadata {
  const availability: MarketAvailability = {
    candles: metadata.candlesSupported ? 'available' : 'unsupported',
    orderbook: metadata.capabilities.supportsOrderBook ? 'available' : 'unsupported',
    trades: metadata.capabilities.supportsTrades ? 'available' : 'unsupported',
  };

  if (unavailable) {
    const overrideState = unavailable.state ?? 'unavailable';
    if (overrideState === 'unsupported' || availability[unavailable.target] === 'available') {
      availability[unavailable.target] = overrideState;
    }
  }

  return {
    ...metadata,
    availability,
    isChartAvailable: availability.candles === 'available' && metadata.graphSupported,
    isOrderBookAvailable: availability.orderbook === 'available',
    isTradesAvailable: availability.trades === 'available',
    unavailableReason: unavailable?.reason ?? metadata.unsupportedReason ?? null,
  };
}

function applyMetadataToCanonicalMarket<T extends {
  exchange: ExchangeId;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  rawSymbol: string;
}>(item: T, metadata: CanonicalMarketMetadata): T & CanonicalMarketMetadata {
  return {
    ...item,
    ...metadata,
    symbol: metadata.canonicalSymbol,
    market: metadata.displaySymbol,
    baseCurrency: metadata.baseAsset,
    quoteCurrency: metadata.quoteAsset,
    rawSymbol: metadata.rawSymbol,
    nameKo: metadata.koreanName ?? undefined,
    nameEn: metadata.englishName ?? undefined,
  };
}

function buildCapabilitiesBySymbol(
  exchange: ExchangeId,
  snapshot: MarketCapabilitySnapshot,
  markets: ExchangeMarketDescriptor[],
) {
  return new Map(markets.map((market) => [market.symbol, buildCapabilityFlags(exchange, snapshot, market)]));
}

async function resolveMarketForRequest(
  exchange: ExchangeId,
  request: MarketLookupRequest,
  target: 'candles' | 'orderbook' | 'trades' | 'summary',
): Promise<{
  provider: ExchangeMarketDataProvider;
  market: ExchangeMarketDescriptor;
  metadata: CanonicalMarketMetadata;
  responseMetadata: MarketResponseMetadata;
}> {
  const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
  let markets: ExchangeMarketDescriptor[];
  let capabilitySnapshot: MarketCapabilitySnapshot;
  try {
    markets = (await provider.listMarkets()).filter((market) => market.tradable !== false);
    capabilitySnapshot = await resolveCapabilitySnapshot(provider, markets);
  } catch (error) {
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNAVAILABLE',
      target,
      exchange,
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
  const capabilitiesBySymbol = buildCapabilitiesBySymbol(exchange, capabilitySnapshot, markets);
  const resolved = resolveExchangeMarketInput({
    exchange,
    markets,
    input: normalizeMarketLookupRequest(request),
    capabilitiesBySymbol,
  });

  if (!resolved.ok) {
    const reason = resolved.reason === 'MARKET_ID_NOT_FOUND'
      ? `marketId ${resolved.input} is not listed on ${exchange}`
      : resolved.reason === 'SYMBOL_NOT_FOUND'
        ? `symbol ${resolved.input} could not be resolved to a listed ${exchange} market`
        : 'marketId or symbol is required';
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNSUPPORTED',
      target,
      exchange,
      reason,
      retryable: false,
      statusCode: 400,
    });
  }

  logger.info(
    {
      domain: 'market-routes',
      exchange,
      target,
      rawInput: typeof request === 'string'
        ? request
        : request.marketId ?? request.symbol ?? null,
      marketId: resolved.metadata.marketId,
      canonicalMarketId: resolved.metadata.canonicalMarketId,
      canonicalSymbol: resolved.metadata.canonicalSymbol,
      matchSource: resolved.matchSource,
    },
    `[MarketIdentity] market_identity_normalized exchange=${exchange} raw=${typeof request === 'string' ? request : request.marketId ?? request.symbol ?? 'null'} canonical=${resolved.metadata.marketId}`,
  );

  if (target === 'candles' && resolved.identitySpecialCase) {
    logger.info(
      {
        domain: 'market-routes',
        exchange,
        target,
        marketId: resolved.metadata.marketId,
        canonicalMarketId: resolved.metadata.canonicalMarketId,
        canonicalSymbol: resolved.metadata.canonicalSymbol,
        reason: resolved.identitySpecialCase,
      },
      `[MarketIdentity] candle_identity_special_case exchange=${exchange} marketId=${resolved.metadata.marketId} reason=${resolved.identitySpecialCase}`,
    );
  }

  return {
    provider,
    market: resolved.market,
    metadata: resolved.metadata,
    responseMetadata: buildAvailability(resolved.metadata),
  };
}

function extractUpstreamStatus(error: unknown) {
  if (error instanceof Error) {
    const match = error.message.match(/\bHTTP\s+(\d{3})\b/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return undefined;
}

function isRateLimitError(error: unknown) {
  return error instanceof Error && /\b429\b|too[_\s-]?many[_\s-]?requests|rate limit/i.test(error.message);
}

function toSortedUniqueSymbols(symbols: Iterable<string>) {
  return Array.from(new Set(symbols)).sort((left, right) => left.localeCompare(right));
}

function estimatePreviousPrice24h(price: number, change24h: number) {
  const ratio = 1 + change24h / 100;
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }

  const previousPrice24h = price / ratio;
  return Number.isFinite(previousPrice24h) && previousPrice24h > 0 ? previousPrice24h : null;
}

function buildTickerSparkline(ticker: CanonicalTickerSnapshot, sourceTimestamp: number): {
  points: SparklinePoint[];
  source: TickerSparklineSource;
  previousPrice24h: number | null;
} {
  const projectedHistory = marketTrendProjectionStore.getPoints(ticker.exchange, ticker.symbol, SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT.full);
  const history = projectedHistory.length > 0
    ? projectedHistory
    : publicMarketDataStore.getTickerHistory?.(ticker.exchange, ticker.symbol) ?? [];
  const normalizedHistory = history.slice(-SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT.full);
  const last = normalizedHistory[normalizedHistory.length - 1];

  if (!last || last.timestamp !== sourceTimestamp || last.price !== ticker.price) {
    normalizedHistory.push({ price: ticker.price, timestamp: sourceTimestamp });
  }

  if (normalizedHistory.length >= 2) {
    return {
      points: normalizedHistory.slice(-SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT.full),
      source: 'history',
      previousPrice24h: estimatePreviousPrice24h(ticker.price, ticker.change24h),
    };
  }

  const previousPrice24h = estimatePreviousPrice24h(ticker.price, ticker.change24h);
  if (previousPrice24h !== null) {
    return {
      points: [
        { price: previousPrice24h, timestamp: sourceTimestamp - 24 * 60 * 60 * 1000 },
        { price: ticker.price, timestamp: sourceTimestamp },
      ],
      source: 'derived_change24h',
      previousPrice24h,
    };
  }

  return {
    points: [
      { price: ticker.price, timestamp: sourceTimestamp - 60_000 },
      { price: ticker.price, timestamp: sourceTimestamp },
    ],
    source: 'flat_current',
    previousPrice24h: null,
  };
}

function withFreshness<T>(
  item: T,
  sourceTimestamp: number | null,
  dataMode: 'streaming' | 'snapshot' | 'cached_snapshot',
): FreshMarketData<T> {
  return {
    ...item,
    ...createFreshnessMetadata({ dataMode, sourceTimestamp }),
  };
}

function withTickerCompletenessFromSource(
  ticker: CanonicalTickerSnapshot,
  dataMode: 'streaming' | 'snapshot' | 'cached_snapshot',
): MarketTickerRow {
  const freshness = withFreshness(ticker, ticker.timestamp, dataMode);
  const sparkline = buildTickerSparkline(ticker, freshness.sourceTimestamp ?? ticker.timestamp);

  return {
    ...freshness,
    current: freshness.price,
    percent: freshness.change24h,
    previousPrice24h: sparkline.previousPrice24h,
    sparkline: sparkline.points.map((point) => point.price),
    sparklinePoints: sparkline.points,
    sparklineSource: sparkline.source,
  };
}

function summarizeTickerFieldCoverage(items: MarketTickerRow[]) {
  return {
    total: items.length,
    price: items.filter((item) => Number.isFinite(item.price) && item.price > 0).length,
    change24h: items.filter((item) => Number.isFinite(item.change24h)).length,
    volume24h: items.filter((item) => Number.isFinite(item.volume24h)).length,
    timestamp: items.filter((item) => Number.isFinite(item.timestamp) && item.timestamp > 0).length,
    sparkline: items.filter((item) => item.sparkline.length >= 2).length,
    sparklineFallback: items.filter((item) => item.sparklineSource !== 'history').length,
  };
}

function summarizeTickerDataModes(items: MarketTickerRow[]) {
  return items.reduce<Record<'streaming' | 'snapshot' | 'cached_snapshot', number>>(
    (summary, item) => {
      summary[item.dataMode] += 1;
      return summary;
    },
    { streaming: 0, snapshot: 0, cached_snapshot: 0 },
  );
}

function summarizeDroppedReasons(droppedSymbols: Array<{ reason: string }>) {
  return droppedSymbols.reduce<Record<string, number>>((summary, item) => {
    summary[item.reason] = (summary[item.reason] ?? 0) + 1;
    return summary;
  }, {});
}

function summarizeAssetImageReasons(items: Array<{
  imageMissingReason?: string | null;
  reason?: string | null;
}>) {
  return items.reduce<Record<string, number>>((summary, item) => {
    const reason = item.imageMissingReason ?? item.reason;
    if (!reason) {
      return summary;
    }
    summary[reason] = (summary[reason] ?? 0) + 1;
    return summary;
  }, {});
}

function toImageCoverageRate(withImageCount: number, totalCount: number) {
  if (totalCount === 0) {
    return 0;
  }

  return Number(((withImageCount / totalCount) * 100).toFixed(2));
}

function hasSupportedAssetIdentity(symbol?: string | null) {
  if (!symbol) {
    return false;
  }
  const canonical = toCanonicalSymbol(symbol);
  return Boolean(
    canonical
    && (COIN_MAP.has(canonical) || isKnownAssetRegistryKey(canonical) || hasCuratedAssetMetadata(canonical)),
  );
}

function resolveAssetSupportStatus(params: {
  canonicalAssetKey?: string | null;
  registryMapped: boolean;
}): 'supported' | 'metadata_pending' | 'unsupported' {
  if (!params.canonicalAssetKey) {
    return 'unsupported';
  }
  return params.registryMapped ? 'supported' : 'metadata_pending';
}

const MARKET_CAPABILITY_CHANNELS: MarketCapabilityChannel[] = ['tickers', 'orderbook', 'trades', 'candles'];
const EXCHANGE_CAPABILITY_BY_CHANNEL = {
  tickers: 'market:ticker',
  orderbook: 'market:orderbook',
  trades: 'market:trades',
  candles: 'market:candles',
} as const;

type MarketCapabilityFlags = Record<MarketCapabilityChannel, boolean> & CanonicalMarketCapabilities;

type MarketUniverseItem = {
  exchange: ExchangeId;
  exchangeName: string;
  marketId: string;
  canonicalMarketId: string;
  rawSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: QuoteCurrency;
  displaySymbol: string;
  koreanName: string | null;
  englishName: string | null;
  iconUrl: string | null;
  isActive: boolean;
  symbol: string;
  candlesSupported: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
  canonicalAssetKey: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  assetImageUrl?: string | null;
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  preferredImageSymbol?: string | null;
  preferredImageSlug?: string | null;
  imageResolutionSource?: string | null;
  resolutionStage?: string | null;
  manualCurationRecommended?: boolean;
  fallbackOnly?: boolean;
  assetSupportStatus: 'supported' | 'metadata_pending' | 'unsupported';
  exchangeSymbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  tradable: boolean;
  capabilities: MarketCapabilityFlags;
  isChartAvailable: boolean;
  isOrderBookAvailable: boolean;
  isTradesAvailable: boolean;
  unavailableReason: string | null;
  kimchiComparable: boolean;
  kimchiComparisonReason: MarketSymbolSupportEntry['kimchiComparisonReason'];
  nameKo?: string;
  nameEn?: string;
  registryMapped: boolean;
};

type MarketTickerItem = MarketTickerRow & Omit<
  MarketUniverseItem,
  'exchange' | 'symbol' | 'market' | 'baseCurrency' | 'quoteCurrency' | 'rawSymbol'
> & {
  imageUrl: string | null;
  imageURL: string | null;
  hasImage: boolean;
  assetImageUrl: string | null;
  imageAvailability: AssetImageAvailability;
  imageFailureReason: string | null;
  imageMissingReason: string | null;
  fallbackType: string | null;
  assetType: string | null;
  canonicalName: string | null;
  fallbackColor: string | null;
  fallbackInitials: string | null;
  assetSlug: string | null;
  imageFallbackKey: string | null;
  fallbackKey: string | null;
  stableImageKey: string | null;
  imageLookupKey: string | null;
};

type AssetImageProjectionReason =
  | 'canonical_key_missing'
  | 'unsupported_asset'
  | 'alias_miss'
  | 'metadata_pending'
  | 'metadata_missing'
  | 'no_image_url'
  | 'image_url_empty'
  | 'upstream_fetch_failed'
  | 'missing_curated_mapping'
  | 'missing_preferred_slug'
  | 'missing_registry_image_metadata'
  | 'ambiguous_short_symbol'
  | 'unresolved_numeric_variant'
  | 'unresolved_branded_variant'
  | 'fiat_or_quote_like_symbol'
  | 'intentionally_fallback_only'
  | 'curated_slug_resolved_but_metadata_missing'
  | 'curated_slug_resolved_but_cache_stale'
  | 'curated_slug_resolved_but_projection_not_promoted'
  | 'curated_slug_resolved_but_source_merge_failed'
  | 'source_metadata_absent';

const FIRST_PAGE_VISIBLE_SYMBOL_LIMIT = 24;
const TOP_VOLUME_SYMBOL_PRELOAD_LIMIT = 50;

type DroppedSymbolEntry = {
  exchange: ExchangeId;
  symbol: string;
  reason: string;
};

type MarketUniverseMeta = {
  exchanges: ExchangeId[];
  requestedMarketCount: number;
  providerMarketCount: number;
  normalizedSymbolCount: number;
  returnedCount: number;
  registryMappedCount: number;
  registryUnmappedCount: number;
  droppedSymbols: DroppedSymbolEntry[];
  droppedReasonsSummary: Record<string, number>;
  sourceOfTruth: 'provider_market_universe';
  appliedLimit: number | null;
  totalAvailableCount: number;
};

type MarketUniverseResponse<T> = {
  items: T[];
  meta: MarketUniverseMeta & {
    fieldCoverage?: ReturnType<typeof summarizeTickerFieldCoverage>;
    dataModes?: ReturnType<typeof summarizeTickerDataModes>;
  };
};

type AssetCoverageAuditReason =
  | 'alias_missing'
  | 'canonical_missing'
  | 'asset_slug_missing'
  | 'image_url_missing'
  | 'unsupported_asset';

type ExchangeAssetCoverageAuditItem = {
  exchange: ExchangeId;
  marketId: string;
  rawSymbol: string;
  normalizedSymbol: string;
  canonicalSymbol: string;
  canonicalAssetKey: string | null;
  assetSlug: string | null;
  preferredImageSymbol: string | null;
  preferredImageSlug: string | null;
  imageUrl: string | null;
  fallbackKey: string;
  stableAssetKey: string;
  imageAvailability: AssetImageAvailability;
  imageFailureReason: string | null;
  imageMissingReason: string | null;
  imageResolutionSource: string | null;
  resolutionStage: string | null;
  assetSupportStatus: 'supported' | 'metadata_pending' | 'unsupported';
  registryMapped: boolean;
  aliasHit: boolean;
  matchedBy: ReturnType<typeof resolveCanonicalAssetImageKey>['matchedBy'];
  diagnosticReasons: AssetCoverageAuditReason[];
  exposurePriority: number;
  exposureRank: number | null;
  representative: boolean;
  visible: boolean;
  volumeRank: number | null;
  manualCurationRecommended: boolean;
  fallbackOnly: boolean;
};

type ExchangeAssetCoverageAuditSummary = {
  exchange: ExchangeId;
  totalAssets: number;
  registryMappedCount: number;
  canonicalMappedCount: number;
  imageUrlAvailableCount: number;
  fallbackKeyAvailableCount: number;
  unsupportedCount: number;
  aliasMissingCount: number;
  canonicalMissingCount: number;
  assetSlugMissingCount: number;
  imageUrlMissingCount: number;
};

type ExchangeAssetCoverageAuditEntry = {
  generatedAt: number;
  items: ExchangeAssetCoverageAuditItem[];
  summary: ExchangeAssetCoverageAuditSummary;
};

type ExchangeAssetCoverageAuditDetail = {
  exchange: ExchangeId;
  summary: ExchangeAssetCoverageAuditSummary;
  imageUrlMissingSymbols: ExchangeAssetCoverageAuditItem[];
  aliasMissingSymbols: ExchangeAssetCoverageAuditItem[];
  priorityRankedMissingImageCandidates: ExchangeAssetCoverageAuditItem[];
  manualCurationRecommended: ExchangeAssetCoverageAuditItem[];
  fallbackOnlyRetained: ExchangeAssetCoverageAuditItem[];
  curatedResolvedButNotPromoted: ExchangeAssetCoverageAuditItem[];
  cacheStaleSuspects: ExchangeAssetCoverageAuditItem[];
  sourceMetadataMissing: ExchangeAssetCoverageAuditItem[];
};

export type AssetCoverageAuditResponse = {
  generatedAt: number | null;
  cacheAgeMs: number | null;
  cached: boolean;
  exchanges: ExchangeId[];
  summary: ExchangeAssetCoverageAuditSummary[];
  totals: Omit<ExchangeAssetCoverageAuditSummary, 'exchange'>;
  items: ExchangeAssetCoverageAuditItem[];
  details: ExchangeAssetCoverageAuditDetail[];
};

export type MarketSnapshotScope = 'top' | 'visible' | 'full' | 'symbols';
export type MarketSnapshotMarketStatus = 'live' | 'stale' | 'pending';
export type MarketSnapshotTrend = 'up' | 'down' | 'flat' | 'unknown';

export type MarketSnapshotItem = {
  exchange: ExchangeId;
  exchangeName: string;
  marketId: string;
  rawSymbol: string | null;
  canonicalSymbol: string;
  baseAsset: string | null;
  quoteAsset: QuoteCurrency | null;
  symbol: string;
  displaySymbol: string;
  displayName: string;
  canonicalAssetKey: string | null;
  iconUrl: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  assetImageUrl: string | null;
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  assetSupportStatus?: 'supported' | 'metadata_pending' | 'unsupported';
  exchangeSymbol: string | null;
  market: string | null;
  baseCurrency: string | null;
  quoteCurrency: QuoteCurrency | null;
  price: number | null;
  change24h: number | null;
  signedChangeRate: number | null;
  volume24h: number | null;
  sparkline: number[];
  sparklinePoints: SparklinePoint[];
  sparklineSource: TickerSparklineSource | 'unavailable';
  trend: MarketSnapshotTrend;
  timestamp: number | null;
  asOf: number | null;
  source: Exclude<SnapshotSource, 'mixed'>;
  freshnessMs: number | null;
  stale: boolean;
  status: SnapshotItemStatus;
  marketStatus: MarketSnapshotMarketStatus;
  errorCode: SnapshotErrorCode | null;
  errorMessage: string | null;
  registryMapped: boolean;
  tradable: boolean;
  isActive: boolean;
  capabilities: MarketCapabilityFlags;
  isChartAvailable: boolean;
  isOrderBookAvailable: boolean;
  isTradesAvailable: boolean;
  unavailableReason: string | null;
  kimchiComparable: boolean;
  kimchiComparisonReason: MarketSymbolSupportEntry['kimchiComparisonReason'];
};

export type MarketSnapshotResponse = {
  exchange: ExchangeId;
  scope: MarketSnapshotScope;
  requestedSymbols: string[];
  items: MarketSnapshotItem[];
  partialFailures: SnapshotPartialFailure[];
  status: SnapshotOverallStatus;
  source: SnapshotSource;
  freshnessMs: number | null;
  asOf: number | null;
  stale: boolean;
  total: number;
  listedCount: number;
  staleItemCount: number;
  pendingItemCount: number;
  excludedUnlistedCount: number;
};

export type MarketDisplayStatus = 'fresh' | 'delayed' | 'partial' | 'unavailable';

export type MarketViewportRow = {
  selectedExchange: ExchangeId;
  sourceExchange: ExchangeId | null;
  marketId: string | null;
  rawSymbol: string | null;
  canonicalSymbol: string;
  baseAsset: string | null;
  quoteAsset: QuoteCurrency | null;
  symbol: string;
  displaySymbol: string;
  displayName: string;
  canonicalAssetKey: string | null;
  iconUrl: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  assetImageUrl: string | null;
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  assetSupportStatus?: 'supported' | 'metadata_pending' | 'unsupported';
  exchangeSymbol: string | null;
  market: string | null;
  baseCurrency: string | null;
  quoteCurrency: QuoteCurrency | null;
  currentPrice: number | null;
  change24h: number | null;
  signedChangeRate: number | null;
  volume24h: number | null;
  representative: boolean;
  updatedAt: number | null;
  displayStatus: MarketDisplayStatus;
  partial: boolean;
  isActive: boolean;
  capabilities?: MarketCapabilityFlags;
  isChartAvailable: boolean;
  isOrderBookAvailable: boolean;
  isTradesAvailable: boolean;
  unavailableReason: string | null;
  sparkline?: number[] | null;
  sparklinePointCount?: number | null;
  debugReasons?: string[];
};

type MarketViewportDebugSymbol = {
  symbol: string;
  reason: string;
};

type MarketViewportDebugMeta = {
  requestKind: 'overview' | 'list' | 'sparkline';
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbolCount: number;
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  websocketMergeLagMs: number | null;
  staleReused: boolean;
  skippedSymbols: MarketViewportDebugSymbol[];
};

type CursorPage = {
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
  total: number;
};

export type MarketOverviewResponse = {
  selectedExchange: ExchangeId;
  sourceExchange: ExchangeId;
  updatedAt: number | null;
  displayStatus: MarketDisplayStatus;
  partial: boolean;
  skippedSymbolCount: number;
  items: MarketViewportRow[];
  page: CursorPage;
  debug?: MarketViewportDebugMeta;
};

export type MarketListResponse = MarketOverviewResponse;

export type MarketSparklineResponse = {
  selectedExchange: ExchangeId;
  sourceExchange: ExchangeId;
  updatedAt: number | null;
  displayStatus: MarketDisplayStatus;
  partial: boolean;
  source?: MarketSparklineResponseSource;
  freshness?: StableResponseFreshnessBucket;
  generatedAt?: number;
  missingSymbols?: string[];
  usableSymbols?: string[];
  usableStaleSymbols?: string[];
  symbolMeta?: MarketSparklineSymbolMeta[];
  skippedSymbolCount: number;
  requestedSymbols?: string[];
  acceptedSymbols?: string[];
  rejectedSymbols?: MarketSymbolRequestFailure[];
  unsupportedSymbols?: MarketSymbolRequestFailure[];
  unavailableSymbols?: MarketSymbolRequestFailure[];
  cache?: {
    hit: number;
    miss: number;
    stale: number;
    backgroundRefreshScheduled?: boolean;
  };
  batch?: {
    index: number;
    requestedCount: number;
    success: number;
    failed: number;
  };
  items: Array<Pick<
    MarketViewportRow,
    | 'selectedExchange'
    | 'sourceExchange'
    | 'marketId'
    | 'rawSymbol'
    | 'canonicalSymbol'
    | 'baseAsset'
    | 'quoteAsset'
    | 'symbol'
    | 'displaySymbol'
    | 'displayName'
    | 'canonicalAssetKey'
    | 'iconUrl'
    | 'assetImageUrl'
    | 'imageUrl'
    | 'imageURL'
    | 'hasImage'
    | 'imageAvailability'
    | 'imageFailureReason'
    | 'imageMissingReason'
    | 'fallbackType'
    | 'assetType'
    | 'canonicalName'
    | 'fallbackColor'
    | 'fallbackInitials'
    | 'assetSlug'
    | 'imageFallbackKey'
    | 'fallbackKey'
    | 'stableImageKey'
    | 'imageLookupKey'
    | 'assetSupportStatus'
    | 'representative'
    | 'updatedAt'
    | 'displayStatus'
    | 'partial'
    | 'sparkline'
    | 'sparklinePointCount'
    | 'debugReasons'
  >>;
  debug?: MarketViewportDebugMeta;
};

type MarketSymbolRequestFailure = {
  input?: string;
  symbol?: string;
  reason: string;
  retryable: boolean;
};

export type MarketBaseSnapshotItem = {
  selectedExchange: ExchangeId;
  sourceExchange: ExchangeId | null;
  marketId: string | null;
  rawSymbol: string | null;
  canonicalSymbol: string;
  baseAsset: string | null;
  quoteAsset: QuoteCurrency | null;
  symbol: string;
  displaySymbol: string;
  displayName: string;
  canonicalAssetKey: string | null;
  iconUrl: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  assetImageUrl: string | null;
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  assetSupportStatus?: 'supported' | 'metadata_pending' | 'unsupported';
  exchangeSymbol: string | null;
  market: string | null;
  baseCurrency: string | null;
  quoteCurrency: QuoteCurrency | null;
  currentPrice: number | null;
  change24h: number | null;
  signedChangeRate: number | null;
  volume24h: number | null;
  updatedAt: number | null;
  asOf: number | null;
  freshnessMs: number | null;
  stale: boolean;
  status: SnapshotItemStatus;
  marketStatus: MarketSnapshotMarketStatus;
  source: Exclude<SnapshotSource, 'mixed'>;
  representative: boolean;
  tradable: boolean;
  isActive: boolean;
  capabilities: MarketCapabilityFlags;
  isChartAvailable: boolean;
  isOrderBookAvailable: boolean;
  isTradesAvailable: boolean;
  unavailableReason: string | null;
  kimchiComparable: boolean;
  errorCode: SnapshotErrorCode | null;
  errorMessage: string | null;
};

export type MarketBaseSnapshotResponse = {
  selectedExchange: ExchangeId;
  sourceExchange: ExchangeId;
  scope: MarketSnapshotScope;
  requestedSymbols: string[];
  acceptedSymbols: string[];
  rejectedSymbols: MarketSymbolRequestFailure[];
  unsupportedSymbols: MarketSymbolRequestFailure[];
  items: MarketBaseSnapshotItem[];
  status: SnapshotOverallStatus;
  partial: boolean;
  cacheHit: boolean;
  freshnessMs: number | null;
  asOf: number | null;
  stale: boolean;
  total: number;
  listedCount: number;
  elapsedMs: number;
};

export type ComparableKimchiSymbolItem = {
  marketId: string | null;
  rawSymbol: string | null;
  canonicalSymbol: string;
  baseAsset: string | null;
  quoteAsset: QuoteCurrency | null;
  symbol: string;
  displaySymbol: string;
  displayName: string;
  canonicalAssetKey: string | null;
  iconUrl: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  assetImageUrl: string | null;
  imageAvailability?: AssetImageAvailability;
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  assetSupportStatus?: 'supported' | 'metadata_pending' | 'unsupported';
  market: string | null;
  exchangeSymbol: string | null;
  price: number | null;
  marketStatus: MarketSnapshotMarketStatus;
  priority: 'top' | 'normal';
  rank: number;
};

type ProviderMarketUniverseBundle = {
  provider: ExchangeMarketDataProvider;
  items: MarketUniverseItem[];
  marketSymbols: string[];
  marketSymbolSet: Set<string>;
  capabilitySnapshot: MarketCapabilitySnapshot;
  registryMappedCount: number;
  registryUnmappedCount: number;
};

type ExchangeMarketSnapshotCacheEntry = {
  exchange: ExchangeId;
  bundle: ProviderMarketUniverseBundle;
  fullItems: MarketSnapshotItem[];
  comparableKimchiItems: ComparableKimchiSymbolItem[];
  comparableKimchiSymbolSet: Set<string>;
  itemIndexBySymbol: Map<string, number>;
  marketBySymbol: Map<string, MarketUniverseItem>;
  partialFailures: SnapshotPartialFailure[];
  missingReasons: Map<string, string>;
  source: SnapshotSource;
  status: SnapshotOverallStatus;
  freshnessMs: number | null;
  asOf: number | null;
  stale: boolean;
  listedCount: number;
  staleItemCount: number;
  pendingItemCount: number;
  lastRefreshedAt: number;
  lastUniverseLoadedAt: number;
};

const MARKET_SNAPSHOT_REFRESH_INTERVAL_MS = 5_000;
const MARKET_SNAPSHOT_UNIVERSE_REFRESH_INTERVAL_MS = 60_000;
const MARKET_SNAPSHOT_HARD_STALE_AFTER_MS = 15_000;
const MARKET_SPARKLINE_CACHE_TTL_MS = 1_500;
const MARKET_SPARKLINE_STALE_TTL_MS = 10_000;
const MARKET_SPARKLINE_USABLE_STALE_TTL_MS = 30_000;
const VIEWPORT_FRESH_THRESHOLD_MS = 5_000;
const VIEWPORT_SLIGHTLY_DELAYED_THRESHOLD_MS = 20_000;
const ASSET_COVERAGE_AUDIT_TTL_MS = 5 * 60 * 1000;
const exchangeMarketSnapshotCache = new Map<ExchangeId, ExchangeMarketSnapshotCacheEntry>();
const exchangeMarketSnapshotRefreshInFlight = new Map<ExchangeId, Promise<ExchangeMarketSnapshotCacheEntry | null>>();
const exchangeMarketSnapshotIntervals = new Map<ExchangeId, NodeJS.Timeout>();
const exchangeAssetCoverageAuditCache = new Map<ExchangeId, ExchangeAssetCoverageAuditEntry>();
const exchangeAssetCoverageAuditInFlight = new Map<ExchangeId, Promise<ExchangeAssetCoverageAuditEntry>>();
type CachedMarketSparklineRow = {
  row: MarketViewportRow;
  generatedAt: number;
  expiresAt: number;
  staleUntil: number;
  usableUntil: number;
};
const marketSparklineCache = new Map<string, CachedMarketSparklineRow>();
const marketSparklineRefreshInFlight = new Map<string, Promise<void>>();
let marketSnapshotCacheStarted = false;
let marketSnapshotTickerListener: ((payload: NormalizedMarketTicker) => void) | null = null;
let marketSnapshotTradeListener: ((payload: NormalizedMarketTrade) => void) | null = null;

function defaultCapabilitySnapshot(
  provider: ExchangeMarketDataProvider,
  marketSymbols: string[],
): MarketCapabilitySnapshot {
  const providerSupports = typeof provider.supports === 'function'
    ? provider.supports.bind(provider)
    : () => true;
  const capabilitySymbols = MARKET_CAPABILITY_CHANNELS.reduce<MarketCapabilitySnapshot['capabilitySymbols']>(
    (summary, channel) => {
      summary[channel] = providerSupports(EXCHANGE_CAPABILITY_BY_CHANNEL[channel]) ? [...marketSymbols] : [];
      return summary;
    },
    {},
  );

  return {
    websocketTickerSymbols: [...marketSymbols],
    capabilitySymbols,
  };
}

async function resolveCapabilitySnapshot(
  provider: ExchangeMarketDataProvider,
  markets: ExchangeMarketDescriptor[],
): Promise<MarketCapabilitySnapshot> {
  if (typeof provider.getMarketCapabilitySnapshot === 'function') {
    return provider.getMarketCapabilitySnapshot(markets);
  }

  return defaultCapabilitySnapshot(provider, toSortedUniqueSymbols(markets.map((market) => market.symbol)));
}

function buildCapabilityFlags(
  exchange: ExchangeId,
  snapshot: MarketCapabilitySnapshot,
  market: ExchangeMarketDescriptor,
): MarketCapabilityFlags {
  return buildResolvedMarketCapabilityFlags({
    exchange,
    market,
    capabilitySnapshot: snapshot,
  });
}

function resolveKimchiMetadata(params: {
  exchange: ExchangeId;
  quoteCurrency: QuoteCurrency;
  symbol: string;
  binanceSymbolSet: Set<string>;
}) {
  if (params.exchange === 'binance') {
    return {
      kimchiComparable: false,
      kimchiComparisonReason: 'DOMESTIC_ONLY' as const,
    };
  }

  if (params.quoteCurrency !== 'KRW') {
    return {
      kimchiComparable: false,
      kimchiComparisonReason: 'QUOTE_NOT_SUPPORTED' as const,
    };
  }

  if (!params.binanceSymbolSet.has(params.symbol)) {
    return {
      kimchiComparable: false,
      kimchiComparisonReason: 'BINANCE_REFERENCE_MISSING' as const,
    };
  }

  return {
    kimchiComparable: true,
    kimchiComparisonReason: 'COMPARABLE' as const,
  };
}

async function loadBinanceSymbolSet() {
  const binanceProvider = exchangeProviderRegistry.getMarketDataProvider('binance');
  const binanceMarkets = await binanceProvider.listMarkets();
  return new Set(binanceMarkets.map((market) => market.symbol));
}

async function buildProviderMarketUniverse(
  provider: ExchangeMarketDataProvider,
  binanceSymbolSet: Set<string>,
): Promise<ProviderMarketUniverseBundle> {
  const listedMarkets = (await provider.listMarkets())
    .filter((market) => market.tradable !== false)
    .sort((left, right) => left.symbol.localeCompare(right.symbol));
  const capabilitySnapshot = await resolveCapabilitySnapshot(provider, listedMarkets);
  const marketSymbols = toSortedUniqueSymbols(listedMarkets.map((market) => market.symbol));
  const marketSymbolSet = new Set(marketSymbols);

  const items = listedMarkets.map<MarketUniverseItem>((market) => {
    const quoteCurrency = market.quoteCurrency ?? provider.metadata.quoteCurrency;
    const exchangeSymbol = market.exchangeSymbol ?? market.rawSymbol;
    const capabilities = buildCapabilityFlags(provider.exchange, capabilitySnapshot, {
      ...market,
      exchangeSymbol,
      quoteCurrency,
    });
    const metadata = buildCanonicalMarketMetadataFromDescriptor({
      exchange: provider.exchange,
      market: {
        ...market,
        exchangeSymbol,
        quoteCurrency,
      },
      capabilities,
    });
    const assetResolution = resolveCanonicalAssetImageKey({
      exchange: provider.exchange,
      symbol: market.symbol,
      exchangeSymbol,
      rawSymbol: market.rawSymbol ?? exchangeSymbol,
    });
    const canonicalAssetKey = assetResolution.canonicalAssetKey;
    const coin = COIN_MAP.get(canonicalAssetKey ?? market.symbol) ?? COIN_MAP.get(market.symbol);
    const registryMapped = canonicalAssetKey
      ? hasSupportedAssetIdentity(canonicalAssetKey)
      : hasSupportedAssetIdentity(market.symbol);
    const englishName = coin?.nameEn ?? market.englishName ?? metadata.englishName;
    const koreanName = coin?.nameKo ?? market.koreanName ?? metadata.koreanName;
    const assetSupportStatus = resolveAssetSupportStatus({ canonicalAssetKey, registryMapped });
    return {
      exchange: provider.exchange,
      exchangeName: provider.metadata.displayName,
      marketId: metadata.marketId,
      canonicalMarketId: metadata.canonicalMarketId,
      rawSymbol: metadata.rawSymbol,
      canonicalSymbol: metadata.canonicalSymbol,
      baseAsset: metadata.baseAsset,
      quoteAsset: metadata.quoteAsset,
      displaySymbol: metadata.displaySymbol,
      koreanName,
      englishName,
      iconUrl: canonicalAssetKey ? resolveIconUrl(canonicalAssetKey) ?? metadata.iconUrl : metadata.iconUrl,
      isActive: metadata.isActive,
      symbol: market.symbol,
      candlesSupported: metadata.candlesSupported,
      graphSupported: metadata.graphSupported,
      supportedIntervals: [...metadata.supportedIntervals],
      unsupportedReason: metadata.unsupportedReason,
      canonicalAssetKey,
      assetSupportStatus,
      exchangeSymbol,
      market: market.market,
      baseCurrency: market.baseCurrency ?? market.symbol,
      quoteCurrency,
      tradable: market.tradable ?? true,
      capabilities,
      isChartAvailable: metadata.graphSupported,
      isOrderBookAvailable: capabilities.supportsOrderBook,
      isTradesAvailable: capabilities.supportsTrades,
      unavailableReason: metadata.unsupportedReason,
      ...resolveKimchiMetadata({
        exchange: provider.exchange,
        quoteCurrency,
        symbol: market.symbol,
        binanceSymbolSet,
      }),
      nameKo: koreanName ?? undefined,
      nameEn: englishName ?? undefined,
      registryMapped,
    };
  });

  const registryMappedCount = items.filter((item) => item.registryMapped).length;
  return {
    provider,
    items,
    marketSymbols,
    marketSymbolSet,
    capabilitySnapshot,
    registryMappedCount,
    registryUnmappedCount: Math.max(items.length - registryMappedCount, 0),
  };
}

function mapTickerLoadSourceToSnapshotSource(
  source: 'public_store_cache' | 'public_store_stale' | 'public_store_expired' | 'provider_snapshot',
): Exclude<SnapshotSource, 'mixed'> {
  switch (source) {
    case 'provider_snapshot':
      return 'snapshot';
    case 'public_store_cache':
      return 'cache';
    case 'public_store_stale':
    case 'public_store_expired':
    default:
      return 'fallback';
  }
}

function toMarketSnapshotFailure(params: {
  symbol: string;
  exchange: ExchangeId;
  code: SnapshotErrorCode;
  message: string;
  source?: SnapshotSource;
  stage?: string;
  retryable?: boolean;
}): SnapshotPartialFailure {
  return {
    symbol: params.symbol,
    exchange: params.exchange,
    code: params.code,
    message: params.message,
    source: params.source,
    stage: params.stage,
    retryable: params.retryable,
  };
}

function classifyMarketSnapshotFailure(params: {
  exchange: ExchangeId;
  symbol: string;
  loadReason?: string | null;
  hasError: boolean;
  marketExists: boolean;
  registryMapped: boolean;
}) {
  if (!params.marketExists) {
    return {
      code: params.registryMapped ? 'UNSUPPORTED_SYMBOL' as const : 'SYMBOL_MAPPING_NOT_FOUND' as const,
      message: params.registryMapped
        ? `${params.symbol} is not listed on ${params.exchange}`
        : `canonical mapping for ${params.symbol} could not be resolved on ${params.exchange}`,
      source: 'snapshot' as const,
      stage: params.registryMapped ? 'exchange_market' : 'symbol_mapping',
      retryable: false,
    };
  }

  if (params.hasError || params.loadReason?.includes('provider_error')) {
    return {
      code: 'EXCHANGE_TEMPORARILY_UNAVAILABLE' as const,
      message: params.loadReason ?? `${params.exchange} ticker snapshot is temporarily unavailable`,
      source: 'snapshot' as const,
      stage: 'ticker_snapshot',
      retryable: true,
    };
  }

  if (params.loadReason?.includes('missing_from_provider_snapshot')) {
    return {
      code: 'PARTIAL_DATA' as const,
      message: params.loadReason,
      source: 'snapshot' as const,
      stage: 'ticker_snapshot',
      retryable: true,
    };
  }

  return {
    code: 'PARTIAL_DATA' as const,
    message: params.loadReason ?? `ticker snapshot for ${params.symbol} is incomplete`,
    source: 'snapshot' as const,
    stage: 'ticker_snapshot',
    retryable: true,
  };
}

function summarizeSnapshotStatus(items: MarketSnapshotItem[]) {
  const renderable = items.filter((item) => item.price !== null || item.status === 'stale');
  if (renderable.length === 0) {
    return 'failure' as SnapshotOverallStatus;
  }

  return items.some((item) => item.status !== 'success') ? 'partial_success' : 'success';
}

function summarizeSnapshotSource(items: MarketSnapshotItem[]): SnapshotSource {
  const sources = Array.from(new Set(items.filter((item) => item.status !== 'error').map((item) => item.source)));
  if (sources.length === 0) {
    return 'snapshot';
  }
  if (sources.length === 1) {
    return sources[0];
  }
  return 'mixed';
}

function applyUniverseLimit<T>(items: T[], limit?: number) {
  if (limit === undefined) {
    return {
      items,
      appliedLimit: null,
    };
  }

  return {
    items: items.slice(0, Math.max(limit, 0)),
    appliedLimit: limit,
  };
}

function createBaseMeta(params: Omit<MarketUniverseMeta, 'droppedReasonsSummary'>): MarketUniverseMeta {
  return {
    ...params,
    droppedReasonsSummary: summarizeDroppedReasons(params.droppedSymbols),
  };
}

function parseCursorOffset(cursor?: string | null) {
  if (!cursor) {
    return 0;
  }

  const offset = Number.parseInt(cursor, 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new AppError(400, 'cursor must be a non-negative integer');
  }

  return offset;
}

function buildCursorPage(offset: number, limit: number, total: number): CursorPage {
  const nextOffset = offset + limit;
  return {
    cursor: offset > 0 ? String(offset) : null,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    limit,
    total,
  };
}

function summarizeViewportDisplayStatus(rows: Array<{ displayStatus: MarketDisplayStatus }>, skippedSymbolCount: number) {
  if (rows.length === 0) {
    return skippedSymbolCount > 0 ? 'partial' as const : 'unavailable' as const;
  }

  if (skippedSymbolCount > 0 || rows.some((row) => row.displayStatus === 'partial' || row.displayStatus === 'unavailable')) {
    return 'partial' as const;
  }

  if (rows.some((row) => row.displayStatus === 'delayed')) {
    return 'delayed' as const;
  }

  return 'fresh' as const;
}

function normalizeSymbolBatch(symbols: string[]) {
  return Array.from(new Set(symbols.map((symbol) => toCanonicalSymbol(symbol)).filter(Boolean)));
}

function normalizeSymbolRequest(symbols: string[] = []) {
  const accepted = new Map<string, string>();
  const rejectedSymbols: MarketSymbolRequestFailure[] = [];

  for (const input of symbols) {
    const trimmed = input.trim();
    if (!trimmed) {
      continue;
    }

    const lower = trimmed.toLowerCase();
    if (['all', '*', 'null', 'undefined', 'nil', 'none'].includes(lower)) {
      rejectedSymbols.push({
        input: trimmed,
        reason: 'explicit_symbols_required',
        retryable: false,
      });
      continue;
    }

    const symbol = toCanonicalSymbol(trimmed);
    if (!symbol || !/^[A-Z0-9]+$/.test(symbol)) {
      rejectedSymbols.push({
        input: trimmed,
        symbol: symbol || undefined,
        reason: 'not_canonical',
        retryable: false,
      });
      continue;
    }

    accepted.set(symbol, trimmed);
  }

  return {
    requestedCount: symbols.filter((symbol) => symbol.trim().length > 0).length,
    symbols: Array.from(accepted.keys()),
    rejectedSymbols,
  };
}

function logPipelineDebug(stage: string, elapsedMs: number, extra?: Record<string, unknown>) {
  logger.info(
    {
      domain: 'pipeline-debug',
      stage,
      elapsedMs,
      ...extra,
    },
    `[PipelineDebug] stage=${stage} elapsedMs=${elapsedMs}`,
  );
}

function marketSparklineCacheKey(exchange: ExchangeId, symbol: string) {
  return `${exchange}:${symbol}:visible`;
}

function marketSparklineRefreshKey(exchange: ExchangeId, symbols: string[]) {
  return `${exchange}:${toSortedUniqueSymbols(symbols).join(',')}`;
}

function hasRenderableSparkline(row: Pick<MarketViewportRow, 'sparkline'> | null | undefined) {
  return Boolean(row?.sparkline && row.sparkline.length >= 2);
}

function cacheMarketSparklineRow(key: string, row: MarketViewportRow, generatedAt = Date.now()) {
  marketSparklineCache.set(key, {
    row,
    generatedAt,
    expiresAt: generatedAt + MARKET_SPARKLINE_CACHE_TTL_MS,
    staleUntil: generatedAt + MARKET_SPARKLINE_STALE_TTL_MS,
    usableUntil: generatedAt + MARKET_SPARKLINE_USABLE_STALE_TTL_MS,
  });
}

function classifyGraphFallbackReason(reason?: string | null): MarketSparklineFallbackReason {
  if (!reason) {
    return 'no_cache';
  }

  const normalized = reason.toLowerCase();
  if (normalized.includes('timed out')) {
    return 'provider_slow';
  }
  if (normalized.includes('using_cached_projection') || normalized.includes('using_expired_cache') || normalized.includes('stale_cache')) {
    return 'stale_cache';
  }
  if (normalized.includes('missing_from_provider_snapshot') || normalized.includes('missing_from_exchange_ticker_response')) {
    return 'provider_empty';
  }
  if (normalized.includes('no_graph_data') || normalized.includes('sparkline') || normalized.includes('point')) {
    return 'insufficient_points';
  }
  return 'provider_error';
}

function resolveSparklinePointCount(row: Pick<MarketViewportRow, 'sparkline' | 'sparklinePointCount'> | null | undefined) {
  return row?.sparklinePointCount ?? row?.sparkline?.length ?? 0;
}

function resolveLastSuccessfulGraphAt(row: Pick<MarketViewportRow, 'updatedAt' | 'sparkline'> | null | undefined, generatedAt: number) {
  if (!hasRenderableSparkline(row)) {
    return null;
  }

  const timestamp = row?.updatedAt ?? generatedAt;
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function resolveSparklineRenderPriority(params: {
  source: MarketSparklineSymbolSource;
  row: Pick<MarketViewportRow, 'sparkline' | 'sparklinePointCount'> | null | undefined;
}) : MarketSparklineRenderPriority {
  if (!hasRenderableSparkline(params.row)) {
    return 'unavailable';
  }

  if (params.source === 'provider_fetch') {
    return 'live';
  }

  return params.source === 'stale_cache' ? 'stale' : 'cached';
}

function resolveSparklineLatencyBucket(params: {
  renderPriority: MarketSparklineRenderPriority;
  updatedAt: number | null;
}) : MarketSparklineLatencyBucket {
  if (params.renderPriority === 'unavailable') {
    return 'unavailable';
  }

  if (params.renderPriority === 'stale') {
    return 'delayed';
  }

  const ageMs = params.updatedAt ? Math.max(Date.now() - params.updatedAt, 0) : 0;
  if (ageMs <= VIEWPORT_FRESH_THRESHOLD_MS) {
    return params.renderPriority === 'live' ? 'instant' : 'fast';
  }
  if (ageMs <= VIEWPORT_SLIGHTLY_DELAYED_THRESHOLD_MS) {
    return 'fast';
  }
  return 'delayed';
}

function summarizeSparklineSymbolFreshness(params: {
  row: Pick<MarketViewportRow, 'updatedAt' | 'sparkline'> | null | undefined;
  source: MarketSparklineSymbolSource;
  usable: boolean;
}): StableResponseFreshnessBucket {
  if (!params.usable || !hasRenderableSparkline(params.row)) {
    return 'unavailable';
  }

  const updatedAt = params.row?.updatedAt ?? null;
  if (updatedAt === null) {
    return params.source === 'stale_cache' ? 'stale' : 'slightly_delayed';
  }

  const ageMs = Math.max(Date.now() - updatedAt, 0);
  if (ageMs > MARKET_SPARKLINE_USABLE_STALE_TTL_MS) {
    return 'stale';
  }
  if (ageMs > VIEWPORT_SLIGHTLY_DELAYED_THRESHOLD_MS) {
    return params.source === 'stale_cache' ? 'stale' : 'delayed';
  }
  if (ageMs > VIEWPORT_FRESH_THRESHOLD_MS) {
    return params.source === 'stale_cache' ? 'delayed' : 'slightly_delayed';
  }

  return params.source === 'stale_cache' ? 'slightly_delayed' : 'fresh';
}

function summarizeSparklineResponseSource(params: {
  freshSourceCount: number;
  staleSourceCount: number;
  providerFetchCount: number;
}): MarketSparklineResponseSource {
  const sources = new Set<MarketSparklineResponseSource>();
  if (params.freshSourceCount > 0) {
    sources.add('fresh_cache');
  }
  if (params.staleSourceCount > 0) {
    sources.add('stale_cache');
  }
  if (params.providerFetchCount > 0) {
    sources.add('provider_fetch');
  }

  if (sources.size === 0) {
    return 'mixed';
  }
  if (sources.size === 1) {
    return Array.from(sources)[0];
  }
  return 'mixed';
}

function summarizeSparklineFreshness(params: {
  rows: MarketViewportRow[];
  staleSourceCount: number;
  missingSymbolCount: number;
}): StableResponseFreshnessBucket {
  const renderableRows = params.rows.filter((row) => hasRenderableSparkline(row));
  if (renderableRows.length === 0) {
    return 'unavailable';
  }

  const lagValues = renderableRows
    .map((row) => row.updatedAt)
    .filter((value): value is number => value !== null)
    .map((updatedAt) => Math.max(Date.now() - updatedAt, 0));
  const maxLagMs = lagValues.length > 0 ? Math.max(...lagValues) : 0;

  if (params.staleSourceCount > 0 && maxLagMs > VIEWPORT_SLIGHTLY_DELAYED_THRESHOLD_MS) {
    return 'stale';
  }
  if (params.staleSourceCount > 0 || params.missingSymbolCount > 0) {
    return maxLagMs > VIEWPORT_FRESH_THRESHOLD_MS ? 'delayed' : 'slightly_delayed';
  }
  if (maxLagMs > VIEWPORT_SLIGHTLY_DELAYED_THRESHOLD_MS) {
    return 'delayed';
  }
  if (maxLagMs > VIEWPORT_FRESH_THRESHOLD_MS) {
    return 'slightly_delayed';
  }
  return 'fresh';
}

async function refreshMarketSparklineRows(params: {
  exchange: ExchangeId;
  entry: ExchangeMarketSnapshotCacheEntry;
  symbols: string[];
  representativeSymbols: Set<string>;
  debug: boolean;
}) {
  const normalizedSymbols = toSortedUniqueSymbols(params.symbols);
  if (normalizedSymbols.length === 0) {
    return;
  }

  const refreshKey = marketSparklineRefreshKey(params.exchange, normalizedSymbols);
  const existing = marketSparklineRefreshInFlight.get(refreshKey);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async () => {
    const providerStartedAt = Date.now();
    const loads = await getExchangeTickerLoads(params.exchange, normalizedSymbols, {
      freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotDefault,
      prioritySymbols: getRepresentativeSymbolsForExchange(normalizedSymbols, params.exchange),
      priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
      providerTimeoutMs: normalizedSymbols.length <= 20 ? 700 : 1_200,
    });

    for (const symbol of normalizedSymbols) {
      const market = params.entry.marketBySymbol.get(symbol);
      const load = loads.get(symbol);
      if (!market || !load?.ticker) {
        continue;
      }

      const row = buildMarketViewportRow({
        exchange: params.exchange,
        market,
        tickerRow: withTickerCompletenessFromSource(load.ticker, resolveTickerDataMode(load.source)),
        representativeSymbols: params.representativeSymbols,
        includeSparkline: true,
        debug: params.debug,
      });
      cacheMarketSparklineRow(marketSparklineCacheKey(params.exchange, symbol), row);
    }

    logger.info(
      {
        domain: 'market-routes',
        exchange: params.exchange,
        refreshSymbols: normalizedSymbols,
        refreshCount: normalizedSymbols.length,
        elapsedMs: Date.now() - providerStartedAt,
      },
      `[GraphAPI] exchange=${params.exchange} phase=background_refresh count=${normalizedSymbols.length}`,
    );
  })()
    .catch((error) => {
      logger.warn(
        {
          domain: 'market-routes',
          exchange: params.exchange,
          refreshSymbols: normalizedSymbols,
          err: error,
        },
        'Graph background refresh failed',
      );
    })
    .finally(() => {
      marketSparklineRefreshInFlight.delete(refreshKey);
    });

  marketSparklineRefreshInFlight.set(refreshKey, refreshPromise);
  return refreshPromise;
}

function computeWebsocketMergeLagMs(rows: Array<{ updatedAt: number | null }>) {
  const lags = rows
    .map((row) => (row.updatedAt ? Math.max(Date.now() - row.updatedAt, 0) : null))
    .filter((lag): lag is number => lag !== null);

  return lags.length > 0 ? Math.max(...lags) : null;
}

function fromCachedTicker(item: ReturnType<typeof publicMarketDataStore.getTickers>[number]): CanonicalTickerSnapshot {
  return {
    ...toCanonicalMarket(item.exchange as ExchangeId, item.symbol),
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

function getSnapshotDisplayName(market: MarketUniverseItem) {
  return market.nameKo ?? market.nameEn ?? market.symbol;
}

function toSnapshotTrend(changeRate: number | null): MarketSnapshotTrend {
  if (changeRate === null || !Number.isFinite(changeRate)) {
    return 'unknown';
  }
  if (changeRate > 0) return 'up';
  if (changeRate < 0) return 'down';
  return 'flat';
}

function mapTickerDataModeToSnapshotSource(
  dataMode: MarketDataMode,
  stale: boolean,
): Exclude<SnapshotSource, 'mixed'> {
  switch (dataMode) {
    case 'snapshot':
      return 'snapshot';
    case 'streaming':
      return 'cache';
    case 'cached_snapshot':
    default:
      return stale ? 'fallback' : 'cache';
  }
}

function createSnapshotItemFromTicker(market: MarketUniverseItem, ticker: MarketTickerRow): MarketSnapshotItem {
  const source = mapTickerDataModeToSnapshotSource(ticker.dataMode, ticker.stale);
  const stale = ticker.stale;
  return {
    exchange: ticker.exchange,
    exchangeName: market.exchangeName,
    marketId: market.marketId,
    rawSymbol: ticker.rawSymbol,
    canonicalSymbol: market.canonicalSymbol,
    baseAsset: ticker.baseAsset,
    quoteAsset: ticker.quoteAsset,
    symbol: ticker.symbol,
    displaySymbol: market.displaySymbol,
    displayName: getSnapshotDisplayName(market),
    canonicalAssetKey: market.canonicalAssetKey,
    iconUrl: market.iconUrl,
    imageUrl: market.imageUrl ?? market.assetImageUrl ?? market.iconUrl,
    imageURL: market.imageURL ?? market.imageUrl ?? market.assetImageUrl ?? market.iconUrl,
    hasImage: market.hasImage ?? Boolean(market.assetImageUrl ?? market.iconUrl),
    assetImageUrl: market.iconUrl,
    imageAvailability: market.imageAvailability,
    imageFailureReason: market.imageFailureReason,
    imageMissingReason: market.imageMissingReason,
    fallbackType: market.fallbackType,
    assetType: market.assetType,
    canonicalName: market.canonicalName,
    fallbackColor: market.fallbackColor,
    fallbackInitials: market.fallbackInitials,
    assetSlug: market.assetSlug ?? null,
    imageFallbackKey: market.imageFallbackKey ?? null,
    fallbackKey: market.fallbackKey ?? market.imageFallbackKey ?? null,
    stableImageKey: market.stableImageKey ?? market.imageFallbackKey ?? null,
    imageLookupKey: market.imageLookupKey ?? market.imageFallbackKey ?? null,
    assetSupportStatus: market.assetSupportStatus,
    exchangeSymbol: market.exchangeSymbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    price: ticker.price,
    change24h: ticker.change24h,
    signedChangeRate: ticker.change24h,
    volume24h: ticker.volume24h,
    sparkline: ticker.sparkline,
    sparklinePoints: ticker.sparklinePoints,
    sparklineSource: ticker.sparklineSource,
    trend: toSnapshotTrend(ticker.change24h),
    timestamp: ticker.timestamp,
    asOf: ticker.sourceTimestamp,
    source,
    freshnessMs: ticker.cacheAgeMs,
    stale,
    status: stale ? 'stale' : 'success',
    marketStatus: stale ? 'stale' : 'live',
    errorCode: stale ? 'SNAPSHOT_STALE' : null,
    errorMessage: stale ? `${ticker.symbol} snapshot is stale` : null,
    registryMapped: market.registryMapped,
    tradable: market.tradable,
    isActive: market.isActive,
    capabilities: market.capabilities,
    isChartAvailable: market.isChartAvailable,
    isOrderBookAvailable: market.isOrderBookAvailable,
    isTradesAvailable: market.isTradesAvailable,
    unavailableReason: market.unavailableReason,
    kimchiComparable: market.kimchiComparable,
    kimchiComparisonReason: market.kimchiComparisonReason,
  };
}

function createPendingSnapshotItem(
  market: MarketUniverseItem,
  reason?: string,
): MarketSnapshotItem {
  const message = reason ?? `${market.symbol} snapshot is pending`;
  return {
    exchange: market.exchange,
    exchangeName: market.exchangeName,
    marketId: market.marketId,
    rawSymbol: market.rawSymbol,
    canonicalSymbol: market.canonicalSymbol,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    symbol: market.symbol,
    displaySymbol: market.displaySymbol,
    displayName: getSnapshotDisplayName(market),
    canonicalAssetKey: market.canonicalAssetKey,
    iconUrl: market.iconUrl,
    imageUrl: market.imageUrl ?? market.assetImageUrl ?? market.iconUrl,
    imageURL: market.imageURL ?? market.imageUrl ?? market.assetImageUrl ?? market.iconUrl,
    hasImage: market.hasImage ?? Boolean(market.assetImageUrl ?? market.iconUrl),
    assetImageUrl: market.iconUrl,
    imageAvailability: market.imageAvailability,
    imageFailureReason: market.imageFailureReason,
    imageMissingReason: market.imageMissingReason,
    fallbackType: market.fallbackType,
    assetType: market.assetType,
    canonicalName: market.canonicalName,
    fallbackColor: market.fallbackColor,
    fallbackInitials: market.fallbackInitials,
    assetSlug: market.assetSlug ?? null,
    imageFallbackKey: market.imageFallbackKey ?? null,
    fallbackKey: market.fallbackKey ?? market.imageFallbackKey ?? null,
    stableImageKey: market.stableImageKey ?? market.imageFallbackKey ?? null,
    imageLookupKey: market.imageLookupKey ?? market.imageFallbackKey ?? null,
    assetSupportStatus: market.assetSupportStatus,
    exchangeSymbol: market.exchangeSymbol,
    market: market.market,
    baseCurrency: market.baseCurrency,
    quoteCurrency: market.quoteCurrency,
    price: null,
    change24h: null,
    signedChangeRate: null,
    volume24h: null,
    sparkline: [],
    sparklinePoints: [],
    sparklineSource: 'unavailable',
    trend: 'unknown',
    timestamp: null,
    asOf: null,
    source: 'cache',
    freshnessMs: null,
    stale: false,
    status: 'partial',
    marketStatus: 'pending',
    errorCode: 'PARTIAL_DATA',
    errorMessage: message,
    registryMapped: market.registryMapped,
    tradable: market.tradable,
    isActive: market.isActive,
    capabilities: market.capabilities,
    isChartAvailable: market.isChartAvailable,
    isOrderBookAvailable: market.isOrderBookAvailable,
    isTradesAvailable: market.isTradesAvailable,
    unavailableReason: reason ?? null,
    kimchiComparable: market.kimchiComparable,
    kimchiComparisonReason: market.kimchiComparisonReason,
  };
}

function summarizeSnapshotFreshness(items: MarketSnapshotItem[]) {
  const freshnessValues = items
    .map((item) => item.freshnessMs)
    .filter((value): value is number => value !== null);
  const asOfValues = items
    .map((item) => item.asOf)
    .filter((value): value is number => value !== null);

  return {
    freshnessMs: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
    asOf: asOfValues.length > 0 ? Math.max(...asOfValues) : null,
    staleItemCount: items.filter((item) => item.marketStatus === 'stale').length,
    pendingItemCount: items.filter((item) => item.marketStatus === 'pending').length,
  };
}

function compareSnapshotItems(left: MarketSnapshotItem, right: MarketSnapshotItem) {
  const statusRank = (item: MarketSnapshotItem) => {
    switch (item.marketStatus) {
      case 'live':
        return 0;
      case 'stale':
        return 1;
      case 'pending':
      default:
        return 2;
    }
  };

  const statusDiff = statusRank(left) - statusRank(right);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const leftVolume = left.volume24h ?? Number.NEGATIVE_INFINITY;
  const rightVolume = right.volume24h ?? Number.NEGATIVE_INFINITY;
  if (leftVolume !== rightVolume) {
    return rightVolume - leftVolume;
  }

  const leftChange = Math.abs(left.signedChangeRate ?? Number.NEGATIVE_INFINITY);
  const rightChange = Math.abs(right.signedChangeRate ?? Number.NEGATIVE_INFINITY);
  if (leftChange !== rightChange) {
    return rightChange - leftChange;
  }

  if (left.registryMapped !== right.registryMapped) {
    return left.registryMapped ? -1 : 1;
  }

  return left.symbol.localeCompare(right.symbol);
}

function comparePrioritySnapshotItems(left: MarketSnapshotItem, right: MarketSnapshotItem) {
  const marketStatusRank = (item: MarketSnapshotItem) => {
    switch (item.marketStatus) {
      case 'live':
        return 0;
      case 'stale':
        return 1;
      case 'pending':
      default:
        return 2;
    }
  };

  const statusDiff = marketStatusRank(left) - marketStatusRank(right);
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const leftPriority = getRepresentativeMarketSymbolRank(left.symbol, left.exchange);
  const rightPriority = getRepresentativeMarketSymbolRank(right.symbol, right.exchange);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return compareSnapshotItems(left, right);
}

function sampleSparklinePoints(points: SparklinePoint[], limit: number) {
  if (points.length <= limit) {
    return points;
  }

  const sampled: SparklinePoint[] = [];
  const step = (points.length - 1) / Math.max(limit - 1, 1);
  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.min(Math.round(index * step), points.length - 1);
    const point = points[sourceIndex];
    if (!point) {
      continue;
    }

    const last = sampled[sampled.length - 1];
    if (!last || last.timestamp !== point.timestamp || last.price !== point.price) {
      sampled.push(point);
    }
  }

  const lastPoint = points[points.length - 1];
  const sampledLastPoint = sampled[sampled.length - 1];
  if (lastPoint && (!sampledLastPoint || sampledLastPoint.timestamp !== lastPoint.timestamp || sampledLastPoint.price !== lastPoint.price)) {
    sampled.push(lastPoint);
  }

  return sampled.slice(-limit);
}

function projectSnapshotItemForScope(item: MarketSnapshotItem, scope: MarketSnapshotScope): MarketSnapshotItem {
  if (scope === 'full' || scope === 'symbols') {
    return item;
  }

  const limit = SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT[scope];
  const sparklinePoints = sampleSparklinePoints(item.sparklinePoints, limit);
  return {
    ...item,
    sparklinePoints,
    sparkline: sparklinePoints.map((point) => point.price),
  };
}

function orderSnapshotItemsForScope(items: MarketSnapshotItem[], scope: MarketSnapshotScope) {
  if (scope === 'symbols') {
    return [...items];
  }

  const comparator = scope === 'full' ? compareSnapshotItems : comparePrioritySnapshotItems;
  return [...items].sort(comparator);
}

function summarizeMarketViewportRowStatus(params: {
  tickerRow: MarketTickerRow;
  sparklinePoints: SparklinePoint[];
}) {
  const missingCoreField = !Number.isFinite(params.tickerRow.price)
    || !Number.isFinite(params.tickerRow.change24h)
    || !Number.isFinite(params.tickerRow.volume24h);

  if (missingCoreField) {
    return {
      displayStatus: 'partial' as const,
      partial: true,
      debugReasons: ['missing_core_market_fields'],
    };
  }

  if (params.tickerRow.stale) {
    return {
      displayStatus: 'delayed' as const,
      partial: false,
      debugReasons: ['freshness_threshold_exceeded'],
    };
  }

  if (params.sparklinePoints.length > 0 && params.sparklinePoints.length < 2) {
    return {
      displayStatus: 'fresh' as const,
      partial: false,
      debugReasons: ['sparkline_point_count_insufficient'],
    };
  }

  return {
    displayStatus: 'fresh' as const,
    partial: false,
    debugReasons: [] as string[],
  };
}

function buildMarketViewportRow(params: {
  exchange: ExchangeId;
  market: MarketUniverseItem;
  tickerRow: MarketTickerRow;
  representativeSymbols: Set<string>;
  includeSparkline: boolean;
  debug: boolean;
}): MarketViewportRow {
  const sparklinePoints = params.includeSparkline
    ? sampleSparklinePoints(params.tickerRow.sparklinePoints, SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT.visible)
    : [];
  const sparkline = params.includeSparkline && sparklinePoints.length >= 2
    ? sparklinePoints.map((point) => point.price)
    : null;
  const status = summarizeMarketViewportRowStatus({
    tickerRow: params.tickerRow,
    sparklinePoints,
  });
  const debugReasons = [
    ...status.debugReasons,
    params.tickerRow.dataMode === 'snapshot' ? 'provider_snapshot' : null,
    params.tickerRow.dataMode === 'cached_snapshot' ? 'fallback_source' : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    selectedExchange: params.exchange,
    sourceExchange: params.tickerRow.exchange,
    marketId: params.market.marketId,
    rawSymbol: params.tickerRow.rawSymbol,
    canonicalSymbol: params.market.canonicalSymbol,
    baseAsset: params.tickerRow.baseAsset,
    quoteAsset: params.tickerRow.quoteAsset,
    symbol: params.market.symbol,
    displaySymbol: params.market.displaySymbol,
    displayName: getSnapshotDisplayName(params.market),
    canonicalAssetKey: params.market.canonicalAssetKey,
    iconUrl: params.market.iconUrl,
    imageUrl: params.market.imageUrl ?? params.market.assetImageUrl ?? params.market.iconUrl,
    imageURL: params.market.imageURL ?? params.market.imageUrl ?? params.market.assetImageUrl ?? params.market.iconUrl,
    hasImage: params.market.hasImage ?? Boolean(params.market.assetImageUrl ?? params.market.iconUrl),
    assetImageUrl: params.market.iconUrl,
    imageAvailability: params.market.imageAvailability,
    imageFailureReason: params.market.imageFailureReason,
    imageMissingReason: params.market.imageMissingReason,
    fallbackType: params.market.fallbackType,
    assetType: params.market.assetType,
    canonicalName: params.market.canonicalName,
    fallbackColor: params.market.fallbackColor,
    fallbackInitials: params.market.fallbackInitials,
    assetSlug: params.market.assetSlug ?? null,
    imageFallbackKey: params.market.imageFallbackKey ?? null,
    fallbackKey: params.market.fallbackKey ?? params.market.imageFallbackKey ?? null,
    stableImageKey: params.market.stableImageKey ?? params.market.imageFallbackKey ?? null,
    imageLookupKey: params.market.imageLookupKey ?? params.market.imageFallbackKey ?? null,
    assetSupportStatus: params.market.assetSupportStatus,
    exchangeSymbol: params.market.exchangeSymbol,
    market: params.market.market,
    baseCurrency: params.market.baseCurrency,
    quoteCurrency: params.market.quoteCurrency,
    currentPrice: params.tickerRow.price,
    change24h: params.tickerRow.change24h,
    signedChangeRate: params.tickerRow.change24h,
    volume24h: params.tickerRow.volume24h,
    representative: params.representativeSymbols.has(params.market.symbol),
    updatedAt: params.tickerRow.sourceTimestamp,
    displayStatus: status.displayStatus,
    partial: status.partial,
    isActive: params.market.isActive,
    capabilities: params.market.capabilities,
    isChartAvailable: params.market.isChartAvailable,
    isOrderBookAvailable: params.market.isOrderBookAvailable,
    isTradesAvailable: params.market.isTradesAvailable,
    unavailableReason: params.market.unavailableReason,
    sparkline,
    sparklinePointCount: params.includeSparkline ? params.tickerRow.sparklinePoints.length : null,
    debugReasons: params.debug ? debugReasons : undefined,
  };
}

function buildMarketViewportRowFromSnapshotItem(params: {
  exchange: ExchangeId;
  item: MarketSnapshotItem;
  representativeSymbols: Set<string>;
  includeSparkline: boolean;
  debug: boolean;
}): MarketViewportRow {
  const sparklinePoints = params.includeSparkline
    ? sampleSparklinePoints(params.item.sparklinePoints, SNAPSHOT_SCOPE_SPARKLINE_POINT_LIMIT.visible)
    : [];
  const hasRenderableSparkline = sparklinePoints.length >= 2;
  const displayStatus: MarketDisplayStatus =
    params.item.marketStatus === 'pending'
      ? 'partial'
      : params.item.marketStatus === 'stale' || params.item.stale
        ? 'delayed'
        : params.item.status === 'error'
          ? 'unavailable'
          : 'fresh';
  const debugReasons = [
    params.item.errorMessage,
    params.includeSparkline && !hasRenderableSparkline ? 'sparkline_unavailable' : null,
    params.item.source === 'fallback' ? 'fallback_source' : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    selectedExchange: params.exchange,
    sourceExchange: params.item.exchange,
    marketId: params.item.marketId,
    rawSymbol: params.item.rawSymbol,
    canonicalSymbol: params.item.canonicalSymbol,
    baseAsset: params.item.baseAsset,
    quoteAsset: params.item.quoteAsset,
    symbol: params.item.symbol,
    displaySymbol: params.item.displaySymbol,
    displayName: params.item.displayName,
    canonicalAssetKey: params.item.canonicalAssetKey,
    iconUrl: params.item.iconUrl,
    imageUrl: params.item.imageUrl,
    imageURL: params.item.imageURL,
    hasImage: params.item.hasImage,
    assetImageUrl: params.item.assetImageUrl,
    imageAvailability: params.item.imageAvailability,
    imageFailureReason: params.item.imageFailureReason,
    imageMissingReason: params.item.imageMissingReason,
    fallbackType: params.item.fallbackType,
    assetType: params.item.assetType,
    canonicalName: params.item.canonicalName,
    fallbackColor: params.item.fallbackColor,
    fallbackInitials: params.item.fallbackInitials,
    assetSlug: params.item.assetSlug,
    imageFallbackKey: params.item.imageFallbackKey,
    fallbackKey: params.item.fallbackKey,
    stableImageKey: params.item.stableImageKey,
    imageLookupKey: params.item.imageLookupKey,
    assetSupportStatus: params.item.assetSupportStatus,
    exchangeSymbol: params.item.exchangeSymbol,
    market: params.item.market,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    currentPrice: params.item.price,
    change24h: params.item.change24h,
    signedChangeRate: params.item.signedChangeRate,
    volume24h: params.item.volume24h,
    representative: params.representativeSymbols.has(params.item.symbol),
    updatedAt: params.item.asOf ?? params.item.timestamp,
    displayStatus,
    partial: displayStatus === 'partial' || displayStatus === 'unavailable' || (params.includeSparkline && !hasRenderableSparkline),
    isActive: params.item.isActive,
    capabilities: params.item.capabilities,
    isChartAvailable: params.item.isChartAvailable,
    isOrderBookAvailable: params.item.isOrderBookAvailable,
    isTradesAvailable: params.item.isTradesAvailable,
    unavailableReason: params.item.unavailableReason,
    sparkline: params.includeSparkline && hasRenderableSparkline
      ? sparklinePoints.map((point) => point.price)
      : null,
    sparklinePointCount: params.includeSparkline ? params.item.sparklinePoints.length : null,
    debugReasons: params.debug ? debugReasons : undefined,
  };
}

function buildBaseSnapshotItem(params: {
  exchange: ExchangeId;
  item: MarketSnapshotItem;
  representativeSymbols: Set<string>;
}): MarketBaseSnapshotItem {
  return {
    selectedExchange: params.exchange,
    sourceExchange: params.item.exchange,
    marketId: params.item.marketId,
    rawSymbol: params.item.rawSymbol,
    canonicalSymbol: params.item.canonicalSymbol,
    baseAsset: params.item.baseAsset,
    quoteAsset: params.item.quoteAsset,
    symbol: params.item.symbol,
    displaySymbol: params.item.displaySymbol,
    displayName: params.item.displayName,
    canonicalAssetKey: params.item.canonicalAssetKey,
    iconUrl: params.item.iconUrl,
    imageUrl: params.item.imageUrl,
    imageURL: params.item.imageURL,
    hasImage: params.item.hasImage,
    assetImageUrl: params.item.assetImageUrl,
    imageAvailability: params.item.imageAvailability,
    imageFailureReason: params.item.imageFailureReason,
    imageMissingReason: params.item.imageMissingReason,
    fallbackType: params.item.fallbackType,
    assetType: params.item.assetType,
    canonicalName: params.item.canonicalName,
    fallbackColor: params.item.fallbackColor,
    fallbackInitials: params.item.fallbackInitials,
    assetSlug: params.item.assetSlug,
    imageFallbackKey: params.item.imageFallbackKey,
    fallbackKey: params.item.fallbackKey,
    stableImageKey: params.item.stableImageKey,
    imageLookupKey: params.item.imageLookupKey,
    assetSupportStatus: params.item.assetSupportStatus,
    exchangeSymbol: params.item.exchangeSymbol,
    market: params.item.market,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    currentPrice: params.item.price,
    change24h: params.item.change24h,
    signedChangeRate: params.item.signedChangeRate,
    volume24h: params.item.volume24h,
    updatedAt: params.item.asOf ?? params.item.timestamp,
    asOf: params.item.asOf,
    freshnessMs: params.item.freshnessMs,
    stale: params.item.stale,
    status: params.item.status,
    marketStatus: params.item.marketStatus,
    source: params.item.source,
    representative: params.representativeSymbols.has(params.item.symbol),
    tradable: params.item.tradable,
    isActive: params.item.isActive,
    capabilities: params.item.capabilities,
    isChartAvailable: params.item.isChartAvailable,
    isOrderBookAvailable: params.item.isOrderBookAvailable,
    isTradesAvailable: params.item.isTradesAvailable,
    unavailableReason: params.item.unavailableReason,
    kimchiComparable: params.item.kimchiComparable,
    errorCode: params.item.errorCode,
    errorMessage: params.item.errorMessage,
  };
}

function buildAssetImageClientKey(exchange: string | null | undefined, symbol: string) {
  return exchange ? `${exchange}:${symbol}` : symbol;
}

function resolveStableAssetFallbackKey(params: {
  exchange?: ExchangeId | null;
  symbol: string;
  rawSymbol?: string | null;
  marketId?: string | null;
  canonicalAssetKey?: string | null;
  assetSlug?: string | null;
  coingeckoId?: string | null;
}) {
  return buildImageFallbackKey({
    exchange: params.exchange ?? null,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol ?? null,
    marketId: params.marketId ?? null,
    canonicalAssetKey: params.canonicalAssetKey ?? null,
    assetSlug: params.assetSlug ?? null,
    coingeckoId: params.coingeckoId ?? null,
  });
}

function isDefaultPlaceholderAssetImage(view: AssetMetadataView | undefined, imageUrl: string | null | undefined) {
  return Boolean(imageUrl)
    && (view?.fallbackType === 'default_placeholder'
      || view?.source === 'placeholder'
      || imageUrl === DEFAULT_COIN_PLACEHOLDER_ICON_URL);
}

function toUsableAssetImageUrl(view: AssetMetadataView | undefined, fallbackUrl: string | null | undefined) {
  const imageUrl = view?.assetImageUrl ?? fallbackUrl ?? null;
  return isDefaultPlaceholderAssetImage(view, imageUrl) ? null : imageUrl;
}

function toProjectedImageAvailability(view: AssetMetadataView | undefined, assetImageUrl: string | null, canonicalAssetKey?: string | null): AssetImageAvailability {
  if (assetImageUrl) {
    return view?.fallbackHit ? 'fallback' : 'available';
  }
  return view?.imageAvailability ?? (canonicalAssetKey ? 'pending' : 'unavailable');
}

function hasPromotablePreferredImage(preferredImage: ReturnType<typeof resolvePreferredAssetImage>) {
  return Boolean(
    preferredImage.preferredImageSlug
    && preferredImage.preferredImageCoingeckoId
    && !preferredImage.fallbackOnly,
  );
}

function toProjectedImageMissingReason(
  view: AssetMetadataView | undefined,
  assetImageUrl: string | null,
  preferredImage: ReturnType<typeof resolvePreferredAssetImage>,
  canonicalAssetKey?: string | null,
): string | null {
  if (assetImageUrl) {
    return null;
  }
  if (!canonicalAssetKey) {
    return 'unsupported_asset';
  }
  const promotablePreferredImage = hasPromotablePreferredImage(preferredImage);
  const preferredCoingeckoId = preferredImage.preferredImageCoingeckoId;
  const coingeckoIdMismatch = Boolean(
    promotablePreferredImage
    && preferredCoingeckoId
    && view?.coingeckoId
    && view.coingeckoId !== preferredCoingeckoId,
  );
  if (promotablePreferredImage && coingeckoIdMismatch) {
    return 'curated_slug_resolved_but_source_merge_failed';
  }
  if (view?.failureReason === 'alias_not_found') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_source_merge_failed'
      : preferredImage.imageMissingReason ?? 'alias_miss';
  }
  if (view?.failureReason === 'coingecko_fetch_failed') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_cache_stale'
      : 'upstream_fetch_failed';
  }
  if (view?.failureReason === 'image_url_empty' || view?.failureReason === 'no_image_url') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_metadata_missing'
      : 'source_metadata_absent';
  }
  if (view?.failureReason === 'unsupported_asset') {
    return 'unsupported_asset';
  }
  if (view?.fallbackType === 'stale_cache' || view?.source === 'stale_cache') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_cache_stale'
      : 'metadata_pending';
  }
  if (view?.fallbackType === 'default_placeholder' || view?.fallbackType === 'fiat_initials' || view?.source === 'placeholder') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_projection_not_promoted'
      : preferredImage.imageMissingReason ?? 'missing_registry_image_metadata';
  }
  if (view?.imageAvailability === 'lookup_failed') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_cache_stale'
      : 'upstream_fetch_failed';
  }
  if (view?.imageAvailability === 'pending') {
    return promotablePreferredImage
      ? 'curated_slug_resolved_but_cache_stale'
      : preferredImage.imageMissingReason ?? 'metadata_pending';
  }
  return preferredImage.imageMissingReason ?? 'no_image_url';
}

function toProjectedResolutionStage(params: {
  view: AssetMetadataView | undefined;
  assetImageUrl: string | null;
  preferredImage: ReturnType<typeof resolvePreferredAssetImage>;
  canonicalAssetKey?: string | null;
}) {
  if (!params.canonicalAssetKey) {
    return null;
  }
  if (params.assetImageUrl) {
    return 'projection_applied';
  }
  if (params.preferredImage.fallbackOnly) {
    return 'fallback_only';
  }
  if (hasPromotablePreferredImage(params.preferredImage)) {
    if (
      params.view?.coingeckoId === params.preferredImage.preferredImageCoingeckoId
      || params.view?.source === 'curated'
      || params.view?.source === 'coingecko'
      || params.view?.source === 'stale_cache'
      || params.view?.failureReason === 'image_url_empty'
      || params.view?.failureReason === 'no_image_url'
      || params.view?.failureReason === 'coingecko_fetch_failed'
    ) {
      return 'source_metadata_found';
    }
    return 'preferred_image_resolved';
  }
  return 'canonical_resolved';
}

function buildAssetMetadataProjection(params: {
  view: AssetMetadataView | undefined;
  assetImageUrl: string | null;
  exchange?: ExchangeId | null;
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
  const imageFallbackKey = params.view?.imageFallbackKey ?? resolveStableAssetFallbackKey({
    exchange: params.exchange ?? null,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol ?? null,
    marketId: params.marketId ?? null,
    canonicalAssetKey: params.canonicalAssetKey ?? null,
    assetSlug,
    coingeckoId: params.view?.coingeckoId ?? preferredImage.preferredImageCoingeckoId ?? null,
  });
  const imageMissingReason = toProjectedImageMissingReason(
    params.view,
    params.assetImageUrl,
    preferredImage,
    params.canonicalAssetKey,
  );
  const preferredImageSymbol = params.view?.preferredImageSymbol ?? preferredImage.preferredImageSymbol ?? null;
  const preferredImageSlug = params.view?.preferredImageSlug ?? preferredImage.preferredImageSlug ?? assetSlug ?? null;
  const imageResolutionSource = toProjectedImageResolutionSource({
    assetImageUrl: params.assetImageUrl,
    view: params.view,
    preferredImage,
  });
  return {
    imageUrl: params.assetImageUrl,
    imageURL: params.assetImageUrl,
    hasImage: Boolean(params.assetImageUrl),
    imageAvailability: toProjectedImageAvailability(params.view, params.assetImageUrl, params.canonicalAssetKey),
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
    preferredImageSymbol,
    preferredImageSlug,
    imageResolutionSource,
    resolutionStage: toProjectedResolutionStage({
      view: params.view,
      assetImageUrl: params.assetImageUrl,
      preferredImage,
      canonicalAssetKey: params.canonicalAssetKey,
    }),
    manualCurationRecommended: params.view?.manualCurationRecommended ?? preferredImage.manualCurationRecommended,
    fallbackOnly: preferredImage.fallbackOnly,
  };
}

function logAssetImageProjection(params: {
  route: string;
  exchange?: string | null;
  symbol: string;
  canonicalAssetKey: string | null | undefined;
  assetImageUrl: string | null | undefined;
  imageAvailability?: AssetImageAvailability | null;
  failureReason?: string | null;
  reason?: string | null;
  imageFallbackKey?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  fallbackHit?: boolean;
  source?: string | null;
}) {
  const hasImage = Boolean(params.assetImageUrl);
  const reason = !hasImage ? params.imageMissingReason ?? params.reason ?? 'metadata_missing' : null;
  const clientSymbolKey = buildAssetImageClientKey(params.exchange, params.symbol);

  if (hasImage) {
    logger.info(
      {
        domain: 'asset-image',
        action: 'image_hit',
        route: params.route,
        exchange: params.exchange ?? null,
        symbol: params.symbol,
        clientSymbolKey,
        canonicalAssetKey: params.canonicalAssetKey ?? null,
        imageAvailability: params.imageAvailability ?? null,
        failureReason: params.failureReason ?? null,
        imageMissingReason: params.imageMissingReason ?? null,
        imageFallbackKey: params.imageFallbackKey ?? null,
        fallbackType: params.fallbackType ?? null,
        fallbackHit: params.fallbackHit ?? false,
        source: params.source ?? null,
      },
      `[AssetImageDebug] action=image_hit exchange=${params.exchange ?? 'null'} symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey ?? 'null'}`,
    );
  } else {
    logger.info(
      {
        domain: 'asset-image',
        action: 'image_miss',
        route: params.route,
        exchange: params.exchange ?? null,
        symbol: params.symbol,
        clientSymbolKey,
        canonicalAssetKey: params.canonicalAssetKey ?? null,
        imageAvailability: params.imageAvailability ?? null,
        failureReason: params.failureReason ?? reason,
        imageMissingReason: params.imageMissingReason ?? reason,
        reason,
        imageFallbackKey: params.imageFallbackKey ?? null,
        fallbackType: params.fallbackType ?? null,
        fallbackHit: params.fallbackHit ?? false,
        source: params.source ?? null,
      },
      `[AssetImageDebug] action=image_miss exchange=${params.exchange ?? 'null'} symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey ?? 'null'} reason=${reason}`,
    );
  }

  logger.info(
    {
      domain: 'asset-image',
      action: 'projection_included',
      route: params.route,
      exchange: params.exchange ?? null,
      symbol: params.symbol,
      clientSymbolKey,
      canonicalAssetKey: params.canonicalAssetKey ?? null,
      hasImage,
      imageAvailability: params.imageAvailability ?? null,
      failureReason: params.failureReason ?? reason,
      imageMissingReason: params.imageMissingReason ?? reason,
      reason,
      imageFallbackKey: params.imageFallbackKey ?? null,
      fallbackType: params.fallbackType ?? null,
      fallbackHit: params.fallbackHit ?? false,
      source: params.source ?? null,
    },
    `[AssetImageDebug] action=projection_included route=${params.route} symbol=${params.symbol} canonicalAssetKey=${params.canonicalAssetKey ?? 'null'} hasImage=${hasImage} availability=${params.imageAvailability ?? 'null'} reason=${reason ?? 'null'} fallbackHit=${params.fallbackHit ?? false}`,
  );
}

function logAssetImageCoverageSummary(params: {
  route: string;
  exchange: string;
  scope: 'exchange' | 'first_page_visible' | 'top_volume' | 'response';
  items: Array<{
    assetImageUrl?: string | null;
    imageMissingReason?: string | null;
    reason?: string | null;
  }>;
}) {
  const withImageCount = params.items.filter((item) => Boolean(item.assetImageUrl)).length;
  const coverage = toImageCoverageRate(withImageCount, params.items.length);

  logger.info(
    {
      domain: 'asset-image',
      action: 'coverage_summary',
      route: params.route,
      exchange: params.exchange,
      scope: params.scope,
      totalCount: params.items.length,
      withImageCount,
      withoutImageCount: params.items.length - withImageCount,
      coverage,
      falseReasonStats: summarizeAssetImageReasons(params.items),
    },
    `[AssetImageDebug] action=coverage_summary exchange=${params.exchange} total=${params.items.length} withImage=${withImageCount} coverage=${coverage}`,
  );
}

function getAssetImageMissSampleRate() {
  const parsed = Number.parseFloat(process.env.ASSET_IMAGE_MISS_SAMPLE_RATE ?? '0.1');
  if (!Number.isFinite(parsed)) {
    return 0.1;
  }
  return Math.max(0, Math.min(parsed, 1));
}

function hashAssetImageDiagnosticKey(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function shouldLogAssetImageMissDiagnostic(sampleKey: string) {
  if (process.env.ASSET_IMAGE_DEBUG === 'true' || process.env.NODE_ENV !== 'production') {
    return true;
  }
  const sampleRate = getAssetImageMissSampleRate();
  if (sampleRate <= 0) {
    return false;
  }
  if (sampleRate >= 1) {
    return true;
  }
  return (hashAssetImageDiagnosticKey(sampleKey) % 10_000) < Math.floor(sampleRate * 10_000);
}

function toDiagnosticMissingReason(params: {
  failureReason?: string | null;
  reason?: string | null;
}) {
  if (params.reason === 'missing_curated_mapping'
    || params.reason === 'missing_preferred_slug'
    || params.reason === 'missing_registry_image_metadata'
    || params.reason === 'ambiguous_short_symbol'
    || params.reason === 'unresolved_numeric_variant'
    || params.reason === 'unresolved_branded_variant'
    || params.reason === 'fiat_or_quote_like_symbol'
    || params.reason === 'intentionally_fallback_only'
    || params.reason === 'curated_slug_resolved_but_metadata_missing'
    || params.reason === 'curated_slug_resolved_but_cache_stale'
    || params.reason === 'curated_slug_resolved_but_projection_not_promoted'
    || params.reason === 'curated_slug_resolved_but_source_merge_failed'
    || params.reason === 'source_metadata_absent') {
    return params.reason;
  }
  if (params.failureReason === 'unsupported_asset' || params.reason === 'unsupported_asset') {
    return 'unsupported_asset';
  }
  if (params.failureReason === 'no_image_url' || params.reason === 'no_image_url') {
    return 'no_image_url';
  }
  if (params.failureReason === 'alias_not_found' || params.reason === 'alias_miss') {
    return 'alias_missing';
  }
  if (params.failureReason === 'image_url_empty' || params.reason === 'image_url_empty') {
    return 'no_image_url';
  }
  if (params.reason === 'metadata_pending') {
    return 'metadata_pending';
  }
  return 'metadata_missing';
}

function logAssetImageMissDiagnostic(item: {
  exchange?: string | null;
  symbol: string;
  marketId?: string | null;
  rawSymbol?: string | null;
  canonicalSymbol?: string | null;
  canonicalAssetKey?: string | null;
  assetSlug?: string | null;
  preferredImageSlug?: string | null;
  imageResolutionSource?: string | null;
  resolutionStage?: string | null;
  imageFallbackKey?: string | null;
  assetImageUrl?: string | null;
  imageAvailability?: AssetImageAvailability | null;
  failureReason?: string | null;
  imageMissingReason?: string | null;
  reason?: string | null;
}) {
  if (item.assetImageUrl) {
    return;
  }

  const sampleKey = [
    item.exchange ?? 'unknown',
    item.marketId ?? item.rawSymbol ?? item.symbol,
    item.canonicalAssetKey ?? item.canonicalSymbol ?? item.symbol,
  ].join(':');
  if (!shouldLogAssetImageMissDiagnostic(sampleKey)) {
    return;
  }

  const missingReason = toDiagnosticMissingReason({
    failureReason: item.failureReason,
    reason: item.imageMissingReason ?? item.reason,
  });
  logger.info(
    {
      domain: 'asset-image',
      action: 'image_miss_diagnostic',
      exchange: item.exchange ?? null,
      symbol: item.symbol,
      marketId: item.marketId ?? null,
      rawSymbol: item.rawSymbol ?? null,
      canonicalSymbol: item.canonicalSymbol ?? null,
      canonicalAssetKey: item.canonicalAssetKey ?? null,
      assetSlugResolved: item.assetSlug ?? null,
      preferredImageSlug: item.preferredImageSlug ?? null,
      imageResolutionSource: item.imageResolutionSource ?? null,
      resolutionStage: item.resolutionStage ?? null,
      imageFallbackKey: item.imageFallbackKey ?? null,
      imageUrlResolved: item.assetImageUrl ?? null,
      imageAvailability: item.imageAvailability ?? null,
      missingReason,
      imageMissingReason: item.imageMissingReason ?? null,
      failureReason: item.failureReason ?? null,
    },
    `[AssetImageDebug] action=image_miss_diagnostic exchange=${item.exchange ?? 'null'} symbol=${item.symbol} marketId=${item.marketId ?? 'null'} canonicalAssetKey=${item.canonicalAssetKey ?? 'null'} missingReason=${missingReason}`,
  );
}

function logAssetImageProjectionBatch(
  route: string,
  items: Array<{
    exchange?: string | null;
    symbol: string;
    marketId?: string | null;
    rawSymbol?: string | null;
    canonicalSymbol?: string | null;
    canonicalAssetKey?: string | null;
    assetSlug?: string | null;
    preferredImageSlug?: string | null;
    imageResolutionSource?: string | null;
    resolutionStage?: string | null;
    imageFallbackKey?: string | null;
    assetImageUrl?: string | null;
    imageAvailability?: AssetImageAvailability | null;
    failureReason?: string | null;
    imageMissingReason?: string | null;
    reason?: string | null;
    fallbackType?: string | null;
    fallbackHit?: boolean;
    source?: string | null;
    volume24h?: number | null;
  }>,
) {
  for (const item of items) {
    logAssetImageProjection({
      route,
      exchange: item.exchange,
      symbol: item.symbol,
      canonicalAssetKey: item.canonicalAssetKey,
      assetImageUrl: item.assetImageUrl,
      imageAvailability: item.imageAvailability,
      failureReason: item.failureReason,
      reason: item.reason,
      imageFallbackKey: item.imageFallbackKey,
      imageMissingReason: item.imageMissingReason,
      fallbackType: item.fallbackType,
      fallbackHit: item.fallbackHit,
      source: item.source,
    });
    logAssetImageMissDiagnostic(item);
  }

  const withImageCount = items.filter((item) => Boolean(item.assetImageUrl)).length;
  const withoutImageItems = items.filter((item) => !item.assetImageUrl);
  const falseReasonStats = withoutImageItems.reduce<Record<string, number>>((acc, item) => {
    const reason = item.imageMissingReason ?? item.reason ?? 'missing_metadata';
    acc[reason] = (acc[reason] ?? 0) + 1;
    return acc;
  }, {});
  const fallbackHitCount = items.filter((item) => item.fallbackHit).length;
  const coverageRate = items.length === 0 ? 0 : Number(((withImageCount / items.length) * 100).toFixed(2));

  logger.info(
    {
      domain: 'asset-image',
      action: 'projection_summary',
      route,
      totalCount: items.length,
      withImageCount,
      withoutImageCount: items.length - withImageCount,
      coverageRate,
      fallbackHitCount,
      falseReasonStats,
    },
    `[AssetImageDebug] action=projection_summary route=${route} total=${items.length} withImage=${withImageCount} coverageRate=${coverageRate}`,
  );

  const itemsByExchange = items.reduce<Map<string, typeof items>>((grouped, item) => {
    const exchange = item.exchange ?? 'unknown';
    const bucket = grouped.get(exchange) ?? [];
    bucket.push(item);
    grouped.set(exchange, bucket);
    return grouped;
  }, new Map<string, typeof items>());

  for (const [exchange, exchangeItems] of itemsByExchange.entries()) {
    logAssetImageCoverageSummary({
      route,
      exchange,
      scope: 'exchange',
      items: exchangeItems,
    });
  }

  if (route === '/market/tickers') {
    const firstPageVisibleItems = items.slice(0, FIRST_PAGE_VISIBLE_SYMBOL_LIMIT);
    const topVolumeItems = [...items]
      .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
      .slice(0, FIRST_PAGE_VISIBLE_SYMBOL_LIMIT);
    logAssetImageCoverageSummary({
      route,
      exchange: 'all',
      scope: 'first_page_visible',
      items: firstPageVisibleItems,
    });
    logAssetImageCoverageSummary({
      route,
      exchange: 'all',
      scope: 'top_volume',
      items: topVolumeItems,
    });
  }
}

function toAssetImageProjectionReason(params: {
  canonicalAssetKey?: string | null;
  failureReason?: string | null;
}): AssetImageProjectionReason {
  if (!params.canonicalAssetKey) {
    return 'unsupported_asset';
  }

  switch (params.failureReason) {
    case 'alias_not_found':
      return 'alias_miss';
    case 'no_image_url':
      return 'no_image_url';
    case 'image_url_empty':
      return 'no_image_url';
    case 'coingecko_fetch_failed':
      return 'upstream_fetch_failed';
    case 'unsupported_asset':
      return 'unsupported_asset';
    case 'missing_metadata':
      return 'metadata_pending';
    default:
      return 'metadata_missing';
  }
}

function toProjectedImageResolutionSource(params: {
  assetImageUrl: string | null;
  view: AssetMetadataView | undefined;
  preferredImage: ReturnType<typeof resolvePreferredAssetImage>;
}) {
  if (params.assetImageUrl) {
    if (params.view?.source === 'curated' || params.view?.source === 'coingecko') {
      return 'direct_slug';
    }
    if (params.view?.source === 'alias_fallback' || params.preferredImage.resolutionSource.includes('override')) {
      return 'alias_map';
    }
  }

  if (hasPromotablePreferredImage(params.preferredImage)) {
    if (params.preferredImage.resolutionSource.startsWith('registry')) {
      return 'registry_identity';
    }
    return params.preferredImage.resolutionSource.includes('override') ? 'alias_map' : 'direct_slug';
  }

  if (params.preferredImage.resolutionSource.startsWith('registry')) {
    return 'registry_identity';
  }

  if (params.preferredImage.fallbackOnly) {
    return 'fallback_only';
  }

  return params.view?.source ?? params.preferredImage.resolutionSource;
}

async function getAssetViewsForProjection(
  lookups: AssetMetadataLookup[],
  context: string,
  options?: {
    eager?: boolean;
  },
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

async function decorateMarketUniverseItems(items: MarketUniverseItem[], options?: { eagerAssetMetadata?: boolean }) {
  if (items.length === 0) {
    return items;
  }

  const views = await getAssetViewsForProjection(items.map((item) => ({
    exchange: item.exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    displayName: item.nameEn ?? item.englishName ?? item.nameKo ?? item.koreanName ?? item.symbol,
    canonicalAssetKey: item.canonicalAssetKey,
  })), 'market.decorateMarketUniverseItems', {
    eager: options?.eagerAssetMetadata,
  });

  return items.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? item.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, item.assetImageUrl ?? item.iconUrl ?? null);
    return {
      ...item,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? item.iconUrl ?? null,
      assetImageUrl,
      ...buildAssetMetadataProjection({
        view,
        assetImageUrl,
        exchange: item.exchange,
        symbol: item.symbol,
        rawSymbol: item.rawSymbol,
        marketId: item.marketId,
        canonicalAssetKey,
      }),
    };
  });
}

async function decorateMarketViewportRows(rows: MarketViewportRow[]) {
  if (rows.length === 0) {
    return rows;
  }

  const views = await getAssetViewsForProjection(rows.map((row) => ({
    exchange: row.selectedExchange,
    symbol: row.symbol,
    exchangeSymbol: row.exchangeSymbol,
    displayName: row.canonicalName ?? row.displayName,
    canonicalAssetKey: row.canonicalAssetKey,
  })), 'market.decorateMarketViewportRows');

  return rows.map((row) => {
    const view = views.get(row.canonicalAssetKey ?? row.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? row.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, row.assetImageUrl ?? row.iconUrl ?? null);
    return {
      ...row,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? row.iconUrl ?? null,
      assetImageUrl,
      ...buildAssetMetadataProjection({
        view,
        assetImageUrl,
        exchange: row.selectedExchange,
        symbol: row.symbol,
        rawSymbol: row.rawSymbol,
        marketId: row.marketId,
        canonicalAssetKey,
      }),
    };
  });
}

async function decorateMarketSnapshotItems(items: MarketSnapshotItem[]) {
  if (items.length === 0) {
    return items;
  }

  const views = await getAssetViewsForProjection(items.map((item) => ({
    exchange: item.exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    displayName: item.canonicalName ?? item.displayName,
    canonicalAssetKey: item.canonicalAssetKey,
  })), 'market.decorateMarketSnapshotItems');

  return items.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? item.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, item.assetImageUrl ?? item.iconUrl ?? null);
    return {
      ...item,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? item.iconUrl ?? null,
      assetImageUrl,
      ...buildAssetMetadataProjection({
        view,
        assetImageUrl,
        exchange: item.exchange,
        symbol: item.symbol,
        rawSymbol: item.rawSymbol,
        marketId: item.marketId,
        canonicalAssetKey,
      }),
    };
  });
}

async function decorateBaseSnapshotItems(items: MarketBaseSnapshotItem[]) {
  if (items.length === 0) {
    return items;
  }

  const views = await getAssetViewsForProjection(items.map((item) => ({
    exchange: item.selectedExchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    displayName: item.canonicalName ?? item.displayName,
    canonicalAssetKey: item.canonicalAssetKey,
  })), 'market.decorateBaseSnapshotItems');

  return items.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? item.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, item.assetImageUrl ?? item.iconUrl ?? null);
    return {
      ...item,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? item.iconUrl ?? null,
      assetImageUrl,
      ...buildAssetMetadataProjection({
        view,
        assetImageUrl,
        exchange: item.selectedExchange,
        symbol: item.symbol,
        rawSymbol: item.rawSymbol,
        marketId: item.marketId,
        canonicalAssetKey,
      }),
    };
  });
}

async function decorateComparableKimchiItems(exchange: ExchangeId, items: ComparableKimchiSymbolItem[]) {
  if (items.length === 0) {
    return items;
  }

  const views = await getAssetViewsForProjection(items.map((item) => ({
    exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    displayName: item.canonicalName ?? item.displayName,
    canonicalAssetKey: item.canonicalAssetKey,
  })), 'market.decorateComparableKimchiItems');

  return items.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? item.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, item.assetImageUrl ?? item.iconUrl ?? null);
    return {
      ...item,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? item.iconUrl ?? null,
      assetImageUrl,
      ...buildAssetMetadataProjection({
        view,
        assetImageUrl,
        exchange,
        symbol: item.symbol,
        rawSymbol: item.rawSymbol,
        marketId: item.marketId,
        canonicalAssetKey,
      }),
    };
  });
}

async function decorateMarketTickerItems(items: MarketTickerItem[]) {
  if (items.length === 0) {
    return items;
  }

  const views = await getAssetViewsForProjection(items.map((item) => ({
    exchange: item.exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    displayName: item.nameEn ?? item.englishName ?? item.nameKo ?? item.koreanName ?? item.symbol,
    canonicalAssetKey: item.canonicalAssetKey,
  })), '/market/tickers');

  const projectedItems = items.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const canonicalAssetKey = view?.canonicalAssetKey ?? item.canonicalAssetKey ?? null;
    const assetImageUrl = toUsableAssetImageUrl(view, item.assetImageUrl ?? item.iconUrl ?? null);
    const imageFields = buildAssetMetadataProjection({
      view,
      assetImageUrl,
      exchange: item.exchange,
      symbol: item.symbol,
      rawSymbol: item.rawSymbol,
      marketId: item.marketId,
      canonicalAssetKey,
    });
    return {
      ...item,
      canonicalAssetKey,
      iconUrl: assetImageUrl ?? item.iconUrl ?? null,
      assetImageUrl,
      ...imageFields,
    };
  });

  logAssetImageProjectionBatch('/market/tickers', projectedItems.map((item) => {
    const view = views.get(item.canonicalAssetKey ?? item.symbol);
    const reason = !item.assetImageUrl
      ? toAssetImageProjectionReason({
        canonicalAssetKey: item.canonicalAssetKey,
        failureReason: view?.failureReason ?? null,
      })
      : null;
    return {
      exchange: item.exchange,
      symbol: item.symbol,
      marketId: item.marketId,
      rawSymbol: item.rawSymbol,
      canonicalSymbol: item.canonicalSymbol,
      canonicalAssetKey: item.canonicalAssetKey,
      assetSlug: item.assetSlug,
      preferredImageSlug: item.preferredImageSlug,
      imageResolutionSource: item.imageResolutionSource,
      resolutionStage: item.resolutionStage,
      imageFallbackKey: item.imageFallbackKey,
      assetImageUrl: item.assetImageUrl,
      imageAvailability: item.imageAvailability,
      failureReason: item.imageFailureReason,
      imageMissingReason: item.imageMissingReason,
      reason,
      fallbackType: view?.fallbackType ?? null,
      fallbackHit: view?.fallbackHit ?? false,
      source: view?.source ?? null,
      volume24h: item.volume24h,
    };
  }));

  return projectedItems;
}

function toViewportSkipReason(params: {
  exchange: ExchangeId;
  symbol: string;
  loadReason?: string | null;
  marketExists: boolean;
  registryMapped: boolean;
}) {
  if (!params.marketExists) {
    return params.registryMapped ? 'not_listed_on_exchange_market_universe' : 'symbol_mapping_not_found';
  }

  return params.loadReason ?? 'missing_from_provider_snapshot';
}

function buildSnapshotItemsFromRows(params: {
  bundle: ProviderMarketUniverseBundle;
  tickerRows: Map<string, MarketTickerRow>;
  missingReasons: Map<string, string>;
}) {
  const partialFailures: SnapshotPartialFailure[] = [];
  const items = params.bundle.items.map<MarketSnapshotItem>((market) => {
    const ticker = params.tickerRows.get(market.symbol);
    if (ticker) {
      const item = createSnapshotItemFromTicker(market, ticker);
      if (item.marketStatus === 'stale') {
        partialFailures.push(toMarketSnapshotFailure({
          symbol: market.symbol,
          exchange: market.exchange,
          code: 'SNAPSHOT_STALE',
          message: `${market.symbol} snapshot is stale`,
          source: item.source,
          stage: 'snapshot_cache',
          retryable: true,
        }));
      }
      return item;
    }

    const reason = params.missingReasons.get(market.symbol) ?? 'listed_market_snapshot_pending';
    partialFailures.push(toMarketSnapshotFailure({
      symbol: market.symbol,
      exchange: market.exchange,
      code: 'PARTIAL_DATA',
      message: reason,
      source: 'cache',
      stage: 'snapshot_cache',
      retryable: true,
    }));
    return createPendingSnapshotItem(market, reason);
  });

  return {
    items: [...items].sort(compareSnapshotItems),
    partialFailures,
  };
}

function buildTickerRowsFromPublicStore(exchange: ExchangeId) {
  const rows = new Map<string, MarketTickerRow>();
  const cachedTickers = publicMarketDataStore.getTickers(exchange);

  for (const ticker of cachedTickers) {
    const canonical = fromCachedTicker(ticker);
    const metadata = createFreshnessMetadata({
      dataMode: 'streaming',
      sourceTimestamp: canonical.timestamp,
    });
    const dataMode: MarketDataMode = metadata.stale ? 'cached_snapshot' : 'streaming';
    rows.set(canonical.symbol, withTickerCompletenessFromSource(canonical, dataMode));
  }

  return rows;
}

async function loadTickerRowsFromSources(bundle: ProviderMarketUniverseBundle) {
  const representativeSymbols = getRepresentativeSymbolsForExchange(bundle.marketSymbols);
  const loads = await getExchangeTickerLoads(bundle.provider.exchange, bundle.marketSymbols, {
    freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotDefault,
    prioritySymbols: representativeSymbols,
    priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
  });
  const rows = new Map<string, MarketTickerRow>();
  const missingReasons = new Map<string, string>();

  for (const symbol of bundle.marketSymbols) {
    const load = loads.get(symbol);
    if (!load?.ticker) {
      missingReasons.set(symbol, load?.reason ?? 'missing_from_provider_snapshot');
      continue;
    }
    rows.set(symbol, withTickerCompletenessFromSource(load.ticker, resolveTickerDataMode(load.source)));
  }

  return { rows, missingReasons };
}

function buildUnavailableMarketSnapshotResponse(params: {
  exchange: ExchangeId;
  scope: MarketSnapshotScope;
  requestedSymbols: string[];
  partialFailures?: SnapshotPartialFailure[];
}): MarketSnapshotResponse {
  const partialFailures = params.partialFailures ?? [
    {
      exchange: params.exchange,
      code: 'ALL_PROVIDERS_FAILED',
      message: `${params.exchange} market snapshot is temporarily unavailable`,
      source: 'cache',
      stage: 'snapshot_cache',
      retryable: true,
    },
  ];

  return {
    exchange: params.exchange,
    scope: params.scope,
    requestedSymbols: params.requestedSymbols,
    items: [],
    partialFailures,
    status: 'failure',
    source: 'cache',
    freshnessMs: null,
    asOf: null,
    stale: true,
    total: 0,
    listedCount: 0,
    staleItemCount: 0,
    pendingItemCount: 0,
    excludedUnlistedCount: 0,
  };
}

function fromCachedOrderbook(item: NonNullable<ReturnType<typeof publicMarketDataStore.getOrderbook>>): CanonicalOrderbookSnapshot {
  return {
    ...toCanonicalMarket(item.exchange as ExchangeId, item.symbol),
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
    ...toCanonicalMarket(item.exchange as ExchangeId, item.symbol),
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
    executedAt: item.executedAt ?? (item.timestamp ? new Date(item.timestamp).toISOString() : null),
  };
}

function buildExchangeSnapshotCacheEntry(params: {
  bundle: ProviderMarketUniverseBundle;
  tickerRows: Map<string, MarketTickerRow>;
  missingReasons: Map<string, string>;
  lastRefreshedAt: number;
  lastUniverseLoadedAt: number;
}): ExchangeMarketSnapshotCacheEntry {
  const built = buildSnapshotItemsFromRows({
    bundle: params.bundle,
    tickerRows: params.tickerRows,
    missingReasons: params.missingReasons,
  });
  const freshness = summarizeSnapshotFreshness(built.items);
  const comparableKimchiItems = built.items
    .filter((item) => item.kimchiComparable)
    .sort((left, right) => comparePrioritySnapshotItems(left, right))
    .map((item, index) => ({
      marketId: item.marketId,
      rawSymbol: item.rawSymbol,
      canonicalSymbol: item.canonicalSymbol,
      baseAsset: item.baseAsset,
      quoteAsset: item.quoteAsset,
      symbol: item.symbol,
      displaySymbol: item.displaySymbol,
      displayName: item.displayName,
      canonicalAssetKey: item.canonicalAssetKey,
      iconUrl: item.iconUrl,
      imageUrl: item.imageUrl ?? null,
      imageURL: item.imageURL ?? null,
      hasImage: item.hasImage ?? Boolean(item.assetImageUrl),
      assetImageUrl: item.assetImageUrl,
      imageAvailability: item.imageAvailability,
      imageFailureReason: item.imageFailureReason,
      imageMissingReason: item.imageMissingReason,
      fallbackType: item.fallbackType,
      assetType: item.assetType,
      canonicalName: item.canonicalName,
      fallbackColor: item.fallbackColor,
      fallbackInitials: item.fallbackInitials,
      assetSlug: item.assetSlug ?? null,
      imageFallbackKey: item.imageFallbackKey ?? null,
      fallbackKey: item.fallbackKey ?? item.imageFallbackKey ?? null,
      stableImageKey: item.stableImageKey ?? item.imageFallbackKey ?? null,
      imageLookupKey: item.imageLookupKey ?? item.imageFallbackKey ?? null,
      assetSupportStatus: item.assetSupportStatus,
      market: item.market,
      exchangeSymbol: item.exchangeSymbol,
      price: item.price,
      marketStatus: item.marketStatus,
      priority: getRepresentativeMarketSymbolRank(item.symbol, params.bundle.provider.exchange) === Number.MAX_SAFE_INTEGER
        ? ('normal' as const)
        : ('top' as const),
      rank: index + 1,
    }));

  return {
    exchange: params.bundle.provider.exchange,
    bundle: params.bundle,
    fullItems: built.items,
    comparableKimchiItems,
    comparableKimchiSymbolSet: new Set(comparableKimchiItems.map((item) => item.symbol)),
    itemIndexBySymbol: new Map(built.items.map((item, index) => [item.symbol, index])),
    marketBySymbol: new Map(params.bundle.items.map((item) => [item.symbol, item])),
    partialFailures: built.partialFailures,
    missingReasons: new Map(params.missingReasons),
    source: summarizeSnapshotSource(built.items),
    status: summarizeSnapshotStatus(built.items),
    freshnessMs: freshness.freshnessMs,
    asOf: freshness.asOf,
    stale: freshness.staleItemCount > 0,
    listedCount: params.bundle.items.length,
    staleItemCount: freshness.staleItemCount,
    pendingItemCount: freshness.pendingItemCount,
    lastRefreshedAt: params.lastRefreshedAt,
    lastUniverseLoadedAt: params.lastUniverseLoadedAt,
  };
}

async function refreshExchangeMarketSnapshotCache(
  exchange: ExchangeId,
  params: {
    allowProviderFetch: boolean;
    forceUniverseRefresh?: boolean;
  },
): Promise<ExchangeMarketSnapshotCacheEntry | null> {
  const existingInFlight = exchangeMarketSnapshotRefreshInFlight.get(exchange);
  if (existingInFlight) {
    return existingInFlight;
  }

  const refreshPromise = (async () => {
    const now = Date.now();
    const existing = exchangeMarketSnapshotCache.get(exchange) ?? null;
    let bundle = existing?.bundle ?? null;
    let lastUniverseLoadedAt = existing?.lastUniverseLoadedAt ?? 0;
    const shouldRefreshUniverse = params.forceUniverseRefresh
      || !bundle
      || now - lastUniverseLoadedAt >= MARKET_SNAPSHOT_UNIVERSE_REFRESH_INTERVAL_MS;

    if (shouldRefreshUniverse) {
      try {
        const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
        const binanceSymbolSet = await loadBinanceSymbolSet();
        bundle = await buildProviderMarketUniverse(provider, binanceSymbolSet);
        lastUniverseLoadedAt = Date.now();
        logger.info(
          {
            domain: 'market-snapshot-cache',
            exchange,
            listedMarketCount: bundle.marketSymbols.length,
            registryMappedCount: bundle.registryMappedCount,
            registryUnmappedCount: bundle.registryUnmappedCount,
          },
          'Exchange listing universe loaded',
        );
      } catch (error) {
        logger.warn(
          { domain: 'market-snapshot-cache', exchange, stage: 'market_universe', err: error },
          'Exchange listing universe refresh failed',
        );
        if (!bundle) {
          return existing;
        }
      }
    }

    if (!bundle) {
      return existing;
    }

    let tickerRows = buildTickerRowsFromPublicStore(exchange);
    let missingReasons = new Map(existing?.missingReasons ?? []);

    if (params.allowProviderFetch) {
      try {
        const loaded = await loadTickerRowsFromSources(bundle);
        tickerRows = loaded.rows;
        missingReasons = loaded.missingReasons;
      } catch (error) {
        logger.warn(
          { domain: 'market-snapshot-cache', exchange, stage: 'ticker_snapshot', err: error },
          'Snapshot cache refresh fell back to public store projection',
        );
      }
    }

    if (tickerRows.size === 0 && existing) {
      return existing;
    }

    const entry = buildExchangeSnapshotCacheEntry({
      bundle,
      tickerRows,
      missingReasons,
      lastRefreshedAt: Date.now(),
      lastUniverseLoadedAt,
    });
    exchangeMarketSnapshotCache.set(exchange, entry);

    const collectorStatus = publicMarketDataStore
      .getCollectorStatuses()
      .find((status) => status.exchange === exchange);
    const ingestHealth = marketIngestHealth.getExchangeHealth(exchange);

    logger.info(
      {
        domain: 'market-snapshot-cache',
        exchange,
        listedMarketCount: entry.listedCount,
        responseItemCount: entry.fullItems.length,
        staleItemCount: entry.staleItemCount,
        pendingItemCount: entry.pendingItemCount,
        excludedUnlistedSymbolCount: 0,
        freshnessMs: entry.freshnessMs,
        asOf: entry.asOf,
        wsIngestHealth: collectorStatus
          ? {
              connected: collectorStatus.connected,
              mode: collectorStatus.mode ?? 'streaming',
              stale: collectorStatus.stale ?? false,
              lastMessageAt: collectorStatus.lastMessageAt ?? null,
              failureCount: collectorStatus.failureCount ?? 0,
            }
          : null,
        ingestHealth,
      },
      'Snapshot cache refresh success',
    );

    return entry;
  })()
    .catch((error) => {
      logger.warn(
        { domain: 'market-snapshot-cache', exchange, stage: 'refresh', err: error },
        'Snapshot cache refresh failed',
      );
      return exchangeMarketSnapshotCache.get(exchange) ?? null;
    })
    .finally(() => {
      exchangeMarketSnapshotRefreshInFlight.delete(exchange);
    });

  exchangeMarketSnapshotRefreshInFlight.set(exchange, refreshPromise);
  return refreshPromise;
}

function getCachedExchangeMarketSnapshot(exchange: ExchangeId) {
  return exchangeMarketSnapshotCache.get(exchange) ?? null;
}

async function ensureViewportExchangeMarketSnapshot(exchange: ExchangeId) {
  const cached = getCachedExchangeMarketSnapshot(exchange);
  if (cached) {
    if (Date.now() - cached.lastUniverseLoadedAt > MARKET_SNAPSHOT_UNIVERSE_REFRESH_INTERVAL_MS) {
      void refreshExchangeMarketSnapshotCache(exchange, { allowProviderFetch: false, forceUniverseRefresh: true });
    }
    return cached;
  }

  return refreshExchangeMarketSnapshotCache(exchange, {
    allowProviderFetch: false,
    forceUniverseRefresh: true,
  });
}

async function ensureCachedExchangeMarketSnapshot(exchange: ExchangeId) {
  const cached = getCachedExchangeMarketSnapshot(exchange);
  if (cached) {
    if (Date.now() - cached.lastRefreshedAt > MARKET_SNAPSHOT_REFRESH_INTERVAL_MS) {
      void refreshExchangeMarketSnapshotCache(exchange, { allowProviderFetch: true });
    }
    return cached;
  }

  return refreshExchangeMarketSnapshotCache(exchange, {
    allowProviderFetch: true,
    forceUniverseRefresh: true,
  });
}

function filterSnapshotItemsForSymbols(
  entry: ExchangeMarketSnapshotCacheEntry,
  symbols: string[],
) {
  const itemMap = new Map(entry.fullItems.map((item) => [item.symbol, item]));
  const supportedSet = entry.bundle.marketSymbolSet;
  const items: MarketSnapshotItem[] = [];
  const partialFailures = entry.partialFailures.filter((failure) => failure.symbol && symbols.includes(failure.symbol));
  let excludedUnlistedCount = 0;

  for (const symbol of symbols) {
    if (!supportedSet.has(symbol)) {
      excludedUnlistedCount += 1;
      const failure = classifyMarketSnapshotFailure({
        exchange: entry.exchange,
        symbol,
        marketExists: false,
        hasError: false,
        registryMapped: hasSupportedAssetIdentity(symbol),
      });
      partialFailures.push(toMarketSnapshotFailure({
        symbol,
        exchange: entry.exchange,
        code: failure.code,
        message: failure.message,
        source: 'cache',
        stage: failure.stage,
        retryable: failure.retryable,
      }));
      continue;
    }

    const item = itemMap.get(symbol);
    if (item) {
      items.push(item);
    }
  }

  return { items, partialFailures, excludedUnlistedCount };
}

function buildMarketSnapshotResponse(params: {
  exchange: ExchangeId;
  scope: MarketSnapshotScope;
  requestedSymbols: string[];
  items: MarketSnapshotItem[];
  partialFailures: SnapshotPartialFailure[];
  listedCount: number;
  excludedUnlistedCount: number;
}): MarketSnapshotResponse {
  const freshness = summarizeSnapshotFreshness(params.items);
  return {
    exchange: params.exchange,
    scope: params.scope,
    requestedSymbols: params.requestedSymbols,
    items: params.items,
    partialFailures: params.partialFailures,
    status: summarizeSnapshotStatus(params.items),
    source: summarizeSnapshotSource(params.items),
    freshnessMs: freshness.freshnessMs,
    asOf: freshness.asOf,
    stale: freshness.staleItemCount > 0,
    total: params.items.length,
    listedCount: params.listedCount,
    staleItemCount: freshness.staleItemCount,
    pendingItemCount: freshness.pendingItemCount,
    excludedUnlistedCount: params.excludedUnlistedCount,
  };
}

function toCanonicalTickerFromEvent(ticker: NormalizedMarketTicker): CanonicalTickerSnapshot {
  return {
    ...toCanonicalMarket(ticker.exchange as ExchangeId, ticker.symbol),
    symbol: ticker.symbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency as QuoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  };
}

function buildProjectedTickerRowFromLatest(exchange: ExchangeId, symbol: string, fallbackTicker?: CanonicalTickerSnapshot) {
  const cached = publicMarketDataStore.getTicker(exchange, symbol);
  const source = cached
    ? fromCachedTicker(cached)
    : fallbackTicker ?? null;
  if (!source) {
    return null;
  }

  const freshness = createFreshnessMetadata({
    dataMode: 'streaming',
    sourceTimestamp: source.timestamp,
  });
  const dataMode: MarketDataMode = freshness.stale ? 'cached_snapshot' : 'streaming';
  return withTickerCompletenessFromSource(source, dataMode);
}

function synchronizeCachedSnapshotFailure(entry: ExchangeMarketSnapshotCacheEntry, item: MarketSnapshotItem) {
  entry.partialFailures = entry.partialFailures.filter((failure) => failure.symbol !== item.symbol);
  if (item.marketStatus === 'stale') {
    entry.partialFailures.push(toMarketSnapshotFailure({
      symbol: item.symbol,
      exchange: entry.exchange,
      code: 'SNAPSHOT_STALE',
      message: `${item.symbol} snapshot is stale`,
      source: item.source,
      stage: 'snapshot_cache',
      retryable: true,
    }));
  }
}

function updateCachedSnapshotItemProjection(exchange: ExchangeId, symbol: string, fallbackTicker?: CanonicalTickerSnapshot) {
  const entry = exchangeMarketSnapshotCache.get(exchange);
  if (!entry) {
    return;
  }

  const index = entry.itemIndexBySymbol.get(symbol);
  const market = entry.marketBySymbol.get(symbol);
  if (index === undefined || !market) {
    return;
  }

  const tickerRow = buildProjectedTickerRowFromLatest(exchange, symbol, fallbackTicker);
  if (!tickerRow) {
    return;
  }

  const nextItem = createSnapshotItemFromTicker(market, tickerRow);
  entry.fullItems[index] = nextItem;
  synchronizeCachedSnapshotFailure(entry, nextItem);
  entry.lastRefreshedAt = Date.now();
  entry.asOf = nextItem.asOf ?? entry.asOf;
  entry.freshnessMs = nextItem.freshnessMs ?? entry.freshnessMs;
}

export async function startMarketSnapshotCache() {
  if (marketSnapshotCacheStarted) {
    return;
  }

  marketSnapshotCacheStarted = true;
  marketSnapshotTickerListener = (payload) => {
    const exchange = payload.exchange as ExchangeId;
    if (exchangeMarketSnapshotCache.has(exchange)) {
      updateCachedSnapshotItemProjection(exchange, payload.symbol, toCanonicalTickerFromEvent(payload));
    }
  };
  marketSnapshotTradeListener = (payload) => {
    const exchange = payload.exchange as ExchangeId;
    if (exchangeMarketSnapshotCache.has(exchange)) {
      updateCachedSnapshotItemProjection(exchange, payload.symbol);
    }
  };
  marketEventBus.onTicker(marketSnapshotTickerListener);
  marketEventBus.onTrade(marketSnapshotTradeListener);

  for (const exchange of EXCHANGE_IDS) {
    void refreshExchangeMarketSnapshotCache(exchange, {
      allowProviderFetch: false,
      forceUniverseRefresh: true,
    });

    const interval = setInterval(() => {
      void refreshExchangeMarketSnapshotCache(exchange, {
        allowProviderFetch: false,
        forceUniverseRefresh: true,
      });
    }, MARKET_SNAPSHOT_UNIVERSE_REFRESH_INTERVAL_MS);
    exchangeMarketSnapshotIntervals.set(exchange, interval);
  }
}

export async function stopMarketSnapshotCache() {
  if (!marketSnapshotCacheStarted) {
    return;
  }

  marketSnapshotCacheStarted = false;
  if (marketSnapshotTickerListener) {
    marketEventBus.offTyped('ticker', marketSnapshotTickerListener);
    marketSnapshotTickerListener = null;
  }
  if (marketSnapshotTradeListener) {
    marketEventBus.offTyped('trade', marketSnapshotTradeListener);
    marketSnapshotTradeListener = null;
  }

  for (const interval of exchangeMarketSnapshotIntervals.values()) {
    clearInterval(interval);
  }
  exchangeMarketSnapshotIntervals.clear();
}

function compareViewportCandidates(
  left: MarketSnapshotItem,
  right: MarketSnapshotItem,
  exchange: ExchangeId,
  sort: 'volume' | 'change' | 'symbol' | 'price',
) {
  const representativeDiff = getRepresentativeMarketSymbolRank(left.symbol, exchange)
    - getRepresentativeMarketSymbolRank(right.symbol, exchange);
  if (representativeDiff !== 0) {
    return representativeDiff;
  }

  const valueBySort = (item: MarketSnapshotItem) => {
    switch (sort) {
      case 'change':
        return Math.abs(item.signedChangeRate ?? Number.NEGATIVE_INFINITY);
      case 'price':
        return item.price ?? Number.NEGATIVE_INFINITY;
      case 'symbol':
        return Number.NaN;
      case 'volume':
      default:
        return item.volume24h ?? Number.NEGATIVE_INFINITY;
    }
  };

  if (sort === 'symbol') {
    return left.symbol.localeCompare(right.symbol);
  }

  const leftValue = valueBySort(left);
  const rightValue = valueBySort(right);
  if (leftValue !== rightValue) {
    return rightValue - leftValue;
  }

  return compareSnapshotItems(left, right);
}

function buildViewportCandidateItems(params: {
  entry: ExchangeMarketSnapshotCacheEntry;
  exchange: ExchangeId;
  tab: 'all' | 'representatives';
  sort: 'volume' | 'change' | 'symbol' | 'price';
}) {
  const representativeSet = new Set(getRepresentativeSymbolsForExchange(params.entry.bundle.marketSymbols, params.exchange));
  const baseItems = params.tab === 'representatives'
    ? params.entry.fullItems.filter((item) => representativeSet.has(item.symbol))
    : params.entry.fullItems;

  return [...baseItems].sort((left, right) => compareViewportCandidates(left, right, params.exchange, params.sort));
}

function buildOverviewCandidateSymbols(entry: ExchangeMarketSnapshotCacheEntry, exchange: ExchangeId, limit: number) {
  const representativeSymbols = getRepresentativeSymbolsForExchange(entry.bundle.marketSymbols, exchange);
  const ordered = buildViewportCandidateItems({
    entry,
    exchange,
    tab: 'all',
    sort: 'volume',
  }).map((item) => item.symbol);
  const combined = [
    ...representativeSymbols,
    ...ordered.filter((symbol) => !representativeSymbols.includes(symbol)),
  ];

  return combined.slice(0, limit);
}

async function resolveMarketViewportRows(params: {
  exchange: ExchangeId;
  entry: ExchangeMarketSnapshotCacheEntry;
  symbols: string[];
  includeSparkline: boolean;
  debug: boolean;
}): Promise<{
  rows: MarketViewportRow[];
  mappedSymbolCount: number;
  skippedSymbols: MarketViewportDebugSymbol[];
  providerLatencyMs: number | null;
  staleReused: boolean;
}> {
  const normalizedSymbols = normalizeSymbolBatch(params.symbols);
  const marketBySymbol = new Map(params.entry.bundle.items.map((item) => [item.symbol, item]));
  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(params.entry.bundle.marketSymbols, params.exchange));
  const supportedSymbols: string[] = [];
  const skippedSymbols: MarketViewportDebugSymbol[] = [];

  for (const symbol of normalizedSymbols) {
    const market = marketBySymbol.get(symbol);
    if (!market) {
      skippedSymbols.push({
        symbol,
        reason: toViewportSkipReason({
          exchange: params.exchange,
          symbol,
          marketExists: false,
          registryMapped: hasSupportedAssetIdentity(symbol),
        }),
      });
      continue;
    }

    supportedSymbols.push(symbol);
  }

  if (supportedSymbols.length === 0) {
    return {
      rows: [],
      mappedSymbolCount: 0,
      skippedSymbols,
      providerLatencyMs: null,
      staleReused: false,
    };
  }

  const providerStartedAt = Date.now();
  const loads = await getExchangeTickerLoads(params.exchange, supportedSymbols, {
    freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotDefault,
    prioritySymbols: getRepresentativeSymbolsForExchange(supportedSymbols, params.exchange),
    priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
    providerTimeoutMs: 1_200,
  });
  const providerLatencyMs = Date.now() - providerStartedAt;
  const rows: MarketViewportRow[] = [];
  let staleReused = false;

  for (const symbol of supportedSymbols) {
    const market = marketBySymbol.get(symbol);
    const load = loads.get(symbol);
    if (!market || !load?.ticker) {
      skippedSymbols.push({
        symbol,
        reason: toViewportSkipReason({
          exchange: params.exchange,
          symbol,
          loadReason: load?.reason,
          marketExists: Boolean(market),
          registryMapped: hasSupportedAssetIdentity(symbol),
        }),
      });
      continue;
    }

    staleReused ||= load.source === 'public_store_stale' || load.source === 'public_store_expired';
    const tickerRow = withTickerCompletenessFromSource(load.ticker, resolveTickerDataMode(load.source));
    rows.push(buildMarketViewportRow({
      exchange: params.exchange,
      market,
      tickerRow,
      representativeSymbols,
      includeSparkline: params.includeSparkline,
      debug: params.debug,
    }));
  }

  return {
    rows,
    mappedSymbolCount: supportedSymbols.length,
    skippedSymbols,
    providerLatencyMs,
    staleReused,
  };
}

function buildMarketViewportResponse(params: {
  exchange: ExchangeId;
  requestKind: 'overview' | 'list' | 'sparkline';
  rows: MarketViewportRow[];
  page?: CursorPage;
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbols: MarketViewportDebugSymbol[];
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  debug: boolean;
  staleReused: boolean;
}): MarketOverviewResponse | MarketListResponse | MarketSparklineResponse {
  const updatedAtValues = params.rows
    .map((row) => row.updatedAt)
    .filter((value): value is number => value !== null);
  const responseBase = {
    selectedExchange: params.exchange,
    sourceExchange: params.exchange,
    updatedAt: updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : null,
    displayStatus: summarizeViewportDisplayStatus(params.rows, params.skippedSymbols.length),
    partial: params.skippedSymbols.length > 0 || params.rows.some((row) => row.partial),
    skippedSymbolCount: params.skippedSymbols.length,
  };
  const debug = params.debug
    ? {
        requestKind: params.requestKind,
        requestedSymbolCount: params.requestedSymbolCount,
        mappedSymbolCount: params.mappedSymbolCount,
        skippedSymbolCount: params.skippedSymbols.length,
        firstPaintElapsedMs: params.firstPaintElapsedMs,
        hydrationElapsedMs: params.hydrationElapsedMs,
        providerLatencyMs: params.providerLatencyMs,
        websocketMergeLagMs: computeWebsocketMergeLagMs(params.rows),
        staleReused: params.staleReused,
        skippedSymbols: params.skippedSymbols,
      } satisfies MarketViewportDebugMeta
    : undefined;

  if (params.requestKind === 'sparkline') {
    return {
      ...responseBase,
      items: params.rows.map((row) => ({
        selectedExchange: row.selectedExchange,
        sourceExchange: row.sourceExchange,
        marketId: row.marketId,
        rawSymbol: row.rawSymbol,
        canonicalSymbol: row.canonicalSymbol,
        baseAsset: row.baseAsset,
        quoteAsset: row.quoteAsset,
        symbol: row.symbol,
        displaySymbol: row.displaySymbol,
        displayName: row.displayName,
        canonicalAssetKey: row.canonicalAssetKey,
        iconUrl: row.iconUrl,
        assetImageUrl: row.assetImageUrl,
        representative: row.representative,
        updatedAt: row.updatedAt,
        displayStatus: row.displayStatus,
        partial: row.partial,
        sparkline: row.sparkline ?? null,
        sparklinePointCount: row.sparklinePointCount ?? null,
        debugReasons: row.debugReasons,
      })),
      debug,
    };
  }

  return {
    ...responseBase,
    items: params.rows,
    page: params.page ?? buildCursorPage(0, params.rows.length, params.rows.length),
    debug,
  };
}

function logMarketViewportResponse(params: {
  exchange: ExchangeId;
  requestKind: 'overview' | 'list' | 'sparkline';
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbols: MarketViewportDebugSymbol[];
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  staleReused: boolean;
  response: MarketOverviewResponse | MarketListResponse | MarketSparklineResponse;
}) {
  logger.info(
    {
      domain: 'market-routes',
      exchange: params.exchange,
      requestKind: params.requestKind,
      requestedSymbolCount: params.requestedSymbolCount,
      mappedSymbolCount: params.mappedSymbolCount,
      skippedSymbolCount: params.skippedSymbols.length,
      firstPaintElapsedMs: params.firstPaintElapsedMs,
      hydrationElapsedMs: params.hydrationElapsedMs,
      providerLatencyMs: params.providerLatencyMs,
      websocketMergeLagMs: computeWebsocketMergeLagMs(params.response.items),
      staleReused: params.staleReused,
      returnedCount: params.response.items.length,
      displayStatus: params.response.displayStatus,
      skippedSymbols: params.skippedSymbols,
    },
    'Resolved market viewport response',
  );
}

export async function getBaseMarketSnapshot(params: {
  exchange: ExchangeId;
  symbols?: string[];
  scope?: MarketSnapshotScope;
  limit?: number;
}): Promise<MarketBaseSnapshotResponse> {
  const startedAt = Date.now();
  const cacheHit = Boolean(getCachedExchangeMarketSnapshot(params.exchange));
  const normalized = normalizeSymbolRequest(params.symbols ?? []);
  const stageStartedAt = Date.now();
  const entry = await ensureViewportExchangeMarketSnapshot(params.exchange);
  logPipelineDebug('base_snapshot', Date.now() - stageStartedAt, {
    exchange: params.exchange,
    cacheHit,
    requestedCount: normalized.requestedCount,
    normalizedCount: normalized.symbols.length,
  });

  if (!entry) {
    const elapsedMs = Date.now() - startedAt;
    logger.info(
      {
        domain: 'market-routes',
        exchange: params.exchange,
        requested: true,
        rows: 0,
        cacheHit,
        elapsedMs,
      },
      `[BaseMarketAPI] exchange=${params.exchange} requested=true rows=0 cacheHit=${cacheHit} elapsedMs=${elapsedMs}`,
    );
    return {
      selectedExchange: params.exchange,
      sourceExchange: params.exchange,
      scope: params.scope ?? (normalized.symbols.length > 0 ? 'symbols' : 'full'),
      requestedSymbols: normalized.symbols,
      acceptedSymbols: [],
      rejectedSymbols: normalized.rejectedSymbols,
      unsupportedSymbols: normalized.symbols.map((symbol) => ({
        symbol,
        reason: 'exchange_market_snapshot_unavailable',
        retryable: true,
      })),
      items: [],
      status: 'failure',
      partial: true,
      cacheHit,
      freshnessMs: null,
      asOf: null,
      stale: true,
      total: 0,
      listedCount: 0,
      elapsedMs,
    };
  }

  const scope = normalized.symbols.length > 0 ? 'symbols' : params.scope ?? 'full';
  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(entry.bundle.marketSymbols, params.exchange));
  const unsupportedSymbols: MarketSymbolRequestFailure[] = [];
  let snapshotItems: MarketSnapshotItem[];

  if (normalized.symbols.length > 0) {
    snapshotItems = normalized.symbols.flatMap((symbol) => {
      if (!entry.bundle.marketSymbolSet.has(symbol)) {
        unsupportedSymbols.push({
          symbol,
          reason: hasSupportedAssetIdentity(symbol) ? 'not_listed_on_exchange_market_universe' : 'symbol_mapping_not_found',
          retryable: false,
        });
        return [];
      }

      const index = entry.itemIndexBySymbol.get(symbol);
      const item = index !== undefined ? entry.fullItems[index] : null;
      return item ? [item] : [];
    });
  } else {
    snapshotItems = orderSnapshotItemsForScope(entry.fullItems, scope);
    if (params.limit !== undefined) {
      snapshotItems = snapshotItems.slice(0, Math.max(params.limit, 0));
    }
  }

  const items = await decorateBaseSnapshotItems(snapshotItems.map((item) => buildBaseSnapshotItem({
    exchange: params.exchange,
    item,
    representativeSymbols,
  })));
  logAssetImageProjectionBatch('/market/base-snapshot', items);
  const freshnessValues = items
    .map((item) => item.freshnessMs)
    .filter((value): value is number => value !== null);
  const asOfValues = items
    .map((item) => item.asOf)
    .filter((value): value is number => value !== null);
  const elapsedMs = Date.now() - startedAt;
  const partial = normalized.rejectedSymbols.length > 0
    || unsupportedSymbols.length > 0
    || items.some((item) => item.status !== 'success');
  const status: SnapshotOverallStatus = items.length === 0
    ? 'failure'
    : partial
      ? 'partial_success'
      : 'success';

  logger.info(
    {
      domain: 'market-routes',
      exchange: params.exchange,
      requested: true,
      rows: items.length,
      cacheHit,
      elapsedMs,
      requestedCount: normalized.requestedCount,
      normalizedCount: normalized.symbols.length,
      rejected: normalized.rejectedSymbols.length,
      unsupported: unsupportedSymbols.length,
    },
    `[BaseMarketAPI] exchange=${params.exchange} requested=true rows=${items.length} cacheHit=${cacheHit} elapsedMs=${elapsedMs}`,
  );

  return {
    selectedExchange: params.exchange,
    sourceExchange: params.exchange,
    scope,
    requestedSymbols: normalized.symbols,
    acceptedSymbols: items.map((item) => item.symbol),
    rejectedSymbols: normalized.rejectedSymbols,
    unsupportedSymbols,
    items,
    status,
    partial,
    cacheHit,
    freshnessMs: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
    asOf: asOfValues.length > 0 ? Math.max(...asOfValues) : null,
    stale: items.some((item) => item.stale),
    total: items.length,
    listedCount: entry.listedCount,
    elapsedMs,
  };
}

export async function getMarketOverview(params: {
  exchange: ExchangeId;
  limit?: number;
  debug?: boolean;
}): Promise<MarketOverviewResponse> {
  const limit = params.limit ?? DEFAULT_MARKET_OVERVIEW_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const startedAt = Date.now();
  const entry = await ensureViewportExchangeMarketSnapshot(params.exchange);
  if (!entry) {
    return buildMarketViewportResponse({
      exchange: params.exchange,
      requestKind: 'overview',
      rows: [],
      page: buildCursorPage(0, limit, 0),
      requestedSymbolCount: 0,
      mappedSymbolCount: 0,
      skippedSymbols: [],
      firstPaintElapsedMs: Date.now() - startedAt,
      hydrationElapsedMs: 0,
      providerLatencyMs: null,
      debug: Boolean(params.debug),
      staleReused: false,
    }) as MarketOverviewResponse;
  }

  const candidateSymbols = buildOverviewCandidateSymbols(entry, params.exchange, limit);
  const resolved = await resolveMarketViewportRows({
    exchange: params.exchange,
    entry,
    symbols: candidateSymbols,
    includeSparkline: false,
    debug: Boolean(params.debug),
  });
  const decoratedRows = await decorateMarketViewportRows(resolved.rows);
  logAssetImageProjectionBatch('/market/overview', decoratedRows);
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'overview',
    rows: decoratedRows,
    page: buildCursorPage(0, limit, candidateSymbols.length),
    requestedSymbolCount: candidateSymbols.length,
    mappedSymbolCount: resolved.mappedSymbolCount,
    skippedSymbols: resolved.skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: 0,
    providerLatencyMs: resolved.providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused: resolved.staleReused,
  }) as MarketOverviewResponse;

  logMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'overview',
    requestedSymbolCount: candidateSymbols.length,
    mappedSymbolCount: resolved.mappedSymbolCount,
    skippedSymbols: resolved.skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: 0,
    providerLatencyMs: resolved.providerLatencyMs,
    staleReused: resolved.staleReused,
    response,
  });

  return response;
}

export async function getMarketList(params: {
  exchange: ExchangeId;
  tab?: 'all' | 'representatives';
  sort?: 'volume' | 'change' | 'symbol' | 'price';
  cursor?: string;
  limit?: number;
  debug?: boolean;
}): Promise<MarketListResponse> {
  const limit = params.limit ?? DEFAULT_MARKET_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const startedAt = Date.now();
  const entry = await ensureViewportExchangeMarketSnapshot(params.exchange);
  if (!entry) {
    return buildMarketViewportResponse({
      exchange: params.exchange,
      requestKind: 'list',
      rows: [],
      page: buildCursorPage(0, limit, 0),
      requestedSymbolCount: 0,
      mappedSymbolCount: 0,
      skippedSymbols: [],
      firstPaintElapsedMs: Date.now() - startedAt,
      hydrationElapsedMs: 0,
      providerLatencyMs: null,
      debug: Boolean(params.debug),
      staleReused: false,
    }) as MarketListResponse;
  }

  const offset = parseCursorOffset(params.cursor);
  const orderedItems = buildViewportCandidateItems({
    entry,
    exchange: params.exchange,
    tab: params.tab ?? 'all',
    sort: params.sort ?? 'volume',
  });
  const pageItems = orderedItems.slice(offset, offset + limit);
  const pageSymbols = pageItems.map((item) => item.symbol);
  const resolved = await resolveMarketViewportRows({
    exchange: params.exchange,
    entry,
    symbols: pageSymbols,
    includeSparkline: false,
    debug: Boolean(params.debug),
  });
  const decoratedRows = await decorateMarketViewportRows(resolved.rows);
  logAssetImageProjectionBatch('/market/list', decoratedRows);
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'list',
    rows: decoratedRows,
    page: buildCursorPage(offset, limit, orderedItems.length),
    requestedSymbolCount: pageSymbols.length,
    mappedSymbolCount: resolved.mappedSymbolCount,
    skippedSymbols: resolved.skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: resolved.providerLatencyMs ?? 0,
    providerLatencyMs: resolved.providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused: resolved.staleReused,
  }) as MarketListResponse;

  logMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'list',
    requestedSymbolCount: pageSymbols.length,
    mappedSymbolCount: resolved.mappedSymbolCount,
    skippedSymbols: resolved.skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: resolved.providerLatencyMs ?? 0,
    providerLatencyMs: resolved.providerLatencyMs,
    staleReused: resolved.staleReused,
    response,
  });

  return response;
}

export async function getMarketSparkline(params: {
  exchange: ExchangeId;
  symbols: string[];
  batchIndex?: number;
  allowStale?: boolean;
  debug?: boolean;
}): Promise<MarketSparklineResponse> {
  const normalized = normalizeSymbolRequest(params.symbols);
  const normalizedSymbols = normalized.symbols;
  const startedAt = Date.now();
  const cacheStartedAt = Date.now();
  const smallFastPath = normalizedSymbols.length > 0 && normalizedSymbols.length <= 20;
  let cacheHitCount = 0;
  let cacheStaleCount = 0;
  let snapshotFastPathCount = 0;
  let providerFetchCount = 0;
  let staleFallbackCount = 0;
  let backgroundRefreshScheduled = false;
  const entry = await ensureViewportExchangeMarketSnapshot(params.exchange);
  logPipelineDebug('graph_cache_lookup', Date.now() - cacheStartedAt, {
    exchange: params.exchange,
    requestedCount: normalized.requestedCount,
    normalizedCount: normalizedSymbols.length,
  });
  if (!entry) {
    const skippedSymbols = [
      ...normalized.rejectedSymbols.map((failure) => ({
        symbol: failure.symbol ?? failure.input ?? '',
        reason: failure.reason,
      })),
      ...normalizedSymbols.map((symbol) => ({ symbol, reason: 'exchange_market_snapshot_unavailable' })),
    ];
    const response = buildMarketViewportResponse({
      exchange: params.exchange,
      requestKind: 'sparkline',
      rows: [],
      requestedSymbolCount: normalizedSymbols.length,
      mappedSymbolCount: 0,
      skippedSymbols,
      firstPaintElapsedMs: Date.now() - startedAt,
      hydrationElapsedMs: 0,
      providerLatencyMs: null,
      debug: Boolean(params.debug),
      staleReused: false,
    }) as MarketSparklineResponse;

    return {
      ...response,
      partial: true,
      source: 'mixed',
      freshness: 'unavailable',
      generatedAt: Date.now(),
      missingSymbols: normalizedSymbols,
      usableSymbols: [],
      usableStaleSymbols: [],
      symbolMeta: normalizedSymbols.map((symbol) => ({
        symbol,
        source: 'provider_fetch',
        isRenderable: false,
        usable: false,
        renderPriority: 'unavailable',
        pointCount: 0,
        lastSuccessfulGraphAt: null,
        graphLatencyBucket: 'unavailable',
        freshnessBucket: 'unavailable',
        generatedAt: Date.now(),
        fallbackReason: 'no_cache',
      })),
      requestedSymbols: normalizedSymbols,
      acceptedSymbols: [],
      rejectedSymbols: normalized.rejectedSymbols,
      unsupportedSymbols: normalizedSymbols.map((symbol) => ({
        symbol,
        reason: 'exchange_market_snapshot_unavailable',
        retryable: true,
      })),
      unavailableSymbols: [],
      cache: { hit: 0, miss: normalizedSymbols.length, stale: 0 },
      batch: {
        index: params.batchIndex ?? 0,
        requestedCount: normalized.requestedCount,
        success: 0,
        failed: skippedSymbols.length,
      },
    };
  }

  const marketBySymbol = new Map(entry.bundle.items.map((item) => [item.symbol, item]));
  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(entry.bundle.marketSymbols, params.exchange));
  const unsupportedSymbols: MarketSymbolRequestFailure[] = [];
  const unavailableSymbols: MarketSymbolRequestFailure[] = [];
  const skippedSymbols: MarketViewportDebugSymbol[] = normalized.rejectedSymbols.map((failure) => ({
    symbol: failure.symbol ?? failure.input ?? '',
    reason: failure.reason,
  }));
  const rowsBySymbol = new Map<string, MarketViewportRow>();
  const symbolsToHydrate: string[] = [];
  const staleSymbolsToRefresh: string[] = [];
  const usableStaleFallbacks = new Map<string, CachedMarketSparklineRow>();
  const symbolMetaBySymbol = new Map<string, MarketSparklineSymbolMeta>();
  const usableStaleSymbols = new Set<string>();
  let staleReused = false;
  const markSparklineSymbolMeta = (metaParams: {
    symbol: string;
    row?: MarketViewportRow | null;
    source: MarketSparklineSymbolSource;
    generatedAt?: number;
    fallbackReason?: MarketSparklineFallbackReason;
  }) => {
    const usable = hasRenderableSparkline(metaParams.row);
    const pointCount = resolveSparklinePointCount(metaParams.row);
    const freshnessBucket = summarizeSparklineSymbolFreshness({
      row: metaParams.row,
      source: metaParams.source,
      usable,
    });
    const generatedAtForSymbol = metaParams.generatedAt ?? Date.now();
    const renderPriority = resolveSparklineRenderPriority({
      source: metaParams.source,
      row: metaParams.row,
    });
    const meta: MarketSparklineSymbolMeta = {
      symbol: metaParams.symbol,
      source: metaParams.source,
      isRenderable: usable,
      usable,
      renderPriority,
      pointCount,
      lastSuccessfulGraphAt: resolveLastSuccessfulGraphAt(metaParams.row, generatedAtForSymbol),
      graphLatencyBucket: resolveSparklineLatencyBucket({
        renderPriority,
        updatedAt: metaParams.row?.updatedAt ?? null,
      }),
      freshnessBucket,
      generatedAt: generatedAtForSymbol,
      ...(metaParams.fallbackReason ? { fallbackReason: metaParams.fallbackReason } : {}),
    };
    symbolMetaBySymbol.set(metaParams.symbol, meta);
    if (meta.source === 'stale_cache' && meta.usable) {
      usableStaleSymbols.add(metaParams.symbol);
    }
    logger.info(
      {
        domain: 'market-routes',
        exchange: params.exchange,
        symbol: metaParams.symbol,
        isRenderable: meta.isRenderable,
        renderPriority: meta.renderPriority,
        pointCount: meta.pointCount,
        freshnessBucket: meta.freshnessBucket,
        graphLatencyBucket: meta.graphLatencyBucket,
        reason: meta.fallbackReason,
      },
      `[GraphMetaDebug] exchange=${params.exchange} symbol=${metaParams.symbol} isRenderable=${meta.isRenderable} renderPriority=${meta.renderPriority} pointCount=${meta.pointCount}${meta.fallbackReason ? ` reason=${meta.fallbackReason}` : ''}`,
    );
  };

  for (const symbol of normalizedSymbols) {
    if (!entry.bundle.marketSymbolSet.has(symbol)) {
      const failure = {
        symbol,
        reason: hasSupportedAssetIdentity(symbol) ? 'not_listed_on_exchange_market_universe' : 'symbol_mapping_not_found',
        retryable: false,
      };
      unsupportedSymbols.push(failure);
      skippedSymbols.push({ symbol, reason: failure.reason });
      markSparklineSymbolMeta({
        symbol,
        row: null,
        source: 'provider_fetch',
        fallbackReason: 'unsupported',
      });
      logger.info(
        { domain: 'market-routes', exchange: params.exchange, symbol, phase: 'unsupported' },
        `[GraphAPI] exchange=${params.exchange} symbol=${symbol} phase=unsupported`,
      );
      continue;
    }

    const key = marketSparklineCacheKey(params.exchange, symbol);
    const cached = marketSparklineCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      cacheHitCount += 1;
      rowsBySymbol.set(symbol, cached.row);
      markSparklineSymbolMeta({
        symbol,
        row: cached.row,
        source: 'fresh_cache',
        generatedAt: cached.generatedAt,
      });
      logger.info(
        { domain: 'market-routes', exchange: params.exchange, symbol, phase: 'cache_fresh_hit' },
        `[GraphAPI] exchange=${params.exchange} symbol=${symbol} phase=cache_fresh_hit`,
      );
      continue;
    }
    if (cached && params.allowStale !== false && cached.staleUntil > now) {
      cacheStaleCount += 1;
      staleReused = true;
      rowsBySymbol.set(symbol, cached.row);
      staleSymbolsToRefresh.push(symbol);
        markSparklineSymbolMeta({
          symbol,
          row: cached.row,
          source: 'stale_cache',
          generatedAt: cached.generatedAt,
          fallbackReason: 'stale_cache',
        });
      logger.info(
        { domain: 'market-routes', exchange: params.exchange, symbol, phase: 'cache_stale_hit' },
        `[GraphAPI] exchange=${params.exchange} symbol=${symbol} phase=cache_stale_hit`,
      );
      continue;
    }
    if (cached && params.allowStale !== false && cached.usableUntil > now && hasRenderableSparkline(cached.row)) {
      usableStaleFallbacks.set(symbol, cached);
      if (smallFastPath) {
        cacheStaleCount += 1;
        staleReused = true;
        rowsBySymbol.set(symbol, cached.row);
        staleSymbolsToRefresh.push(symbol);
        markSparklineSymbolMeta({
          symbol,
          row: cached.row,
          source: 'stale_cache',
          generatedAt: cached.generatedAt,
          fallbackReason: 'stale_cache',
        });
        logger.info(
          {
            domain: 'market-routes',
            exchange: params.exchange,
            symbol,
            fallback: 'stale_cache',
            reason: 'stale_cache',
          },
          `[GraphAPI] exchange=${params.exchange} symbol=${symbol} fallback=stale_cache reason=stale_cache`,
        );
        continue;
      }
    }

    const index = entry.itemIndexBySymbol.get(symbol);
    const item = index !== undefined ? entry.fullItems[index] : null;
    if (item && item.sparklinePoints.length >= 2 && item.price !== null) {
      const row = buildMarketViewportRowFromSnapshotItem({
        exchange: params.exchange,
        item,
        representativeSymbols,
        includeSparkline: true,
        debug: Boolean(params.debug),
      });
      cacheMarketSparklineRow(key, row);
      rowsBySymbol.set(symbol, row);
      markSparklineSymbolMeta({
        symbol,
        row,
        source: 'fresh_cache',
      });
      snapshotFastPathCount += 1;
      logger.info(
        { domain: 'market-routes', exchange: params.exchange, symbol, phase: 'snapshot_compute' },
        `[GraphAPI] exchange=${params.exchange} symbol=${symbol} phase=snapshot_compute`,
      );
      continue;
    }

    symbolsToHydrate.push(symbol);
    logger.info(
      { domain: 'market-routes', exchange: params.exchange, symbol, phase: 'provider_fetch' },
      `[GraphAPI] exchange=${params.exchange} symbol=${symbol} phase=provider_fetch`,
    );
  }

  if (normalizedSymbols.length <= 20 && staleSymbolsToRefresh.length > 0) {
    backgroundRefreshScheduled = true;
    void refreshMarketSparklineRows({
      exchange: params.exchange,
      entry,
      symbols: staleSymbolsToRefresh,
      representativeSymbols,
      debug: Boolean(params.debug),
    });
  }

  let providerLatencyMs: number | null = null;
  if (symbolsToHydrate.length > 0) {
    const providerStartedAt = Date.now();
    const loads = await getExchangeTickerLoads(params.exchange, symbolsToHydrate, {
      freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotDefault,
      prioritySymbols: getRepresentativeSymbolsForExchange(symbolsToHydrate, params.exchange),
      priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
      providerTimeoutMs: symbolsToHydrate.length <= 20 ? 700 : 1_200,
    });
    providerLatencyMs = Date.now() - providerStartedAt;

    for (const symbol of symbolsToHydrate) {
      const market = marketBySymbol.get(symbol);
      const load = loads.get(symbol);
      const key = marketSparklineCacheKey(params.exchange, symbol);

      if (market && load?.ticker) {
        staleReused ||= load.source === 'public_store_stale' || load.source === 'public_store_expired';
        const row = buildMarketViewportRow({
          exchange: params.exchange,
          market,
          tickerRow: withTickerCompletenessFromSource(load.ticker, resolveTickerDataMode(load.source)),
          representativeSymbols,
          includeSparkline: true,
          debug: Boolean(params.debug),
        });
        const graphRow = row.sparkline && row.sparkline.length >= 2
          ? row
          : {
              ...row,
              partial: true,
              debugReasons: params.debug
                ? [...(row.debugReasons ?? []), 'sparkline_unavailable']
                : row.debugReasons,
            };
        if (!hasRenderableSparkline(graphRow) && usableStaleFallbacks.has(symbol)) {
          const fallback = usableStaleFallbacks.get(symbol);
          if (fallback) {
            rowsBySymbol.set(symbol, fallback.row);
            cacheStaleCount += 1;
            staleFallbackCount += 1;
            staleReused = true;
            markSparklineSymbolMeta({
              symbol,
              row: fallback.row,
              source: 'stale_cache',
              generatedAt: fallback.generatedAt,
              fallbackReason: 'insufficient_points',
            });
            logger.info(
              {
                domain: 'market-routes',
                exchange: params.exchange,
                symbol,
                fallback: 'stale_cache',
                reason: 'insufficient_points',
              },
              `[GraphAPI] exchange=${params.exchange} symbol=${symbol} fallback=stale_cache reason=insufficient_points`,
            );
            continue;
          }
        }
        cacheMarketSparklineRow(key, graphRow);
        rowsBySymbol.set(symbol, graphRow);
        providerFetchCount += 1;
        markSparklineSymbolMeta({
          symbol,
          row: graphRow,
          source: 'provider_fetch',
          fallbackReason: hasRenderableSparkline(graphRow)
            ? load.source === 'public_store_stale' || load.source === 'public_store_expired'
              ? 'stale_cache'
              : undefined
            : 'insufficient_points',
        });
        if (!hasRenderableSparkline(graphRow)) {
          unavailableSymbols.push({
            symbol,
            reason: 'insufficient_points',
            retryable: true,
          });
          logger.info(
            { domain: 'market-routes', exchange: params.exchange, symbol, unavailable: true, reason: 'insufficient_points' },
            `[GraphAPI] exchange=${params.exchange} symbol=${symbol} unavailable=true reason=insufficient_points`,
          );
        }
        continue;
      }

      const fallbackCached = usableStaleFallbacks.get(symbol);
      if (fallbackCached) {
        rowsBySymbol.set(symbol, fallbackCached.row);
        cacheStaleCount += 1;
        staleFallbackCount += 1;
        staleReused = true;
        const fallbackReason = classifyGraphFallbackReason(load?.reason);
        markSparklineSymbolMeta({
          symbol,
          row: fallbackCached.row,
          source: 'stale_cache',
          generatedAt: fallbackCached.generatedAt,
          fallbackReason,
        });
        logger.info(
          {
            domain: 'market-routes',
            exchange: params.exchange,
            symbol,
            fallback: 'stale_cache',
            reason: fallbackReason,
          },
          `[GraphAPI] exchange=${params.exchange} symbol=${symbol} fallback=stale_cache reason=${fallbackReason}`,
        );
        continue;
      }

      const index = entry.itemIndexBySymbol.get(symbol);
      const item = index !== undefined ? entry.fullItems[index] : null;
      if (item) {
        const fallbackRow = buildMarketViewportRowFromSnapshotItem({
          exchange: params.exchange,
          item,
          representativeSymbols,
          includeSparkline: true,
          debug: Boolean(params.debug),
        });
        rowsBySymbol.set(symbol, fallbackRow);
        markSparklineSymbolMeta({
          symbol,
          row: fallbackRow,
          source: 'fresh_cache',
          fallbackReason: hasRenderableSparkline(fallbackRow) ? undefined : 'insufficient_points',
        });
        if (hasRenderableSparkline(fallbackRow)) {
          snapshotFastPathCount += 1;
        }
      } else {
        skippedSymbols.push({
          symbol,
          reason: load?.reason ?? 'missing_from_provider_snapshot',
        });
        markSparklineSymbolMeta({
          symbol,
          row: null,
          source: 'provider_fetch',
          fallbackReason: classifyGraphFallbackReason(load?.reason),
        });
      }

      unavailableSymbols.push({
        symbol,
        reason: load?.reason ?? 'insufficient_points',
        retryable: true,
      });
      logger.info(
        {
          domain: 'market-routes',
          exchange: params.exchange,
          symbol,
          unavailable: true,
          reason: item ? 'insufficient_points' : classifyGraphFallbackReason(load?.reason),
        },
        `[GraphAPI] exchange=${params.exchange} symbol=${symbol} unavailable=true reason=${item ? 'insufficient_points' : classifyGraphFallbackReason(load?.reason)}`,
      );
    }
  }

  const rows = normalizedSymbols
    .map((symbol) => rowsBySymbol.get(symbol))
    .filter((row): row is MarketViewportRow => Boolean(row));
  const decoratedRows = await decorateMarketViewportRows(rows);
  logAssetImageProjectionBatch('/market/sparkline', decoratedRows);
  const generatedAt = Date.now();
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'sparkline',
    rows: decoratedRows,
    requestedSymbolCount: normalizedSymbols.length,
    mappedSymbolCount: normalizedSymbols.length - unsupportedSymbols.length,
    skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused,
  }) as MarketSparklineResponse;

  const renderableSymbols = new Set(decoratedRows.filter((row) => hasRenderableSparkline(row)).map((row) => row.symbol));
  const missingSymbols = normalizedSymbols.filter((symbol) => !renderableSymbols.has(symbol));
  const usableSymbols = normalizedSymbols.filter((symbol) => symbolMetaBySymbol.get(symbol)?.usable);
  const symbolMeta = normalizedSymbols
    .map((symbol) => symbolMetaBySymbol.get(symbol))
    .filter((meta): meta is MarketSparklineSymbolMeta => Boolean(meta));
  const failedCount = normalized.rejectedSymbols.length + unsupportedSymbols.length + unavailableSymbols.length;
  const freshSourceCount = cacheHitCount + snapshotFastPathCount;
  const staleSourceCount = cacheStaleCount;
  const responseSource = summarizeSparklineResponseSource({
    freshSourceCount,
    staleSourceCount,
    providerFetchCount,
  });
  const freshness = summarizeSparklineFreshness({
    rows: decoratedRows,
    staleSourceCount,
    missingSymbolCount: missingSymbols.length,
  });
  const enrichedResponse: MarketSparklineResponse = {
    ...response,
    partial: response.partial || failedCount > 0,
    source: responseSource,
    freshness,
    generatedAt,
    missingSymbols,
    usableSymbols,
    usableStaleSymbols: Array.from(usableStaleSymbols),
    symbolMeta,
    requestedSymbols: normalizedSymbols,
    acceptedSymbols: rows.map((row) => row.symbol),
    rejectedSymbols: normalized.rejectedSymbols,
    unsupportedSymbols,
    unavailableSymbols,
    cache: {
      hit: cacheHitCount,
      miss: symbolsToHydrate.length,
      stale: cacheStaleCount,
      backgroundRefreshScheduled,
    },
    batch: {
      index: params.batchIndex ?? 0,
      requestedCount: normalized.requestedCount,
      success: rows.filter((row) => row.sparkline && row.sparkline.length >= 2).length,
      failed: failedCount,
    },
  };

  logMarketViewportResponse({
    exchange: params.exchange,
    requestKind: 'sparkline',
    requestedSymbolCount: normalizedSymbols.length,
    mappedSymbolCount: normalizedSymbols.length - unsupportedSymbols.length,
    skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    staleReused,
    response: enrichedResponse,
  });

  logger.info(
    {
      domain: 'market-routes',
      exchange: params.exchange,
      requestedCount: normalized.requestedCount,
      normalizedCount: normalizedSymbols.length,
      cacheHit: cacheHitCount,
      staleHit: cacheStaleCount,
      usableStale: usableStaleSymbols.size,
      freshSource: freshSourceCount,
      staleSource: staleSourceCount,
      fetch: symbolsToHydrate.length,
      providerFetch: providerFetchCount,
      staleFallback: staleFallbackCount,
      elapsedMs: firstPaintElapsedMs,
      batchIndex: params.batchIndex ?? 0,
      success: enrichedResponse.batch?.success ?? 0,
      failed: enrichedResponse.batch?.failed ?? 0,
      rejected: normalized.rejectedSymbols.length,
      unsupported: unsupportedSymbols.length,
      unavailable: unavailableSymbols.length,
      missingSymbols,
      source: responseSource,
      freshness,
      backgroundRefreshScheduled,
    },
    `[GraphAPI] exchange=${params.exchange} requestedCount=${normalized.requestedCount} usableStale=${usableStaleSymbols.size} freshHit=${freshSourceCount} fetch=${symbolsToHydrate.length}`,
  );

  return enrichedResponse;
}

export async function listMarkets(exchange?: ExchangeId): Promise<MarketUniverseResponse<MarketUniverseItem>> {
  const providers = exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();
  const binanceSymbolSet = await loadBinanceSymbolSet();
  const results = await Promise.allSettled(providers.map((provider) => buildProviderMarketUniverse(provider, binanceSymbolSet)));

  const items: MarketUniverseItem[] = [];
  const droppedSymbols: DroppedSymbolEntry[] = [];
  const resolvedExchanges: ExchangeId[] = [];
  let requestedMarketCount = 0;
  let providerMarketCount = 0;
  let normalizedSymbolCount = 0;
  let registryMappedCount = 0;
  let registryUnmappedCount = 0;

  for (const [index, result] of results.entries()) {
    const provider = providers[index];
    if (result.status === 'rejected') {
      logger.warn(
        { domain: 'market-routes', exchange: provider.exchange, capability: 'markets', err: result.reason },
        'Provider market universe request failed',
      );
      if (exchange) {
        throw new AppError(503, `${provider.exchange} market universe is temporarily unavailable`);
      }
      continue;
    }

    const bundle = result.value;
    resolvedExchanges.push(provider.exchange);
    requestedMarketCount += bundle.marketSymbols.length;
    providerMarketCount += bundle.marketSymbols.length;
    normalizedSymbolCount += bundle.marketSymbols.length;
    registryMappedCount += bundle.registryMappedCount;
    registryUnmappedCount += bundle.registryUnmappedCount;
    items.push(...bundle.items);

    logger.info(
      {
        domain: 'market-routes',
        endpoint: 'markets',
        operation: 'markets',
        exchange: provider.exchange,
        requestedMarketCount: bundle.marketSymbols.length,
        providerMarketCount: bundle.marketSymbols.length,
        normalizedSymbolCount: bundle.marketSymbols.length,
        returnedCount: bundle.items.length,
        registryMappedCount: bundle.registryMappedCount,
        registryUnmappedCount: bundle.registryUnmappedCount,
        droppedSymbols: [],
        droppedReasonsSummary: {},
        sourceOfTruth: 'provider_market_universe',
        appliedLimit: null,
        totalAvailableCount: bundle.items.length,
      },
      'Resolved market list request',
    );
  }

  if (resolvedExchanges.length === 0) {
    throw new AppError(503, 'market universe is temporarily unavailable');
  }

  const decoratedItems = await decorateMarketUniverseItems(items);

  return {
    items: decoratedItems,
    meta: createBaseMeta({
      exchanges: resolvedExchanges,
      requestedMarketCount,
      providerMarketCount,
      normalizedSymbolCount,
      returnedCount: decoratedItems.length,
      registryMappedCount,
      registryUnmappedCount,
      droppedSymbols,
      sourceOfTruth: 'provider_market_universe',
      appliedLimit: null,
      totalAvailableCount: decoratedItems.length,
    }),
  };
}

export async function getTickers(params: {
  exchange?: ExchangeId;
  symbol?: string;
  marketId?: string;
  limit?: number;
}): Promise<MarketUniverseResponse<MarketTickerItem>> {
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new AppError(400, 'limit must be a positive integer');
  }
  if (params.marketId && !params.exchange) {
    throw new AppError(400, 'exchange is required when marketId is provided');
  }

  const providers = params.exchange
    ? [exchangeProviderRegistry.getMarketDataProvider(params.exchange)]
    : exchangeProviderRegistry.listMarketDataProviders();
  const requestedSymbol = params.marketId ? null : params.symbol ? assertSupportedSymbol(params.symbol) : null;
  const requestedMarketId = params.marketId?.trim() ?? null;
  const binanceSymbolSet = await loadBinanceSymbolSet();
  const universeResults = await Promise.allSettled(providers.map((provider) => buildProviderMarketUniverse(provider, binanceSymbolSet)));

  const items: MarketTickerItem[] = [];
  const droppedSymbols: DroppedSymbolEntry[] = [];
  const resolvedExchanges: ExchangeId[] = [];
  let requestedMarketCount = 0;
  let providerMarketCount = 0;
  let normalizedSymbolCount = 0;
  let registryMappedCount = 0;
  let registryUnmappedCount = 0;

  for (const [index, universeResult] of universeResults.entries()) {
    const provider = providers[index];
    if (universeResult.status === 'rejected') {
      logger.warn(
        { domain: 'market-routes', exchange: provider.exchange, capability: 'markets', err: universeResult.reason },
        'Provider market universe lookup failed during ticker request',
      );
      if (params.exchange) {
        throw new AppError(503, `${provider.exchange} market universe is temporarily unavailable`);
      }
      continue;
    }

    const bundle = universeResult.value;
    let requestedSymbols = requestedSymbol ? [requestedSymbol] : bundle.marketSymbols;
    if (requestedMarketId) {
      const resolved = resolveExchangeMarketInput({
        exchange: provider.exchange,
        markets: bundle.items.map((item) => ({
          symbol: item.symbol,
          exchangeSymbol: item.exchangeSymbol,
          marketId: item.marketId,
          market: item.market,
          baseCurrency: item.baseCurrency,
          quoteCurrency: item.quoteCurrency,
          rawSymbol: item.rawSymbol,
          tradable: item.tradable,
        })),
        input: { marketId: requestedMarketId },
        capabilitiesBySymbol: new Map(bundle.items.map((item) => [item.symbol, item.capabilities])),
      });
      if (!resolved.ok) {
        if (params.exchange) {
          throw new AppError(400, `marketId ${requestedMarketId} is not listed on ${provider.exchange}`);
        }
        continue;
      }
      requestedSymbols = [resolved.metadata.canonicalSymbol];
    }

    let tickerLoads;
    try {
      tickerLoads = await getExchangeTickerLoads(provider.exchange, requestedSymbols);
    } catch (reason) {
      logger.warn(
        { domain: 'market-routes', exchange: provider.exchange, capability: 'ticker', err: reason },
        'Ticker snapshot resolution failed',
      );
      if (params.exchange) {
        throw new AppError(503, `${provider.exchange} market tickers are temporarily unavailable`);
      }
      continue;
    }

    requestedMarketCount += requestedSymbols.length;
    providerMarketCount += bundle.marketSymbols.length;
    normalizedSymbolCount += requestedSymbols.length;
    registryMappedCount += bundle.registryMappedCount;
    registryUnmappedCount += bundle.registryUnmappedCount;
    resolvedExchanges.push(provider.exchange);
    const marketItemMap = new Map(bundle.items.map((item) => [item.symbol, item]));
    const returnedSymbols: string[] = [];

    for (const symbol of requestedSymbols) {
      const market = marketItemMap.get(symbol);
      if (!market) {
        droppedSymbols.push({
          exchange: provider.exchange,
          symbol,
          reason: 'not_listed_on_exchange_market_universe',
        });
        continue;
      }

      const load = tickerLoads.get(symbol);
      if (!load?.ticker) {
        droppedSymbols.push({
          exchange: provider.exchange,
          symbol,
          reason: load?.reason ?? 'missing_from_provider_snapshot',
        });
        continue;
      }

      returnedSymbols.push(symbol);
      items.push({
        ...withTickerCompletenessFromSource(load.ticker, resolveTickerDataMode(load.source)),
        exchangeName: market.exchangeName,
        marketId: market.marketId,
        canonicalMarketId: market.canonicalMarketId,
        canonicalSymbol: market.canonicalSymbol,
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        displaySymbol: market.displaySymbol,
        koreanName: market.koreanName,
        englishName: market.englishName,
        iconUrl: market.iconUrl,
        isActive: market.isActive,
        candlesSupported: market.candlesSupported,
        graphSupported: market.graphSupported,
        supportedIntervals: [...market.supportedIntervals],
        unsupportedReason: market.unsupportedReason,
        canonicalAssetKey: market.canonicalAssetKey,
        exchangeSymbol: market.exchangeSymbol,
        tradable: market.tradable,
        capabilities: market.capabilities,
        isChartAvailable: market.isChartAvailable,
        isOrderBookAvailable: market.isOrderBookAvailable,
        isTradesAvailable: market.isTradesAvailable,
        unavailableReason: market.unavailableReason,
        kimchiComparable: market.kimchiComparable,
        kimchiComparisonReason: market.kimchiComparisonReason,
        nameKo: market.nameKo,
        nameEn: market.nameEn,
        registryMapped: market.registryMapped,
        assetSupportStatus: market.assetSupportStatus,
        imageUrl: null,
        imageURL: null,
        hasImage: false,
        assetImageUrl: null,
        imageAvailability: 'pending',
        imageFailureReason: null,
        imageMissingReason: null,
        fallbackType: null,
        assetType: null,
        canonicalName: null,
        fallbackColor: null,
        fallbackInitials: null,
        assetSlug: market.assetSlug ?? null,
        imageFallbackKey: market.imageFallbackKey ?? resolveStableAssetFallbackKey({
          exchange: provider.exchange,
          symbol: market.symbol,
          rawSymbol: market.rawSymbol,
          marketId: market.marketId,
          canonicalAssetKey: market.canonicalAssetKey,
          assetSlug: market.assetSlug ?? null,
        }),
        fallbackKey: market.fallbackKey ?? market.imageFallbackKey ?? resolveStableAssetFallbackKey({
          exchange: provider.exchange,
          symbol: market.symbol,
          rawSymbol: market.rawSymbol,
          marketId: market.marketId,
          canonicalAssetKey: market.canonicalAssetKey,
          assetSlug: market.assetSlug ?? null,
        }),
        stableImageKey: market.stableImageKey ?? market.imageFallbackKey ?? resolveStableAssetFallbackKey({
          exchange: provider.exchange,
          symbol: market.symbol,
          rawSymbol: market.rawSymbol,
          marketId: market.marketId,
          canonicalAssetKey: market.canonicalAssetKey,
          assetSlug: market.assetSlug ?? null,
        }),
        imageLookupKey: market.imageLookupKey ?? market.imageFallbackKey ?? resolveStableAssetFallbackKey({
          exchange: provider.exchange,
          symbol: market.symbol,
          rawSymbol: market.rawSymbol,
          marketId: market.marketId,
          canonicalAssetKey: market.canonicalAssetKey,
          assetSlug: market.assetSlug ?? null,
        }),
      });
    }

    const providerDroppedSymbols = droppedSymbols.filter((item) => item.exchange === provider.exchange);
    logger.info(
      {
        domain: 'market-routes',
        endpoint: 'tickers',
        operation: 'tickers',
        exchange: provider.exchange,
        requestedMarketCount: requestedSymbols.length,
        providerMarketCount: bundle.marketSymbols.length,
        normalizedSymbolCount: requestedSymbols.length,
        returnedCount: returnedSymbols.length,
        registryMappedCount: bundle.registryMappedCount,
        registryUnmappedCount: bundle.registryUnmappedCount,
        droppedSymbols: providerDroppedSymbols.map((item) => ({ symbol: item.symbol, reason: item.reason })),
        droppedReasonsSummary: summarizeDroppedReasons(providerDroppedSymbols),
        sourceOfTruth: 'provider_market_universe',
        appliedLimit: null,
        totalAvailableCount: bundle.marketSymbols.length,
        returnedSymbols,
        fieldCoverage: summarizeTickerFieldCoverage(
          items.filter((item) => item.exchange === provider.exchange && returnedSymbols.includes(item.symbol)),
        ),
        dataModes: summarizeTickerDataModes(
          items.filter((item) => item.exchange === provider.exchange && returnedSymbols.includes(item.symbol)),
        ),
      },
      'Resolved market ticker request',
    );
  }

  if (resolvedExchanges.length === 0) {
    throw new AppError(503, 'market tickers are temporarily unavailable');
  }

  type AssetPreloadLookup = {
    exchange?: ExchangeId;
    symbol?: string;
    exchangeSymbol?: string | null;
    canonicalAssetKey?: string | null;
  };
  const toAssetLookup = (item: MarketTickerItem): AssetPreloadLookup => ({
    exchange: item.exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    canonicalAssetKey: item.canonicalAssetKey,
  });
  const firstPageVisibleLookups = items.slice(0, FIRST_PAGE_VISIBLE_SYMBOL_LIMIT).map(toAssetLookup);
  const topVolumeLookups = items
    .slice()
    .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
    .slice(0, TOP_VOLUME_SYMBOL_PRELOAD_LIMIT)
    .map(toAssetLookup);
  const topVolumeLookupsByExchange = Array.from(
    items.reduce<Map<ExchangeId, MarketTickerItem[]>>((grouped, item) => {
      const bucket = grouped.get(item.exchange) ?? [];
      bucket.push(item);
      grouped.set(item.exchange, bucket);
      return grouped;
    }, new Map<ExchangeId, MarketTickerItem[]>()),
  ).flatMap(([, exchangeItems]) =>
    exchangeItems
      .slice()
      .sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
      .slice(0, FIRST_PAGE_VISIBLE_SYMBOL_LIMIT)
      .map(toAssetLookup));
  const pinnedAssetLookups: AssetPreloadLookup[] = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'USDT', 'USDC', 'BNB', 'TRX'].map((symbol) => ({
    symbol,
    canonicalAssetKey: symbol,
  }));
  const likelyVisibleLookups = Array.from(
    [...firstPageVisibleLookups, ...topVolumeLookups, ...topVolumeLookupsByExchange, ...pinnedAssetLookups]
      .reduce<Map<string, AssetPreloadLookup>>((deduped, lookup) => {
        const key = `${lookup.exchange ?? 'global'}:${lookup.canonicalAssetKey ?? lookup.symbol ?? lookup.exchangeSymbol ?? ''}`;
        deduped.set(key, lookup);
        return deduped;
      }, new Map())
      .values(),
  );
  assetMetadataService.preloadAssetLookups(likelyVisibleLookups, 'priority');

  const decoratedItems = await decorateMarketTickerItems(items);
  const limited = applyUniverseLimit(decoratedItems, params.limit);
  logAssetImageCoverageSummary({
    route: '/market/tickers',
    exchange: 'all',
    scope: 'response',
    items: limited.items.map((item) => ({
      assetImageUrl: item.assetImageUrl,
      reason: item.hasImage
        ? null
        : item.imageMissingReason
          ? item.imageMissingReason
        : item.canonicalAssetKey
          ? toAssetImageProjectionReason({
            canonicalAssetKey: item.canonicalAssetKey,
            failureReason: item.imageFailureReason,
          })
          : 'canonical_key_missing',
    })),
  });
  return {
    items: limited.items,
    meta: {
      ...createBaseMeta({
        exchanges: resolvedExchanges,
        requestedMarketCount,
        providerMarketCount,
        normalizedSymbolCount,
        returnedCount: limited.items.length,
        registryMappedCount,
        registryUnmappedCount,
        droppedSymbols,
        sourceOfTruth: 'provider_market_universe',
        appliedLimit: limited.appliedLimit,
        totalAvailableCount: decoratedItems.length,
      }),
      fieldCoverage: summarizeTickerFieldCoverage(limited.items),
      dataModes: summarizeTickerDataModes(limited.items),
    },
  };
}

export async function getMarketSnapshot(params: {
  exchange: ExchangeId;
  symbols?: string[];
  scope?: MarketSnapshotScope;
  limit?: number;
}): Promise<MarketSnapshotResponse> {
  const normalizedSymbols = Array.from(new Set((params.symbols ?? []).map(toCanonicalSymbol).filter(Boolean)));
  if (params.symbols && normalizedSymbols.length === 0) {
    throw new AppError(400, 'symbols must contain at least one canonical symbol');
  }

  const scope: MarketSnapshotScope = normalizedSymbols.length > 0 ? 'symbols' : params.scope ?? 'top';
  if (scope === 'symbols') {
    const entry = await ensureCachedExchangeMarketSnapshot(params.exchange);
    if (!entry) {
      return buildUnavailableMarketSnapshotResponse({
        exchange: params.exchange,
        scope,
        requestedSymbols: normalizedSymbols,
      });
    }

    const filtered = filterSnapshotItemsForSymbols(entry, normalizedSymbols);
    const scopedItems = await decorateMarketSnapshotItems(orderSnapshotItemsForScope(filtered.items, scope)
      .map((item) => projectSnapshotItemForScope(item, scope)));
    logAssetImageProjectionBatch('/market/snapshot', scopedItems);
    const response = buildMarketSnapshotResponse({
      exchange: params.exchange,
      scope,
      requestedSymbols: normalizedSymbols,
      items: scopedItems,
      partialFailures: filtered.partialFailures,
      listedCount: entry.listedCount,
      excludedUnlistedCount: filtered.excludedUnlistedCount,
    });
    logger.info(
      {
        domain: 'market-routes',
        endpoint: 'snapshot',
        exchange: params.exchange,
        scope,
        requestedSymbols: normalizedSymbols,
        responseItemCount: response.items.length,
        listedCount: response.listedCount,
        excludedUnlistedSymbolCount: response.excludedUnlistedCount,
        staleItemCount: response.staleItemCount,
        pendingItemCount: response.pendingItemCount,
        kimchiComparableCount: response.items.filter((item) => item.kimchiComparable).length,
      },
      'Resolved market snapshot response',
    );
    return response;
  }

  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const entry = await ensureCachedExchangeMarketSnapshot(params.exchange);
  if (!entry) {
    return buildUnavailableMarketSnapshotResponse({
      exchange: params.exchange,
      scope,
      requestedSymbols: [],
    });
  }

  if (Date.now() - entry.lastRefreshedAt > MARKET_SNAPSHOT_HARD_STALE_AFTER_MS) {
    void refreshExchangeMarketSnapshotCache(params.exchange, {
      allowProviderFetch: true,
      forceUniverseRefresh: true,
    });
  }

  const defaultLimit =
    scope === 'top'
      ? DEFAULT_TOP_SNAPSHOT_LIMIT
      : scope === 'visible'
        ? DEFAULT_VISIBLE_SNAPSHOT_LIMIT
        : entry.fullItems.length;
  const appliedLimit = params.limit ?? defaultLimit;
  const orderedItems = orderSnapshotItemsForScope(entry.fullItems, scope);
  const items = await decorateMarketSnapshotItems(orderedItems
    .slice(0, Math.max(appliedLimit, 0))
    .map((item) => projectSnapshotItemForScope(item, scope)));
  logAssetImageProjectionBatch('/market/snapshot', items);
  const partialFailures = entry.partialFailures.filter((failure) =>
    items.some((item) => item.symbol === failure.symbol),
  );

  const response = buildMarketSnapshotResponse({
    exchange: params.exchange,
    scope,
    requestedSymbols: [],
    items,
    partialFailures,
    listedCount: entry.listedCount,
    excludedUnlistedCount: 0,
  });
  logger.info(
    {
      domain: 'market-routes',
      endpoint: 'snapshot',
      exchange: params.exchange,
      scope,
      responseItemCount: response.items.length,
      listedCount: response.listedCount,
      excludedUnlistedSymbolCount: response.excludedUnlistedCount,
      staleItemCount: response.staleItemCount,
      pendingItemCount: response.pendingItemCount,
      kimchiComparableCount: response.items.filter((item) => item.kimchiComparable).length,
    },
    'Resolved market snapshot response',
  );
  return response;
}

export async function listSymbolSupport(exchange: ExchangeId): Promise<{
  exchange: ExchangeId;
  quoteCurrency: 'KRW' | 'USDT';
  baseExchange: 'binance';
  items: MarketSymbolSupportEntry[];
  total: number;
}> {
  const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
  const binanceSymbolSet = await loadBinanceSymbolSet();
  const bundle = await buildProviderMarketUniverse(provider, binanceSymbolSet);
  const decoratedItems = await decorateMarketUniverseItems(bundle.items);
  const items = decoratedItems.map<MarketSymbolSupportEntry>((item) => ({
    exchange,
    marketId: item.marketId,
    canonicalMarketId: item.canonicalMarketId,
    rawSymbol: item.rawSymbol,
    canonicalSymbol: item.canonicalSymbol,
    baseAsset: item.baseAsset,
    quoteAsset: item.quoteAsset,
    displaySymbol: item.displaySymbol,
    koreanName: item.koreanName,
    englishName: item.englishName,
    iconUrl: item.iconUrl,
    isActive: item.isActive,
    capabilities: item.capabilities,
    candlesSupported: item.candlesSupported,
    graphSupported: item.graphSupported,
    supportedIntervals: [...item.supportedIntervals],
    unsupportedReason: item.unsupportedReason,
    symbol: item.symbol,
    canonicalAssetKey: item.canonicalAssetKey,
    assetImageUrl: item.assetImageUrl ?? null,
    imageAvailability: item.imageAvailability,
    imageFailureReason: item.imageFailureReason ?? null,
    imageMissingReason: item.imageMissingReason ?? null,
    fallbackType: item.fallbackType ?? null,
    assetType: item.assetType ?? null,
    canonicalName: item.canonicalName ?? null,
    fallbackColor: item.fallbackColor ?? null,
    fallbackInitials: item.fallbackInitials ?? null,
    assetSlug: item.assetSlug ?? null,
    imageFallbackKey: item.imageFallbackKey ?? null,
    fallbackKey: item.fallbackKey ?? item.imageFallbackKey ?? null,
    stableImageKey: item.stableImageKey ?? item.imageFallbackKey ?? null,
    imageLookupKey: item.imageLookupKey ?? item.imageFallbackKey ?? null,
    assetSupportStatus: item.assetSupportStatus,
    exchangeSymbol: item.exchangeSymbol,
    market: item.market,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency,
    tradable: item.tradable,
    kimchiComparable: item.kimchiComparable,
    kimchiComparisonReason: item.kimchiComparisonReason,
  }));

  logger.info(
    {
      domain: 'market-routes',
      endpoint: 'symbols',
      operation: 'symbols',
      exchange,
      requestedMarketCount: bundle.marketSymbols.length,
      providerMarketCount: bundle.marketSymbols.length,
      normalizedSymbolCount: bundle.marketSymbols.length,
      returnedCount: items.length,
      registryMappedCount: bundle.registryMappedCount,
      registryUnmappedCount: bundle.registryUnmappedCount,
      droppedSymbols: [],
      droppedReasonsSummary: {},
      sourceOfTruth: 'provider_market_universe',
      totalAvailableCount: items.length,
      kimchiComparableSymbols: items.filter((item) => item.kimchiComparable).map((item) => item.symbol),
    },
    'Resolved market symbol support request',
  );

  return {
    exchange,
    quoteCurrency: provider.metadata.quoteCurrency,
    baseExchange: 'binance',
    items,
    total: items.length,
  };
}

function buildExchangeAssetCoverageAuditItemWithPriority(
  item: MarketUniverseItem,
  priority: {
    exposurePriority: number;
    exposureRank: number | null;
    representative: boolean;
    visible: boolean;
    volumeRank: number | null;
  },
): ExchangeAssetCoverageAuditItem {
  const resolution = resolveCanonicalAssetImageKey({
    exchange: item.exchange,
    symbol: item.symbol,
    exchangeSymbol: item.exchangeSymbol,
    rawSymbol: item.rawSymbol,
  });
  const fallbackKey = item.fallbackKey ?? item.imageFallbackKey ?? resolveStableAssetFallbackKey({
    exchange: item.exchange,
    symbol: item.symbol,
    rawSymbol: item.rawSymbol,
    marketId: item.marketId,
    canonicalAssetKey: item.canonicalAssetKey,
    assetSlug: item.assetSlug ?? null,
  });
  const diagnosticReasons = new Set<AssetCoverageAuditReason>();

  if (item.imageFailureReason === 'alias_not_found' || item.imageMissingReason === 'alias_miss') {
    diagnosticReasons.add('alias_missing');
  }
  if (!item.canonicalAssetKey) {
    diagnosticReasons.add('canonical_missing');
    diagnosticReasons.add('unsupported_asset');
  }
  if (item.canonicalAssetKey && !item.assetSlug) {
    diagnosticReasons.add('asset_slug_missing');
  }
  if (!item.assetImageUrl) {
    diagnosticReasons.add('image_url_missing');
  }
  if (item.assetSupportStatus === 'unsupported' || item.imageMissingReason === 'unsupported_asset') {
    diagnosticReasons.add('unsupported_asset');
  }

  return {
    exchange: item.exchange,
    marketId: item.marketId,
    rawSymbol: item.rawSymbol,
    normalizedSymbol: item.symbol,
    canonicalSymbol: item.canonicalSymbol,
    canonicalAssetKey: item.canonicalAssetKey,
    assetSlug: item.assetSlug ?? null,
    preferredImageSymbol: item.preferredImageSymbol ?? null,
    preferredImageSlug: item.preferredImageSlug ?? null,
    imageUrl: item.assetImageUrl ?? null,
    fallbackKey,
    stableAssetKey: fallbackKey,
    imageAvailability: item.imageAvailability ?? (item.assetImageUrl ? 'available' : item.canonicalAssetKey ? 'pending' : 'unavailable'),
    imageFailureReason: item.imageFailureReason ?? null,
    imageMissingReason: item.imageMissingReason ?? null,
    imageResolutionSource: item.imageResolutionSource ?? null,
    resolutionStage: item.resolutionStage ?? null,
    assetSupportStatus: item.assetSupportStatus,
    registryMapped: item.registryMapped,
    aliasHit: resolution.aliasHit,
    matchedBy: resolution.matchedBy,
    diagnosticReasons: Array.from(diagnosticReasons),
    exposurePriority: priority.exposurePriority,
    exposureRank: priority.exposureRank,
    representative: priority.representative,
    visible: priority.visible,
    volumeRank: priority.volumeRank,
    manualCurationRecommended: item.manualCurationRecommended ?? false,
    fallbackOnly: item.fallbackOnly ?? false,
  };
}

function buildExchangeAuditPriorityContext(exchange: ExchangeId, snapshot: ExchangeMarketSnapshotCacheEntry | null) {
  const representativeSymbols = new Set(
    snapshot
      ? getRepresentativeSymbolsForExchange(snapshot.bundle.marketSymbols, exchange)
      : [],
  );
  const visibleSymbols = new Set(
    snapshot
      ? buildViewportCandidateItems({
        entry: snapshot,
        exchange,
        tab: 'all',
        sort: 'volume',
      })
        .slice(0, DEFAULT_VISIBLE_SNAPSHOT_LIMIT)
        .map((item) => item.symbol)
      : [],
  );
  const overviewSymbols = new Set(
    snapshot
      ? buildOverviewCandidateSymbols(snapshot, exchange, DEFAULT_VISIBLE_SNAPSHOT_LIMIT)
      : [],
  );
  const priorityOrdered = snapshot
    ? [...snapshot.fullItems].sort((left, right) => comparePrioritySnapshotItems(left, right))
    : [];
  const volumeOrdered = snapshot
    ? [...snapshot.fullItems].sort((left, right) => (right.volume24h ?? 0) - (left.volume24h ?? 0))
    : [];

  return {
    representativeSymbols,
    visibleSymbols,
    overviewSymbols,
    exposureRankBySymbol: new Map(priorityOrdered.map((item, index) => [item.symbol, index + 1])),
    volumeRankBySymbol: new Map(volumeOrdered.map((item, index) => [item.symbol, index + 1])),
  };
}

function computeExchangeAuditPriority(
  item: MarketUniverseItem,
  context: ReturnType<typeof buildExchangeAuditPriorityContext>,
) {
  const representative = context.representativeSymbols.has(item.symbol);
  const visible = context.visibleSymbols.has(item.symbol) || context.overviewSymbols.has(item.symbol);
  const exposureRank = context.exposureRankBySymbol.get(item.symbol) ?? null;
  const volumeRank = context.volumeRankBySymbol.get(item.symbol) ?? null;

  let exposurePriority = 0;
  if (representative) {
    exposurePriority += 10_000 - Math.min(getRepresentativeMarketSymbolRank(item.symbol, item.exchange), 100) * 50;
  }
  if (visible) {
    exposurePriority += 4_000;
  }
  if (exposureRank !== null) {
    exposurePriority += Math.max(0, 2_000 - exposureRank * 20);
  }
  if (volumeRank !== null) {
    exposurePriority += Math.max(0, 1_500 - volumeRank * 10);
  }
  if (item.imageMissingReason === 'alias_miss') {
    exposurePriority += 250;
  }
  if (item.imageMissingReason?.startsWith('curated_slug_resolved_but_')) {
    exposurePriority += 400;
  }
  if (item.manualCurationRecommended) {
    exposurePriority += 100;
  }

  return {
    exposurePriority,
    exposureRank,
    representative,
    visible,
    volumeRank,
  };
}

function buildExchangeAssetCoverageAuditDetail(
  exchange: ExchangeId,
  items: ExchangeAssetCoverageAuditItem[],
  summary: ExchangeAssetCoverageAuditSummary,
): ExchangeAssetCoverageAuditDetail {
  const byPriority = (left: ExchangeAssetCoverageAuditItem, right: ExchangeAssetCoverageAuditItem) =>
    right.exposurePriority - left.exposurePriority
      || (left.exposureRank ?? Number.MAX_SAFE_INTEGER) - (right.exposureRank ?? Number.MAX_SAFE_INTEGER)
      || left.normalizedSymbol.localeCompare(right.normalizedSymbol);
  const missingImageItems = items.filter((item) => item.diagnosticReasons.includes('image_url_missing')).sort(byPriority);
  const aliasMissingItems = items.filter((item) => item.diagnosticReasons.includes('alias_missing')).sort(byPriority);
  const manualCurationRecommended = missingImageItems.filter((item) => item.manualCurationRecommended);
  const fallbackOnlyRetained = missingImageItems.filter((item) => item.fallbackOnly);
  const curatedResolvedButNotPromoted = missingImageItems.filter((item) =>
    item.imageMissingReason === 'curated_slug_resolved_but_metadata_missing'
    || item.imageMissingReason === 'curated_slug_resolved_but_cache_stale'
    || item.imageMissingReason === 'curated_slug_resolved_but_projection_not_promoted'
    || item.imageMissingReason === 'curated_slug_resolved_but_source_merge_failed');
  const cacheStaleSuspects = missingImageItems.filter((item) =>
    item.imageMissingReason === 'curated_slug_resolved_but_cache_stale');
  const sourceMetadataMissing = missingImageItems.filter((item) =>
    item.imageMissingReason === 'curated_slug_resolved_but_metadata_missing'
    || item.imageMissingReason === 'source_metadata_absent');

  return {
    exchange,
    summary,
    imageUrlMissingSymbols: missingImageItems,
    aliasMissingSymbols: aliasMissingItems,
    priorityRankedMissingImageCandidates: missingImageItems.slice(0, 40),
    manualCurationRecommended,
    fallbackOnlyRetained,
    curatedResolvedButNotPromoted,
    cacheStaleSuspects,
    sourceMetadataMissing,
  };
}

function summarizeExchangeAssetCoverageAudit(
  exchange: ExchangeId,
  items: ExchangeAssetCoverageAuditItem[],
): ExchangeAssetCoverageAuditSummary {
  return items.reduce<ExchangeAssetCoverageAuditSummary>(
    (summary, item) => {
      summary.totalAssets += 1;
      summary.registryMappedCount += item.registryMapped ? 1 : 0;
      summary.canonicalMappedCount += item.canonicalAssetKey ? 1 : 0;
      summary.imageUrlAvailableCount += item.imageUrl ? 1 : 0;
      summary.fallbackKeyAvailableCount += item.fallbackKey ? 1 : 0;
      summary.unsupportedCount += item.diagnosticReasons.includes('unsupported_asset') ? 1 : 0;
      summary.aliasMissingCount += item.diagnosticReasons.includes('alias_missing') ? 1 : 0;
      summary.canonicalMissingCount += item.diagnosticReasons.includes('canonical_missing') ? 1 : 0;
      summary.assetSlugMissingCount += item.diagnosticReasons.includes('asset_slug_missing') ? 1 : 0;
      summary.imageUrlMissingCount += item.diagnosticReasons.includes('image_url_missing') ? 1 : 0;
      return summary;
    },
    {
      exchange,
      totalAssets: 0,
      registryMappedCount: 0,
      canonicalMappedCount: 0,
      imageUrlAvailableCount: 0,
      fallbackKeyAvailableCount: 0,
      unsupportedCount: 0,
      aliasMissingCount: 0,
      canonicalMissingCount: 0,
      assetSlugMissingCount: 0,
      imageUrlMissingCount: 0,
    },
  );
}

function summarizeMergedAssetCoverageAudit(
  items: ExchangeAssetCoverageAuditSummary[],
): Omit<ExchangeAssetCoverageAuditSummary, 'exchange'> {
  return items.reduce<Omit<ExchangeAssetCoverageAuditSummary, 'exchange'>>(
    (summary, item) => ({
      totalAssets: summary.totalAssets + item.totalAssets,
      registryMappedCount: summary.registryMappedCount + item.registryMappedCount,
      canonicalMappedCount: summary.canonicalMappedCount + item.canonicalMappedCount,
      imageUrlAvailableCount: summary.imageUrlAvailableCount + item.imageUrlAvailableCount,
      fallbackKeyAvailableCount: summary.fallbackKeyAvailableCount + item.fallbackKeyAvailableCount,
      unsupportedCount: summary.unsupportedCount + item.unsupportedCount,
      aliasMissingCount: summary.aliasMissingCount + item.aliasMissingCount,
      canonicalMissingCount: summary.canonicalMissingCount + item.canonicalMissingCount,
      assetSlugMissingCount: summary.assetSlugMissingCount + item.assetSlugMissingCount,
      imageUrlMissingCount: summary.imageUrlMissingCount + item.imageUrlMissingCount,
    }),
    {
      totalAssets: 0,
      registryMappedCount: 0,
      canonicalMappedCount: 0,
      imageUrlAvailableCount: 0,
      fallbackKeyAvailableCount: 0,
      unsupportedCount: 0,
      aliasMissingCount: 0,
      canonicalMissingCount: 0,
      assetSlugMissingCount: 0,
      imageUrlMissingCount: 0,
    },
  );
}

function logExchangeAssetCoverageAudit(entry: ExchangeAssetCoverageAuditEntry) {
  logger.info(
    {
      domain: 'asset-image',
      action: 'exchange_coverage_audit',
      generatedAt: entry.generatedAt,
      ...entry.summary,
    },
    `[AssetImageDebug] action=exchange_coverage_audit exchange=${entry.summary.exchange} total=${entry.summary.totalAssets} canonicalMapped=${entry.summary.canonicalMappedCount} imageUrlAvailable=${entry.summary.imageUrlAvailableCount} fallbackKeyAvailable=${entry.summary.fallbackKeyAvailableCount}`,
  );
}

async function loadExchangeAssetCoverageAudit(
  exchange: ExchangeId,
  binanceSymbolSet: Set<string>,
  refresh?: boolean,
): Promise<ExchangeAssetCoverageAuditEntry> {
  const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
  const bundle = await buildProviderMarketUniverse(provider, binanceSymbolSet);
  const decoratedItems = await decorateMarketUniverseItems(bundle.items, {
    eagerAssetMetadata: refresh,
  });
  const snapshot = await ensureCachedExchangeMarketSnapshot(exchange);
  const priorityContext = buildExchangeAuditPriorityContext(exchange, snapshot);
  const items = decoratedItems.map((item) => buildExchangeAssetCoverageAuditItemWithPriority(
    item,
    computeExchangeAuditPriority(item, priorityContext),
  ));
  const entry = {
    generatedAt: Date.now(),
    items,
    summary: summarizeExchangeAssetCoverageAudit(exchange, items),
  };
  logExchangeAssetCoverageAudit(entry);
  return entry;
}

async function ensureExchangeAssetCoverageAudit(
  exchange: ExchangeId,
  params: {
    refresh?: boolean;
    binanceSymbolSet: Set<string>;
  },
): Promise<{ entry: ExchangeAssetCoverageAuditEntry; cached: boolean }> {
  const cachedEntry = exchangeAssetCoverageAuditCache.get(exchange);
  if (!params.refresh && cachedEntry && (Date.now() - cachedEntry.generatedAt) < ASSET_COVERAGE_AUDIT_TTL_MS) {
    return { entry: cachedEntry, cached: true };
  }

  const existing = exchangeAssetCoverageAuditInFlight.get(exchange);
  if (existing) {
    return { entry: await existing, cached: false };
  }

  const pending = loadExchangeAssetCoverageAudit(exchange, params.binanceSymbolSet, params.refresh)
    .then((entry) => {
      exchangeAssetCoverageAuditCache.set(exchange, entry);
      return entry;
    })
    .finally(() => {
      exchangeAssetCoverageAuditInFlight.delete(exchange);
    });
  exchangeAssetCoverageAuditInFlight.set(exchange, pending);
  return { entry: await pending, cached: false };
}

export async function getAssetCoverageAudit(params?: {
  exchange?: ExchangeId;
  refresh?: boolean;
}): Promise<AssetCoverageAuditResponse> {
  const exchanges: ExchangeId[] = params?.exchange ? [params.exchange] : [...EXCHANGE_IDS];
  const binanceSymbolSet = await loadBinanceSymbolSet();
  const results = await Promise.all(exchanges.map((exchange) =>
    ensureExchangeAssetCoverageAudit(exchange, {
      refresh: params?.refresh ?? false,
      binanceSymbolSet,
    })));
  const summaries = results.map((result) => result.entry.summary);
  const details = results.map((result) =>
    buildExchangeAssetCoverageAuditDetail(result.entry.summary.exchange, result.entry.items, result.entry.summary));
  const generatedAt = results.length > 0
    ? Math.min(...results.map((result) => result.entry.generatedAt))
    : null;

  return {
    generatedAt,
    cacheAgeMs: generatedAt ? Math.max(Date.now() - generatedAt, 0) : null,
    cached: results.every((result) => result.cached),
    exchanges,
    summary: summaries,
    totals: summarizeMergedAssetCoverageAudit(summaries),
    items: results.flatMap((result) => result.entry.items),
    details,
  };
}

export async function listComparableKimchiSymbols(params: {
  exchange: ExchangeId;
  limit?: number;
  cursor?: string;
}): Promise<{
  exchange: ExchangeId;
  items: ComparableKimchiSymbolItem[];
  total: number;
  asOf: number | null;
  freshnessMs: number | null;
  page?: CursorPage;
}> {
  if (!EXCHANGE_IDS.includes(params.exchange) || params.exchange === 'binance') {
    throw new AppError(400, 'domestic exchange is required for kimchi comparable symbols');
  }

  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const limit = params.limit ?? DEFAULT_COMPARABLE_KIMCHI_SYMBOL_LIMIT;
  const offset = parseCursorOffset(params.cursor);
  const snapshot = await ensureViewportExchangeMarketSnapshot(params.exchange);
  if (!snapshot) {
    return {
      exchange: params.exchange,
      items: [],
      total: 0,
      asOf: null,
      freshnessMs: null,
      page: buildCursorPage(offset, limit, 0),
    };
  }

  const comparableItems = snapshot.comparableKimchiItems;
  const pagedItems = await decorateComparableKimchiItems(params.exchange, comparableItems.slice(offset, offset + limit));
  logAssetImageProjectionBatch('/kimchi-premium/comparable-symbols', pagedItems);

  logger.info(
    {
      domain: 'kimchi-premium',
      endpoint: 'comparable-symbols',
      exchange: params.exchange,
      comparableSymbolCount: comparableItems.length,
      responseItemCount: pagedItems.length,
      asOf: snapshot.asOf,
      freshnessMs: snapshot.freshnessMs,
    },
    'Resolved kimchi comparable symbols',
  );

  return {
    exchange: params.exchange,
    items: pagedItems.map((item) => ({ ...item })),
    total: comparableItems.length,
    asOf: snapshot.asOf,
    freshnessMs: snapshot.freshnessMs,
    page: buildCursorPage(offset, limit, comparableItems.length),
  };
}

export async function getComparableKimchiSymbolSet(exchange: ExchangeId): Promise<Set<string>> {
  if (!EXCHANGE_IDS.includes(exchange) || exchange === 'binance') {
    throw new AppError(400, 'domestic exchange is required for kimchi comparable symbols');
  }

  const snapshot = await ensureViewportExchangeMarketSnapshot(exchange);
  return snapshot ? new Set(snapshot.comparableKimchiSymbolSet) : new Set<string>();
}

export async function getOrderbook(
  exchange: ExchangeId,
  request: MarketLookupRequest,
): Promise<FreshMarketData<CanonicalOrderbookSnapshot> & { metadata: MarketResponseMetadata }> {
  const resolved = await resolveMarketForRequest(exchange, request, 'orderbook');
  const marketSymbol = resolved.market.symbol;
  if (!resolved.metadata.capabilities.supportsOrderBook) {
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'orderbook',
      exchange,
      metadata: resolved.metadata,
      reason: 'orderbook_not_supported',
      retryable: false,
    });
  }

  try {
    const orderbook = await resolved.provider.getOrderbookSnapshot(marketSymbol);
    const enriched = applyMetadataToCanonicalMarket(orderbook, resolved.metadata);
    return {
      ...withFreshness(enriched, orderbook.timestamp, 'snapshot'),
      metadata: resolved.responseMetadata,
    };
  } catch (error) {
    logger.warn(
      {
        domain: 'market-routes',
        exchange,
        marketId: resolved.metadata.marketId,
        symbol: marketSymbol,
        capability: 'orderbook',
        err: error,
      },
      'Falling back to cached orderbook data',
    );
    const cached = publicMarketDataStore.getOrderbook(exchange, marketSymbol);
    if (cached) {
      const snapshot = fromCachedOrderbook(cached);
      const enriched = applyMetadataToCanonicalMarket(snapshot, resolved.metadata);
      return {
        ...withFreshness(enriched, snapshot.timestamp, 'cached_snapshot'),
        metadata: buildAvailability(resolved.metadata, {
          target: 'orderbook',
          reason: error instanceof Error ? error.message : String(error),
        }),
      };
    }
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'orderbook',
      exchange,
      metadata: resolved.metadata,
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }
}

export async function getTradesWithMeta(
  exchange: ExchangeId,
  request: MarketLookupRequest,
  limit?: number,
): Promise<MarketTradesResponse> {
  const resolved = await resolveMarketForRequest(exchange, request, 'trades');
  const marketSymbol = resolved.market.symbol;
  if (!resolved.metadata.capabilities.supportsTrades) {
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'trades',
      exchange,
      metadata: resolved.metadata,
      reason: 'trades_not_supported',
      retryable: false,
    });
  }

  try {
    const trades = await resolved.provider.getRecentTrades(marketSymbol, limit);
    if (trades.length > 0) {
      const normalizedTrades = trades.map((item) =>
        withFreshness(applyMetadataToCanonicalMarket(item, resolved.metadata), item.timestamp, 'snapshot'));
      const distinctTimestamps = new Set(
        normalizedTrades
          .map((item) => item.timestamp)
          .filter((timestamp): timestamp is number => timestamp !== null),
      ).size;
      logger.info(
        {
          domain: 'market-routes',
          exchange,
          marketId: resolved.metadata.marketId,
          symbol: marketSymbol,
          tradeCount: normalizedTrades.length,
          invalidTimestampCount: normalizedTrades.filter((item) => item.timestamp === null).length,
          distinctTimestampCount: distinctTimestamps,
        },
        `[TradeTimestampAPI] exchange=${exchange} symbol=${marketSymbol} tradeCount=${normalizedTrades.length} distinctTimestamps=${distinctTimestamps}`,
      );
      return {
        items: normalizedTrades,
        total: normalizedTrades.length,
        metadata: resolved.responseMetadata,
      };
    }
  } catch (error) {
    logger.warn(
      {
        domain: 'market-routes',
        exchange,
        marketId: resolved.metadata.marketId,
        symbol: marketSymbol,
        capability: 'trades',
        err: error,
      },
      'Falling back to cached trade data',
    );
    const cachedTrades = publicMarketDataStore
      .getTrades(exchange, marketSymbol, limit ?? 50)
      .map((item) => {
        const cached = fromCachedTrade(item);
        return withFreshness(applyMetadataToCanonicalMarket(cached, resolved.metadata), item.timestamp, 'cached_snapshot');
      });

    if (cachedTrades.length > 0) {
      return {
        items: cachedTrades,
        total: cachedTrades.length,
        metadata: buildAvailability(resolved.metadata, {
          target: 'trades',
          reason: error instanceof Error ? error.message : String(error),
        }),
      };
    }

    throw buildMarketDataError({
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'trades',
      exchange,
      metadata: resolved.metadata,
      reason: error instanceof Error ? error.message : String(error),
      retryable: true,
    });
  }

  const cachedTrades = publicMarketDataStore
    .getTrades(exchange, marketSymbol, limit ?? 50)
    .map((item) => {
      const cached = fromCachedTrade(item);
      return withFreshness(applyMetadataToCanonicalMarket(cached, resolved.metadata), item.timestamp, 'cached_snapshot');
    });

  return {
    items: cachedTrades,
    total: cachedTrades.length,
    metadata: resolved.responseMetadata,
  };
}

export async function getTrades(exchange: ExchangeId, symbol: string, limit?: number): Promise<CanonicalTrade[]> {
  return (await getTradesWithMeta(exchange, symbol, limit)).items;
}

export async function getCandles(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  limit?: number,
): Promise<CanonicalCandle[]> {
  return (await getCandlesWithMeta(exchange, symbol, interval, limit)).items;
}

export async function getCandlesWithMeta(
  exchange: ExchangeId,
  request: MarketLookupRequest,
  interval: string,
  limit?: number,
): Promise<MarketCandlesResponse> {
  const resolved = await resolveMarketForRequest(exchange, request, 'candles');
  logger.info(
    {
      domain: 'market-routes',
      exchange,
      marketId: resolved.metadata.marketId,
      canonicalMarketId: resolved.metadata.canonicalMarketId,
      candlesSupported: resolved.metadata.candlesSupported,
      graphSupported: resolved.metadata.graphSupported,
      supportedIntervals: resolved.metadata.supportedIntervals,
    },
    `[CandleAPI] candle_capability_cache_hit exchange=${exchange} marketId=${resolved.metadata.marketId} supported=${resolved.metadata.candlesSupported}`,
  );

  logger.info(
    {
      domain: 'market-routes',
      exchange,
      marketId: resolved.metadata.marketId,
      canonicalMarketId: resolved.metadata.canonicalMarketId,
      canonicalSymbol: resolved.metadata.canonicalSymbol,
      interval,
      limit: limit ?? null,
    },
    `[CandleAPI] candle_request_resolved exchange=${exchange} marketId=${resolved.metadata.marketId} canonicalMarketId=${resolved.metadata.canonicalMarketId}`,
  );

  if (!resolved.metadata.candlesSupported) {
    logger.info(
      {
        domain: 'market-routes',
        exchange,
        marketId: resolved.metadata.marketId,
        canonicalMarketId: resolved.metadata.canonicalMarketId,
        reason: resolved.metadata.unsupportedReason,
      },
      `[CandleAPI] candle_unsupported_classified exchange=${exchange} marketId=${resolved.metadata.marketId} reason=${resolved.metadata.unsupportedReason ?? 'provider_not_supported'}`,
    );
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'candles',
      exchange,
      metadata: resolved.metadata,
      reason: resolved.metadata.unsupportedReason ?? 'provider_not_supported',
      retryable: false,
    });
  }

  const snapshot = await resolveCandleSnapshot({
    exchange,
    symbol: resolved.market.symbol,
    marketId: resolved.market.marketId ?? resolved.metadata.marketId,
    rawSymbol: resolved.market.rawSymbol ?? resolved.market.exchangeSymbol ?? resolved.metadata.rawSymbol,
    interval,
    limit,
  });
  if (snapshot.support === 'unsupported') {
    if (snapshot.meta.isRenderable && snapshot.items.length > 0) {
      const items = [...snapshot.items]
        .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime)
        .map((item) =>
        withFreshness(
          applyMetadataToCanonicalMarket(item, resolved.metadata),
          item.closeTime,
          'cached_snapshot',
        ));

      return {
        items,
        meta: snapshot.meta,
        metadata: buildAvailability(resolved.metadata, {
          target: 'candles',
          state: 'unsupported',
          reason: snapshot.reason ?? `${interval} is unsupported`,
        }),
      };
    }

    logger.info(
      {
        domain: 'market-routes',
        exchange,
        marketId: resolved.metadata.marketId,
        canonicalMarketId: resolved.metadata.canonicalMarketId,
        reason: snapshot.reason ?? `${interval} is unsupported`,
      },
      `[CandleAPI] candle_unsupported_classified exchange=${exchange} marketId=${resolved.metadata.marketId} reason=${snapshot.reason ?? `${interval} is unsupported`}`,
    );

    throw buildMarketDataError({
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'candles',
      exchange,
      metadata: resolved.metadata,
      reason: snapshot.reason ?? `${interval} is unsupported`,
      retryable: false,
      statusCode: 400,
    });
  }

  if (snapshot.status === 'unavailable' || snapshot.status === 'failed') {
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'candles',
      exchange,
      metadata: resolved.metadata,
      reason: snapshot.reason ?? snapshot.status,
      retryable: true,
    });
  }

  if (snapshot.status === 'empty' || snapshot.items.length === 0 || !snapshot.meta.isRenderable) {
    throw buildMarketDataError({
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'candles',
      exchange,
      metadata: resolved.metadata,
      reason: snapshot.reason ?? 'no_usable_candles',
      retryable: true,
    });
  }

  const items = [...snapshot.items]
    .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime)
    .map((item) =>
    withFreshness(
      applyMetadataToCanonicalMarket(item, resolved.metadata),
      item.closeTime,
      snapshot.staleCacheUsed ? 'cached_snapshot' : 'snapshot',
    ));

  logger.info(
    {
      domain: 'market-routes',
      exchange,
      marketId: resolved.metadata.marketId,
      canonicalMarketId: resolved.metadata.canonicalMarketId,
      interval: snapshot.interval ?? interval,
      requestedInterval: interval,
      count: items.length,
      staleCacheUsed: snapshot.staleCacheUsed,
      source: snapshot.source,
    },
    `[CandleAPI] candle_response_summary exchange=${exchange} marketId=${resolved.metadata.marketId} count=${items.length} interval=${snapshot.interval ?? interval}`,
  );

  return {
    items,
    meta: snapshot.meta,
    metadata: resolved.responseMetadata,
  };
}

export async function getMarketSummary(params: {
  exchange: ExchangeId;
  symbol?: string;
  marketId?: string;
}): Promise<MarketSummaryResponse> {
  const resolved = await resolveMarketForRequest(params.exchange, {
    symbol: params.symbol,
    marketId: params.marketId,
  }, 'summary');
  let latestTicker: FreshMarketData<CanonicalTickerSnapshot> | null = null;

  try {
    const loads = await getExchangeTickerLoads(params.exchange, [resolved.metadata.canonicalSymbol], {
      freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
      prioritySymbols: [resolved.metadata.canonicalSymbol],
      priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.snapshotTop,
      providerTimeoutMs: 900,
    });
    const load = loads.get(resolved.metadata.canonicalSymbol);
    if (load?.ticker) {
      latestTicker = withFreshness(
        applyMetadataToCanonicalMarket(load.ticker, resolved.metadata),
        load.ticker.timestamp,
        resolveTickerDataMode(load.source),
      );
    }
  } catch (error) {
    logger.warn(
      {
        domain: 'market-routes',
        exchange: params.exchange,
        marketId: resolved.metadata.marketId,
        symbol: resolved.metadata.canonicalSymbol,
        capability: 'summary_ticker',
        err: error,
      },
      'Market summary ticker snapshot unavailable',
    );
  }

  return {
    metadata: resolved.responseMetadata,
    market: resolved.responseMetadata,
    latestTicker,
    updatedAt: latestTicker?.sourceTimestamp ?? latestTicker?.timestamp ?? null,
  };
}

export async function getReferenceTicker(symbol: string) {
  return exchangeProviderRegistry.getReferencePriceSource().getReferenceTicker(symbol);
}
