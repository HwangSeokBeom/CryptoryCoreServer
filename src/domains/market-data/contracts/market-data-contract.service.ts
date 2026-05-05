import { env } from '../../../config/env';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { createHash } from 'crypto';
import {
  BinanceMarketDataAdapter,
  CoinoneMarketDataAdapter,
  KorbitMarketDataAdapter,
  normalizeMarketIdentity,
  V1ExchangeMarketDataAdapter,
} from './exchange-market-data.adapters';
import type {
  CandleSnapshotParams,
  ContractExchange,
  ContractQuoteCurrency,
  ContractTimeframe,
  CurrentPriceSnapshot,
  ExchangeMarketDataAdapter,
  ExchangeQuoteContract,
  MarketCandle,
  MarketTickerItem,
  MarketTickerDiagnostics,
  QuoteDisplayHint,
  SparklineQuality,
  SortOrder,
  TickerSparklineSource,
  TickerListParams,
  TickerSort,
} from './market-data.types';

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type CandleLoadResult = {
  candles: MarketCandle[];
  summary: CurrentPriceSnapshot | null;
};

type LastKnownGoodCandleEntry = {
  value: CandleLoadResult;
  savedAt: number;
};

type SparklineCacheEntry = {
  item: ContractSparklineItem;
  savedAt: number;
  expiresAt: number;
  staleUntil: number;
};

type SparklineVersionSnapshot = {
  price: number | null;
  pointsHash: string;
  updatedAt: string | null;
};

type ContractSparklinePoint = { price: number; value: number; timestamp: number };
type SparklinePriority = 'normal' | 'top' | 'interactive';
type SparklineItemDecision =
  | 'cache_full'
  | 'cache_stale_full'
  | 'cache_partial'
  | 'ring_partial'
  | 'provider_full'
  | 'provider_partial'
  | 'timeout_with_partial'
  | 'timeout_unavailable'
  | 'provider_unavailable'
  | 'resolve_failed'
  | 'quote_mismatch';

type SparklineCacheWriteDecision = 'write' | 'skip_keep_better' | 'skip_low_quality';

type SparklineSeriesDiagnostics = {
  decision: SparklineItemDecision | null;
  requestedLimit: number;
  pointCount: number;
  provider: ContractExchange | null;
  providerMarket: string | null;
  cacheKey: string | null;
  cacheHit: boolean;
  cacheAgeMs: number | null;
  cacheWriteDecision: SparklineCacheWriteDecision | null;
  previousQuality: SparklineQuality | null;
  newQuality: SparklineQuality | null;
  stale: boolean;
  ringBufferHit: boolean;
  providerFetched: boolean;
  providerLatencyMs: number | null;
  providerTimeout: boolean;
  providerError: string | null;
  partial: boolean;
  partialReason: string | null;
  coverageRatio: number;
  uniqueValueCount: number;
  minValue: number | null;
  maxValue: number | null;
  meanValue: number | null;
  firstValue: number | null;
  lastValue: number | null;
  valueRange: number;
  rangeRatio: number;
  firstLastChangeRatio: number;
  directionChanges: number;
  zeroDeltaCount: number;
  duplicateTimestampCount: number;
  linearityScore: number;
  straightnessScore: number;
  isFlat: boolean;
  isLinearDerived: boolean;
  realSeries: boolean;
  graphDisplayAllowed: boolean;
  graphDisplayAllowedReason: string;
  recommendedDisplayScale: number;
  volatilityHint: 'flat' | 'low' | 'medium' | 'high';
  fallbackReason: string | null;
  resolvedBy: string | null;
};

type ContractSparklineItem = {
  exchange: ContractExchange;
  symbol: string;
  marketId: string;
  canonicalMarketId: string;
  baseCurrency: string;
  quoteCurrency: ContractQuoteCurrency;
  displayPair: string;
  points: ContractSparklinePoint[];
  sparkline: number[];
  sparklinePoints: ContractSparklinePoint[];
  source: TickerSparklineSource | 'prepared_cache' | 'last_known_good' | 'provider_candle_1m' | 'derived_interpolated';
  sparklineSource: TickerSparklineSource | 'prepared_cache' | 'last_known_good' | 'provider_candle_1m' | 'derived_interpolated';
  quality: SparklineQuality;
  sparklineQuality: SparklineQuality;
  sparklinePointCount: number;
  isRenderable: boolean;
  graphDisplayAllowed: boolean;
  recommendedDisplayScale: number;
  volatilityHint: 'flat' | 'low' | 'medium' | 'high';
  isDerived: boolean;
  sparklineIsDerived: boolean;
  realSeries: boolean;
  partial: boolean;
  pointCount: number;
  stale: boolean;
  updatedAt: number | null;
  interval: ContractTimeframe;
  requestedLimit: number;
  from: number | null;
  to: number | null;
  generatedAt: string;
  sourceReason?: string;
  unavailableReason?: string | null;
  invalidPointCount?: number;
  diagnostics: SparklineSeriesDiagnostics;
};

type CacheLoad<T> = {
  cacheHit: boolean;
  inFlightDedupe: boolean;
  promise: Promise<T>;
};

const SPARKLINE_SYMBOL_CAP = 50;
const LIST_SPARKLINE_TARGET_POINT_COUNT = 24;
const LIST_SPARKLINE_DEFAULT_TIMEFRAME: ContractTimeframe = '1H';
const SPARKLINE_DEFAULT_INTERVAL: ContractTimeframe = '1H';
const SPARKLINE_DEFAULT_LIMIT = 24;
const SPARKLINE_LIMIT_MAX = 60;
const PREPARED_SPARKLINE_MAX_POINTS = 60;
const TICKER_RING_BUFFER_MAX_POINTS = 240;
const PREPARED_SPARKLINE_REFINED_MIN_POINTS = 8;
const PREPARED_SPARKLINE_STALE_MS = 90_000;
const PREPARED_SPARKLINE_USABLE_STALE_MS = 5 * 60_000;
const SPARKLINE_FULL_REAL_TTL_MS = 60_000;
const SPARKLINE_PARTIAL_REAL_TTL_MS = 30_000;
const SPARKLINE_PROVIDER_TIMEOUT_MS = 1_000;
const SPARKLINE_TOP_RESPONSE_TIMEOUT_MS = 1_200;
const SPARKLINE_TOP_PROVIDER_TIMEOUT_MS = 850;
const SPARKLINE_WARMUP_TOP_LIMIT = 100;
const LIST_SPARKLINE_ATTACH_CONCURRENCY = 8;
const LIST_SPARKLINE_PROVIDER_TIMEOUT_MS = 1_200;
const DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS = 650;
const SPARKLINE_WILDCARDS = new Set(['all', '*', 'null', 'undefined']);
const TICKER_CURSOR_VERSION = 1;
const TICKER_CURSOR_TTL_MS = 5 * 60_000;
const TICKER_LIMIT_MAX = 100;

type ProviderCandleRateLimitProfile = {
  requestMaxFetches: number;
  requestMaxAttachMs: number;
  requestConcurrency: number;
  warmupConcurrency: number;
  warmupBatchSize: number;
  minIntervalMs: number;
  timeoutMs: number;
  cooldownMs: number;
};

type ProviderCandleRateLimitState = {
  nextStartAt: number;
  cooldownUntil: number;
};

type ProviderCandleFetchMetric = {
  attempted: boolean;
  skippedReason: 'budget_exhausted' | 'cooldown' | 'provider_market_not_found' | 'unsupported_quote' | null;
  success: boolean;
  statusCode: number | null;
  latencyMs: number;
  droppedReason: string | null;
};

type ProviderCandleAttachStats = {
  targetCount: number;
  attemptedCount: number;
  successCount: number;
  failedCount: number;
  skippedBudgetCount: number;
  skippedCooldownCount: number;
  skippedUnsupportedCount: number;
  warmupQueuedCount: number;
  http429Count: number;
  http4xxCount: number;
  http5xxCount: number;
  latencyMs: number[];
  droppedReasons: Record<string, number>;
  cooldownUntil: number | null;
  budgetMs: number;
  budgetExhausted: boolean;
};

const PROVIDER_CANDLE_RATE_LIMIT_PROFILES: Record<ContractExchange, ProviderCandleRateLimitProfile> = {
  upbit: {
    requestMaxFetches: 8,
    requestMaxAttachMs: DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    requestConcurrency: 2,
    warmupConcurrency: 1,
    warmupBatchSize: 24,
    minIntervalMs: 135,
    timeoutMs: 850,
    cooldownMs: 20_000,
  },
  bithumb: {
    requestMaxFetches: 6,
    requestMaxAttachMs: DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    requestConcurrency: 2,
    warmupConcurrency: 1,
    warmupBatchSize: 20,
    minIntervalMs: 180,
    timeoutMs: 900,
    cooldownMs: 20_000,
  },
  coinone: {
    requestMaxFetches: 6,
    requestMaxAttachMs: DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    requestConcurrency: 2,
    warmupConcurrency: 1,
    warmupBatchSize: 20,
    minIntervalMs: 180,
    timeoutMs: 900,
    cooldownMs: 20_000,
  },
  korbit: {
    requestMaxFetches: 5,
    requestMaxAttachMs: DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    requestConcurrency: 1,
    warmupConcurrency: 1,
    warmupBatchSize: 16,
    minIntervalMs: 220,
    timeoutMs: 900,
    cooldownMs: 25_000,
  },
  binance: {
    requestMaxFetches: 10,
    requestMaxAttachMs: DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    requestConcurrency: 3,
    warmupConcurrency: 2,
    warmupBatchSize: 32,
    minIntervalMs: 80,
    timeoutMs: 850,
    cooldownMs: 15_000,
  },
};

const adapters: Record<ContractExchange, ExchangeMarketDataAdapter> = {
  upbit: new V1ExchangeMarketDataAdapter('upbit'),
  bithumb: new V1ExchangeMarketDataAdapter('bithumb'),
  coinone: new CoinoneMarketDataAdapter(),
  korbit: new KorbitMarketDataAdapter(),
  binance: new BinanceMarketDataAdapter(),
};

const exchangeContracts: Record<ContractExchange, ExchangeQuoteContract> = {
  upbit: {
    exchange: 'upbit',
    displayName: '업비트',
    supportedQuotes: ['KRW', 'BTC'],
    defaultQuoteCurrency: 'KRW',
    enabled: true,
    status: 'active',
    reason: null,
  },
  bithumb: {
    exchange: 'bithumb',
    displayName: '빗썸',
    supportedQuotes: ['KRW', 'BTC'],
    defaultQuoteCurrency: 'KRW',
    enabled: true,
    status: 'active',
    reason: null,
  },
  coinone: {
    exchange: 'coinone',
    displayName: '코인원',
    supportedQuotes: ['KRW'],
    defaultQuoteCurrency: 'KRW',
    enabled: true,
    status: 'active',
    reason: null,
  },
  korbit: {
    exchange: 'korbit',
    displayName: '코빗',
    supportedQuotes: ['KRW'],
    defaultQuoteCurrency: 'KRW',
    enabled: true,
    status: 'active',
    reason: null,
  },
  binance: {
    exchange: 'binance',
    displayName: '바이낸스',
    supportedQuotes: ['USDT', 'BTC', 'ETH'],
    defaultQuoteCurrency: 'USDT',
    enabled: true,
    status: 'active',
    reason: null,
  },
};

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const lastKnownGoodCandles = new Map<string, LastKnownGoodCandleEntry>();
const preparedSparklineCache = new Map<string, Array<{ price: number; timestamp: number }>>();
const marketSparklineFastCache = new Map<string, SparklineCacheEntry>();
const lastKnownGoodSparklineCache = new Map<string, ContractSparklineItem>();
const lastTickerSparklineVersionByMarket = new Map<string, SparklineVersionSnapshot>();
const sparklineWarmupInFlight = new Set<string>();
const providerCandleRateLimitState = new Map<ContractExchange, ProviderCandleRateLimitState>();
let activeContractSparklineRequests = 0;
let contractSparklineHeavyPathUsed = false;
let tickerRequestSeq = 0;

function ttlCache<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): CacheLoad<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    return { cacheHit: true, inFlightDedupe: false, promise: Promise.resolve(cached.value as T) };
  }

  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) {
    return { cacheHit: false, inFlightDedupe: true, promise: existing };
  }

  const promise = loader()
    .then((value) => {
      cache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      return value;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { cacheHit: false, inFlightDedupe: false, promise };
}

function getAdapter(exchange: ContractExchange) {
  return adapters[exchange];
}

export function listMarketExchangeContracts() {
  return Object.values(exchangeContracts);
}

export function getMarketExchangeContract(exchange: ContractExchange) {
  return exchangeContracts[exchange];
}

export function getDefaultQuoteCurrency(exchange: ContractExchange) {
  return exchangeContracts[exchange].defaultQuoteCurrency;
}

export function isQuoteCurrencySupported(exchange: ContractExchange, quoteCurrency: ContractQuoteCurrency) {
  return exchangeContracts[exchange].supportedQuotes.includes(quoteCurrency);
}

function createTickerDiagnostics(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  supported: boolean;
  providerStatus?: ExchangeQuoteContract['status'];
  providerLatencyMs?: number | null;
  rawCount?: number;
  mappedCount?: number;
  returnedCount?: number;
  omittedCount?: number;
  zeroPriceCount?: number;
  zeroVolumeCount?: number;
  staleCount?: number;
  reason?: string | null;
  previewGraphDerivedCount?: number;
}): MarketTickerDiagnostics {
  const exchangeContract = getMarketExchangeContract(params.exchange);
  return {
    requestedExchange: params.exchange,
    requestedQuoteCurrency: params.quoteCurrency,
    supportedQuotes: exchangeContract.supportedQuotes,
    defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
    supported: params.supported,
    unsupported: !params.supported,
    providerStatus: params.providerStatus ?? (params.supported ? 'active' : 'unsupported'),
    providerLatencyMs: params.providerLatencyMs ?? null,
    rawCount: params.rawCount ?? 0,
    mappedCount: params.mappedCount ?? 0,
    returnedCount: params.returnedCount ?? 0,
    omittedCount: params.omittedCount ?? 0,
    zeroPriceCount: params.zeroPriceCount ?? 0,
    zeroVolumeCount: params.zeroVolumeCount ?? 0,
    staleCount: params.staleCount ?? 0,
    reason: params.reason ?? null,
    previewGraphIsDerived: (params.previewGraphDerivedCount ?? 0) > 0,
    previewGraphDerivedCount: params.previewGraphDerivedCount ?? 0,
    previewGraphRealSeries: false,
    previewGraphDisplayAllowed: false,
  };
}

function quoteDisplayHint(quoteCurrency: ContractQuoteCurrency): QuoteDisplayHint {
  if (quoteCurrency === 'BTC' || quoteCurrency === 'ETH') {
    return {
      quoteCurrency,
      recommendedMaxFractionDigits: 10,
      recommendedSignificantDigits: 6,
      compactNotationAllowed: false,
    };
  }
  if (quoteCurrency === 'KRW') {
    return {
      quoteCurrency,
      recommendedMaxFractionDigits: 0,
      recommendedSignificantDigits: null,
      compactNotationAllowed: true,
    };
  }
  return {
    quoteCurrency,
    recommendedMaxFractionDigits: 8,
    recommendedSignificantDigits: 6,
    compactNotationAllowed: false,
  };
}

function warnUnexpectedSparklineHeavyProviderCall(provider: 'candles' | 'trades' | 'orderbook') {
  if (activeContractSparklineRequests <= 0) {
    return;
  }
  contractSparklineHeavyPathUsed = true;
  logger.warn(
    {
      domain: 'market-contract',
      route: '/market/sparkline',
      warning: 'unexpected_heavy_provider_call',
      provider,
    },
    `[MarketSparkline] warning=unexpected_heavy_provider_call provider=${provider}`,
  );
}

function resolveSparklineQuality(source: TickerSparklineSource, pointCount: number): SparklineQuality {
  if (source === 'provider_candle') {
    if (pointCount < 2) return 'unavailable';
    if (pointCount < 12) return 'lowInformation';
    return pointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'providerCandle24' : 'fallbackListSparkline';
  }
  if (source === 'candle_cache' || source === 'sparkline_cache') {
    if (pointCount < 2) return 'unavailable';
    if (pointCount < 12) return 'lowInformation';
    return pointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'listSparkline24' : 'fallbackListSparkline';
  }
  if (source === 'ticker_ring_buffer' || source === 'previous_snapshot') {
    if (pointCount < 2) return 'unavailable';
    return pointCount < 12 ? 'lowInformation' : 'fallbackListSparkline';
  }
  if (source === 'fallback_backfill') return pointCount >= 2 ? 'lowInformation' : 'unavailable';
  if (source === 'provider') return 'provider_mini';
  if (source === 'cache') return pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS ? 'refined_mini' : 'derived_preview';
  if (source === 'derived_change24h') return 'derived_preview';
  if (source === 'flat_current') return 'flat_current';
  return 'placeholder';
}

function resolvePreviewGraphQuality(item: MarketTickerItem): MarketTickerItem['previewGraphQuality'] {
  if (item.sparklineSource === 'unavailable' || item.sparklinePointCount === 0) {
    return 'unavailable';
  }
  if (item.sparklineSource === 'derived_change24h') {
    return 'derived_preview';
  }
  if (
    item.sparklineSource === 'provider'
    || item.sparklineSource === 'cache'
    || item.sparklineSource === 'provider_candle'
    || item.sparklineSource === 'candle_cache'
    || item.sparklineSource === 'sparkline_cache'
    || item.sparklineSource === 'ticker_ring_buffer'
    || item.sparklineSource === 'previous_snapshot'
  ) {
    return 'provider_preview';
  }
  return 'linear_preview';
}

function toPublicTickerSparklineQuality(item: Pick<MarketTickerItem, 'sparklineSource' | 'sparklinePointCount' | 'stale'>): SparklineQuality {
  if (item.sparklinePointCount <= 0) {
    return item.sparklineSource === 'unavailable' ? 'unavailable' : 'placeholder';
  }
  if (item.sparklineSource === 'provider_candle') {
    return resolveSparklineQuality(item.sparklineSource, item.sparklinePointCount);
  }
  if (item.sparklineSource === 'candle_cache' || item.sparklineSource === 'sparkline_cache') {
    if (item.stale && item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT) {
      return 'staleListSparkline24';
    }
    return resolveSparklineQuality(item.sparklineSource, item.sparklinePointCount);
  }
  if (item.sparklineSource === 'ticker_ring_buffer' || item.sparklineSource === 'previous_snapshot') {
    return resolveSparklineQuality(item.sparklineSource, item.sparklinePointCount);
  }
  if (item.sparklineSource === 'provider' || item.sparklineSource === 'cache') {
    return item.stale ? 'staleRealSeries' : 'liveDetailed';
  }
  if (item.sparklineSource === 'derived_change24h' || item.sparklineSource === 'flat_current') {
    return 'derivedPreview';
  }
  return 'unavailable';
}

function toPublicBatchSparklineQuality(item: ContractSparklineItem): SparklineQuality {
  if (item.pointCount <= 0) {
    return item.quality === 'placeholder' ? 'placeholder' : 'unavailable';
  }
  if (item.realSeries && !item.isDerived) {
    return item.stale ? 'staleRealSeries' : 'liveDetailed';
  }
  if (item.isDerived || item.source === 'derived_change24h' || item.source === 'flat_current') {
    return 'derivedPreview';
  }
  return item.quality;
}

function withTickerSparklineMetadata(item: MarketTickerItem): MarketTickerItem {
  const sparklinePointCount = item.sparklinePointCount ?? item.sparklinePoints.length ?? item.sparkline.length;
  const sparklineQuality = toPublicTickerSparklineQuality({ ...item, sparklinePointCount });
  const sparklineIsDerived = item.sparklineIsDerived ?? item.sparklineSource === 'derived_change24h';
  const normalizedPoints = toListSparklinePoints(item.sparklinePoints ?? [], Math.max(sparklinePointCount, LIST_SPARKLINE_TARGET_POINT_COUNT));
  const versionFields = buildSparklineVersionFields({
    points: normalizedPoints,
    source: item.sparklineSource,
    timeframe: item.sparklineTimeframe ?? LIST_SPARKLINE_DEFAULT_TIMEFRAME,
    refreshedAt: item.sparklineUpdatedAt ? Date.parse(item.sparklineUpdatedAt) : undefined,
  });
  const previewGraphQuality = item.previewGraphQuality ?? resolvePreviewGraphQuality({
    ...item,
    canonicalMarketId: item.canonicalMarketId ?? item.marketId,
    originalMarketId: item.originalMarketId ?? item.rawSymbol ?? item.marketId,
    sparklinePointCount,
    sparklineQuality,
    sparklineIsDerived,
    sparklineUpdatedAt: item.sparklineUpdatedAt ?? versionFields.sparklineUpdatedAt,
    sparklineSourceVersion: item.sparklineSourceVersion ?? versionFields.sparklineSourceVersion,
    sparklinePointsHash: item.sparklinePointsHash ?? versionFields.sparklinePointsHash,
    sparklineTimeframe: item.sparklineTimeframe ?? versionFields.sparklineTimeframe,
    sparklineSourceUpdatedAt: item.sparklineSourceUpdatedAt ?? versionFields.sparklineSourceUpdatedAt,
    sparklineUniquePriceCount: item.sparklineUniquePriceCount ?? versionFields.sparklineUniquePriceCount,
    sparklineUnavailableReason: sparklinePointCount >= 2
      ? null
      : item.sparklineUnavailableReason ?? (item.currentPrice === null ? 'current_price_unavailable' : 'insufficient_points'),
  });
  const previewGraphIsDerived = item.previewGraphIsDerived
    ?? item.previewSparklineIsDerived
    ?? (sparklineIsDerived || previewGraphQuality === 'derived_preview' || previewGraphQuality === 'linear_preview');
  return {
    ...item,
    sparklinePointCount,
    sparklineQuality,
    sparklineIsDerived,
    sparklineUpdatedAt: item.sparklineUpdatedAt ?? versionFields.sparklineUpdatedAt,
    sparklineSourceVersion: item.sparklineSourceVersion ?? versionFields.sparklineSourceVersion,
    sparklinePointsHash: item.sparklinePointsHash ?? versionFields.sparklinePointsHash,
    sparklineTimeframe: item.sparklineTimeframe ?? versionFields.sparklineTimeframe,
    sparklineSourceUpdatedAt: item.sparklineSourceUpdatedAt ?? versionFields.sparklineSourceUpdatedAt,
    sparklineUniquePriceCount: item.sparklineUniquePriceCount ?? versionFields.sparklineUniquePriceCount,
    graphDisplayAllowed: false,
    previewSparkline: item.previewSparkline ?? item.sparkline,
    previewSparklinePoints: item.previewSparklinePoints
      ?? item.sparklinePoints.map((point) => ({ ...point, value: point.price })),
    previewSparklineQuality: item.previewSparklineQuality ?? sparklineQuality,
    previewSparklinePointCount: item.previewSparklinePointCount ?? sparklinePointCount,
    previewSparklineIsDerived: item.previewSparklineIsDerived ?? sparklineIsDerived,
    previewGraphQuality,
    previewGraphIsDerived,
    previewGraphPointCount: item.previewGraphPointCount ?? sparklinePointCount,
    previewGraphRealSeries: false,
    previewGraphDisplayAllowed: false,
  };
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function toListSparklinePoints(points: Array<{ price: number; timestamp: number }>, limit = LIST_SPARKLINE_TARGET_POINT_COUNT) {
  return normalizeSparklinePoints(points)
    .points
    .slice(-limit)
    .map((point) => ({ price: point.price, timestamp: point.timestamp }));
}

function hashSparklinePoints(points: Array<{ price: number; timestamp: number }>) {
  const payload = points.map((point) => [point.timestamp, point.price]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 24);
}

function buildSparklineVersionFields(params: {
  points: Array<{ price: number; timestamp: number }>;
  source: TickerSparklineSource;
  timeframe: ContractTimeframe;
  refreshedAt?: number;
}) {
  const pointsHash = hashSparklinePoints(params.points);
  const latestPointTimestamp = params.points[params.points.length - 1]?.timestamp ?? null;
  const sourceVersion = latestPointTimestamp !== null
    ? `${params.source}:${params.timeframe}:${latestPointTimestamp}:${params.points.length}:${pointsHash}`
    : null;
  const updatedAt = params.refreshedAt ?? (latestPointTimestamp ?? null);
  return {
    sparklineUpdatedAt: updatedAt !== null ? new Date(updatedAt).toISOString() : null,
    sparklineSourceUpdatedAt: latestPointTimestamp !== null ? new Date(latestPointTimestamp).toISOString() : null,
    sparklineSourceVersion: sourceVersion,
    sparklinePointsHash: pointsHash,
    sparklineTimeframe: params.timeframe,
    sparklineUniquePriceCount: new Set(params.points.map((point) => point.price)).size,
  };
}

function normalizeSparklineReason(reason: string | null | undefined, quality: SparklineQuality) {
  if (quality === 'insufficient_points') {
    return 'insufficient_sparkline_points';
  }
  if (quality === 'lowInformation') {
    if (reason === 'repeated_price_history' || reason === 'rapid_repeated_price_history') {
      return 'low_unique_price_count';
    }
    return 'insufficient_history';
  }
  if (quality === 'unavailable') {
    if (reason === 'unsupported_market' || reason === 'delisted_or_suspended' || reason === 'adapter_parse_failed') {
      return reason;
    }
    if (reason === 'candle_cache_miss') {
      return 'candle_cache_miss';
    }
    return 'provider_candle_unavailable';
  }
  return reason ?? null;
}

function classifyListSparkline(points: Array<{ price: number; timestamp: number }>, source: TickerSparklineSource, stale = false): {
  quality: SparklineQuality;
  lowInformationReason: string | null;
} {
  if (points.length < 2) {
    return { quality: 'unavailable', lowInformationReason: null };
  }

  const uniquePrices = new Set(points.map((point) => point.price)).size;
  const firstTimestamp = points[0]?.timestamp ?? 0;
  const lastTimestamp = points[points.length - 1]?.timestamp ?? firstTimestamp;
  const spanMs = Math.max(lastTimestamp - firstTimestamp, 0);
  const tooShort = points.length < 12;
  const repeatedOnly = uniquePrices <= 1;
  const rapidRepeated = repeatedOnly && spanMs < 5 * 60_000;
  if (tooShort || repeatedOnly || rapidRepeated) {
    return {
      quality: 'lowInformation',
      lowInformationReason: tooShort
        ? 'insufficient_history'
        : rapidRepeated
          ? 'low_unique_price_count'
          : 'low_unique_price_count',
    };
  }

  if (source === 'provider_candle') {
    return {
      quality: points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'providerCandle24' : 'fallbackListSparkline',
      lowInformationReason: null,
    };
  }
  if (source === 'candle_cache' || source === 'sparkline_cache') {
    return {
      quality: stale
        ? 'staleListSparkline24'
        : points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT
          ? 'listSparkline24'
          : 'fallbackListSparkline',
      lowInformationReason: null,
    };
  }
  if (source === 'previous_snapshot') {
    return {
      quality: points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'staleListSparkline24' : 'fallbackListSparkline',
      lowInformationReason: null,
    };
  }
  return {
    quality: points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'fallbackListSparkline' : 'lowInformation',
    lowInformationReason: points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? null : 'partial_observed_history',
  };
}

function withListSparklineFields(params: {
  item: MarketTickerItem;
  points: Array<{ price: number; timestamp: number }>;
  quality: SparklineQuality;
  source: TickerSparklineSource;
  isDerived: boolean;
  reason: string | null;
  lowInformationReason?: string | null;
  stale?: boolean;
}) {
  const rawPoints = toListSparklinePoints(params.points);
  const rejectedTickerRingBuffer = params.source === 'ticker_ring_buffer' && rawPoints.length < 12;
  const points = rejectedTickerRingBuffer ? [] : rawPoints;
  const pointCount = points.length;
  const classified = classifyListSparkline(points, params.source, params.stale);
  const unavailableReason = rejectedTickerRingBuffer
    ? 'insufficient_sparkline_points'
    : pointCount >= 2
    ? null
    : normalizeSparklineReason(params.reason ?? 'provider_candle_unavailable', 'unavailable');
  const quality = rejectedTickerRingBuffer
    ? 'insufficient_points'
    : pointCount >= 2 ? (params.quality === 'lowInformation' ? params.quality : classified.quality) : 'unavailable';
  const source = pointCount >= 2 ? params.source : 'unavailable';
  const lowInformationReason = quality === 'lowInformation'
    ? normalizeSparklineReason(params.lowInformationReason ?? classified.lowInformationReason ?? params.reason ?? 'insufficient_history', 'lowInformation')
    : null;
  const lowConfidence = pointCount >= 12 && pointCount < LIST_SPARKLINE_TARGET_POINT_COUNT && !params.isDerived;
  const graphDisplayAllowed = pointCount >= 12
    && quality !== 'lowInformation'
    && quality !== 'unavailable'
    && quality !== 'insufficient_points'
    && !params.isDerived;
  const versionFields = buildSparklineVersionFields({
    points,
    source,
    timeframe: LIST_SPARKLINE_DEFAULT_TIMEFRAME,
    refreshedAt: params.stale ? undefined : Date.now(),
  });
  if (rejectedTickerRingBuffer) {
    logger.debug(
      {
        domain: 'market-contract',
        exchange: params.item.exchange,
        quoteCurrency: params.item.quoteCurrency,
        marketId: params.item.marketId,
        source: params.source,
        pointCount: rawPoints.length,
        reason: 'insufficient_points',
      },
      `[ListSparklineRejected] reason=insufficient_points source=ticker_ring_buffer pointCount=${rawPoints.length}`,
    );
  }
  return {
    ...params.item,
    sparkline: points.map((point) => point.price),
    sparklinePoints: points,
    sparklinePointCount: pointCount,
    sparklineQuality: quality,
    sparklineSource: source,
    sparklineIsDerived: pointCount >= 2 ? params.isDerived : false,
    ...versionFields,
    sparklineUnavailableReason: quality === 'unavailable' || quality === 'insufficient_points' ? unavailableReason : null,
    sparklineLowInformationReason: lowInformationReason,
    graphDisplayAllowed,
    lowConfidence,
    previewSparkline: points.map((point) => point.price),
    previewSparklinePoints: points.map((point) => ({ ...point, value: point.price })),
    previewSparklineQuality: quality,
    previewSparklinePointCount: pointCount,
    previewSparklineIsDerived: pointCount >= 2 ? params.isDerived : false,
    previewGraphQuality: pointCount >= 2 ? 'provider_preview' as const : 'unavailable' as const,
    previewGraphIsDerived: pointCount >= 2 ? params.isDerived : false,
    previewGraphPointCount: pointCount,
    previewGraphRealSeries: graphDisplayAllowed,
    previewGraphDisplayAllowed: graphDisplayAllowed,
    stale: params.stale ?? params.item.stale,
  } satisfies MarketTickerItem;
}

function logMarketIdentityMismatch(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  rawMarketId: string;
  canonicalMarketId: string;
  symbol: string;
  reason: string;
}) {
  logger.warn(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      rawMarketId: params.rawMarketId,
      canonicalMarketId: params.canonicalMarketId,
      symbol: params.symbol,
      reason: params.reason,
    },
    `[MarketIdentityMismatch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} rawMarketId=${params.rawMarketId} canonicalMarketId=${params.canonicalMarketId} symbol=${params.symbol} reason=${params.reason}`,
  );
}

function validateTickerIdentity(item: MarketTickerItem, exchange: ContractExchange, quoteCurrency: ContractQuoteCurrency) {
  if (item.exchange !== exchange) {
    return 'exchange_mismatch';
  }
  if (item.quoteCurrency !== quoteCurrency) {
    return 'quote_currency_mismatch';
  }
  const identity = normalizeMarketIdentity(exchange, item.canonicalMarketId ?? item.marketId, quoteCurrency);
  if (!identity.valid) {
    return 'canonical_market_unparseable';
  }
  if (identity.quoteCurrency !== quoteCurrency) {
    return 'canonical_market_quote_mismatch';
  }
  if (identity.canonicalMarketId !== (item.canonicalMarketId ?? item.marketId)) {
    return 'canonical_market_id_mismatch';
  }
  if (identity.symbol !== item.symbol || identity.baseCurrency !== item.baseCurrency) {
    return 'canonical_market_symbol_mismatch';
  }
  if (!item.displayPair.endsWith(`/${quoteCurrency}`)) {
    return 'display_pair_quote_mismatch';
  }
  return null;
}

type PublicTickerSortKey = 'volume24h' | 'changeRate24h' | 'price' | 'name';

type TickerCursorPayload = {
  version: 1;
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  sortKey: PublicTickerSortKey;
  sortDirection: SortOrder;
  query: string | null;
  lastSortValue: number | string | null;
  lastCanonicalMarketId: string;
  snapshotAt: string;
};

function toPublicTickerSortKey(sort: TickerSort): PublicTickerSortKey {
  if (sort === 'volume') return 'volume24h';
  if (sort === 'changeRate') return 'changeRate24h';
  return sort;
}

function normalizeTickerSearchQuery(query?: string | null) {
  const trimmed = query?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function tickerSearchMatches(item: MarketTickerItem, query: string | null) {
  if (!query) {
    return true;
  }
  return [
    item.symbol,
    item.displaySymbol,
    item.koreanName,
    item.englishName,
    item.canonicalMarketId,
  ].some((value) => value.toLowerCase().includes(query));
}

function tickerSortValue(item: MarketTickerItem, sort: TickerSort): number | string | null {
  if (sort === 'name') {
    return item.symbol;
  }
  if (sort === 'price') {
    return item.currentPrice;
  }
  if (sort === 'changeRate') {
    return item.changeRate24h;
  }
  return item.accTradePrice24h;
}

function compareNullablePrimaryValues(
  left: number | string | null,
  right: number | string | null,
  order: SortOrder,
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const compared = typeof left === 'string' || typeof right === 'string'
    ? String(left).localeCompare(String(right))
    : left - right;
  return order === 'asc' ? compared : -compared;
}

function compareTickerSortTuple(
  leftValue: number | string | null,
  leftCanonicalMarketId: string,
  rightValue: number | string | null,
  rightCanonicalMarketId: string,
  order: SortOrder,
) {
  const primary = compareNullablePrimaryValues(leftValue, rightValue, order);
  if (primary !== 0) {
    return primary;
  }
  return leftCanonicalMarketId.localeCompare(rightCanonicalMarketId);
}

function stableSortTickerItems(items: MarketTickerItem[], sort: TickerSort, order: SortOrder) {
  let nullSortValueCount = 0;
  const sorted = [...items].sort((left, right) => {
    const leftValue = tickerSortValue(left, sort);
    const rightValue = tickerSortValue(right, sort);
    if (leftValue === null) nullSortValueCount += 1;
    if (rightValue === null) nullSortValueCount += 1;
    return compareTickerSortTuple(
      leftValue,
      left.canonicalMarketId ?? left.marketId,
      rightValue,
      right.canonicalMarketId ?? right.marketId,
      order,
    );
  });
  return {
    items: sorted,
    nullSortValueCount: sorted.filter((item) => tickerSortValue(item, sort) === null).length,
  };
}

function encodeTickerCursor(params: {
  item: MarketTickerItem;
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  sort: TickerSort;
  order: SortOrder;
  query: string | null;
  snapshotAt: string;
}) {
  const payload: TickerCursorPayload = {
    version: TICKER_CURSOR_VERSION,
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    sortKey: toPublicTickerSortKey(params.sort),
    sortDirection: params.order,
    query: params.query,
    lastSortValue: tickerSortValue(params.item, params.sort),
    lastCanonicalMarketId: params.item.canonicalMarketId ?? params.item.marketId,
    snapshotAt: params.snapshotAt,
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeTickerCursor(cursor: string | undefined): TickerCursorPayload | null {
  if (!cursor) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('not_object');
    }
    const payload = parsed as Partial<TickerCursorPayload>;
    if (
      payload.version !== TICKER_CURSOR_VERSION
      || !payload.exchange
      || !payload.quoteCurrency
      || !payload.sortKey
      || !payload.sortDirection
      || !Object.prototype.hasOwnProperty.call(payload, 'lastSortValue')
      || typeof payload.lastCanonicalMarketId !== 'string'
      || typeof payload.snapshotAt !== 'string'
    ) {
      throw new Error('invalid_shape');
    }
    return payload as TickerCursorPayload;
  } catch {
    logger.info(
      { domain: 'market-contract', valid: false, reason: 'decode_failed' },
      '[CursorPaginationDecode] valid=false reason=decode_failed cursorExchange= cursorQuote= cursorSortKey= cursorQuery=',
    );
    throw new AppError(400, 'invalid ticker cursor', { field: 'cursor', reason: 'decode_failed' }, 'INVALID_CURSOR');
  }
}

function validateTickerCursor(params: {
  cursor: TickerCursorPayload | null;
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  sort: TickerSort;
  order: SortOrder;
  query: string | null;
  now: number;
}) {
  if (!params.cursor) {
    return;
  }
  const reason = params.cursor.exchange !== params.exchange
    ? 'exchange_mismatch'
    : params.cursor.quoteCurrency !== params.quoteCurrency
      ? 'quote_currency_mismatch'
      : params.cursor.sortKey !== toPublicTickerSortKey(params.sort)
        ? 'sort_key_mismatch'
        : params.cursor.sortDirection !== params.order
          ? 'sort_direction_mismatch'
          : params.cursor.query !== params.query
            ? 'query_mismatch'
            : null;
  logger.info(
    {
      domain: 'market-contract',
      valid: reason === null,
      reason,
      cursorExchange: params.cursor.exchange,
      cursorQuote: params.cursor.quoteCurrency,
      cursorSortKey: params.cursor.sortKey,
      cursorQuery: params.cursor.query,
    },
    `[CursorPaginationDecode] valid=${reason === null} reason=${reason ?? ''} cursorExchange=${params.cursor.exchange} cursorQuote=${params.cursor.quoteCurrency} cursorSortKey=${params.cursor.sortKey} cursorQuery=${params.cursor.query ?? ''}`,
  );
  if (reason) {
    throw new AppError(400, 'ticker cursor does not match request parameters', { field: 'cursor', reason }, 'INVALID_CURSOR');
  }
  const snapshotMs = Date.parse(params.cursor.snapshotAt);
  if (!Number.isFinite(snapshotMs) || params.now - snapshotMs > TICKER_CURSOR_TTL_MS) {
    throw new AppError(410, 'ticker cursor expired', {
      field: 'cursor',
      reason: 'snapshot_expired',
      resetRequired: true,
    }, 'CURSOR_EXPIRED');
  }
}

function paginateTickerItems(items: MarketTickerItem[], params: {
  limit: number;
  cursor?: string;
  sort: TickerSort;
  order: SortOrder;
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  query: string | null;
  snapshotAt: string;
}) {
  const decoded = decodeTickerCursor(params.cursor);
  validateTickerCursor({
    cursor: decoded,
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    sort: params.sort,
    order: params.order,
    query: params.query,
    now: Date.now(),
  });
  let startIndex = 0;
  if (decoded) {
    startIndex = items.findIndex((item) => compareTickerSortTuple(
      tickerSortValue(item, params.sort),
      item.canonicalMarketId ?? item.marketId,
      decoded.lastSortValue,
      decoded.lastCanonicalMarketId,
      params.order,
    ) > 0);
    if (startIndex < 0) {
      startIndex = items.length;
    }
  }
  const page = items.slice(startIndex, startIndex + params.limit);
  const hasNext = startIndex + params.limit < items.length;
  const nextCursor = hasNext && page.length > 0
    ? encodeTickerCursor({
        item: page[page.length - 1],
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        sort: params.sort,
        order: params.order,
        query: params.query,
        snapshotAt: params.snapshotAt,
      })
    : null;
  return {
    page,
    nextCursor,
    hasNext,
    duplicateDroppedCount: 0,
  };
}

function dedupeTickerItemsByCanonical(items: MarketTickerItem[]) {
  const seen = new Set<string>();
  const unique: MarketTickerItem[] = [];
  let duplicateCount = 0;
  for (const item of items) {
    const key = item.canonicalMarketId ?? item.marketId;
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return { items: unique, duplicateCount };
}

function attachListSparkline(item: MarketTickerItem, params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
}) {
  const startedAt = Date.now();
  const key = preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId);
  const ringBufferCount = preparedSparklineCache.get(key)?.length ?? 0;
  const finalize = (
    attachedItem: MarketTickerItem,
    diagnostics: {
      rawPointCount: number;
      source: TickerSparklineSource;
      reason: string | null;
      candleCacheHit?: boolean;
    },
  ) => ({
    item: attachedItem,
    elapsedMs: Date.now() - startedAt,
    cacheKey: key,
    rawPointCount: diagnostics.rawPointCount,
    source: diagnostics.source,
    reason: attachedItem.sparklineLowInformationReason
      ?? attachedItem.sparklineUnavailableReason
      ?? diagnostics.reason,
    candleCacheHit: diagnostics.candleCacheHit ?? false,
    ringBufferCount,
  });
  const providerPoints = toListSparklinePoints(item.sparklineIsDerived ? [] : item.sparklinePoints);
  if ((item.sparklineSource === 'provider' || item.sparklineSource === 'provider_candle') && providerPoints.length >= 2) {
    return finalize(
      withListSparklineFields({
        item,
        points: providerPoints,
        quality: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'providerCandle24' : 'fallbackListSparkline',
        source: 'provider_candle',
        isDerived: false,
        reason: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? null : 'provider_candle_partial',
      }),
      {
        rawPointCount: providerPoints.length,
        source: 'provider_candle',
        reason: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? null : 'provider_candle_partial',
      },
    );
  }

  const cached = readCachedSparklineItem(key, true);
  if (cached && cached.pointCount >= 2) {
    const points = toListSparklinePoints(cached.sparklinePoints);
    const full = points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT;
    return finalize(
      withListSparklineFields({
        item,
        points,
        quality: cached.stale && full ? 'staleListSparkline24' : full ? 'listSparkline24' : 'fallbackListSparkline',
        source: 'candle_cache',
        isDerived: false,
        reason: cached.stale ? 'stale_sparkline_cache' : null,
        stale: cached.stale,
      }),
      {
        rawPointCount: points.length,
        source: 'candle_cache',
        reason: cached.stale ? 'stale_sparkline_cache' : null,
        candleCacheHit: true,
      },
    );
  }

  const lastKnownGood = lastKnownGoodSparklineCache.get(key);
  if (lastKnownGood && lastKnownGood.pointCount >= 2) {
    const points = toListSparklinePoints(lastKnownGood.sparklinePoints);
    const full = points.length >= LIST_SPARKLINE_TARGET_POINT_COUNT;
    return finalize(
      withListSparklineFields({
        item,
        points,
        quality: full ? 'staleListSparkline24' : 'fallbackListSparkline',
        source: 'previous_snapshot',
        isDerived: !lastKnownGood.realSeries,
        reason: 'previous_snapshot',
        stale: true,
      }),
      {
        rawPointCount: points.length,
        source: 'previous_snapshot',
        reason: 'previous_snapshot',
        candleCacheHit: true,
      },
    );
  }

  if (item.sparklineSource === 'cache' && providerPoints.length >= 2) {
    return finalize(
      withListSparklineFields({
        item,
        points: providerPoints,
        quality: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? 'listSparkline24' : 'fallbackListSparkline',
        source: 'candle_cache',
        isDerived: false,
        reason: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? null : 'candle_cache_partial',
      }),
      {
        rawPointCount: providerPoints.length,
        source: 'candle_cache',
        reason: providerPoints.length >= LIST_SPARKLINE_TARGET_POINT_COUNT ? null : 'candle_cache_partial',
        candleCacheHit: true,
      },
    );
  }

  const ringPoints = toListSparklinePoints(preparedSparklineCache.get(key) ?? []);
  if (ringPoints.length >= 2) {
    return finalize(
      withListSparklineFields({
        item,
        points: ringPoints,
        quality: 'fallbackListSparkline',
        source: 'ticker_ring_buffer',
        isDerived: false,
        reason: ringPoints.length < LIST_SPARKLINE_TARGET_POINT_COUNT ? 'ticker_ring_buffer_warming' : null,
      }),
      {
        rawPointCount: ringPoints.length,
        source: 'ticker_ring_buffer',
        reason: ringPoints.length < LIST_SPARKLINE_TARGET_POINT_COUNT ? 'ticker_ring_buffer_warming' : null,
      },
    );
  }

  const unavailableReason = item.currentPrice === null
    ? 'no_price_history'
    : preparedSparklineCache.has(key)
      ? 'insufficient_ring_buffer'
      : item.sparklineUnavailableReason ?? 'provider_candle_unavailable';
  return finalize(
    withListSparklineFields({
      item,
      points: [],
      quality: 'unavailable',
      source: 'unavailable',
      isDerived: false,
      reason: unavailableReason,
    }),
    {
      rawPointCount: 0,
      source: 'unavailable',
      reason: unavailableReason,
    },
  );
}

type ListSparklineAttachResult = ReturnType<typeof attachListSparkline>;

function shouldFetchProviderListSparkline(item: MarketTickerItem) {
  if (item.currentPrice === null || item.currentPrice <= 0) {
    return false;
  }
  if (
    item.graphDisplayAllowed
    && !item.sparklineIsDerived
    && item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT
    && (
      item.sparklineQuality === 'providerCandle24'
      || item.sparklineQuality === 'listSparkline24'
      || item.sparklineQuality === 'staleListSparkline24'
    )
  ) {
    return false;
  }
  return item.sparklineQuality === 'lowInformation'
    || item.sparklineQuality === 'unavailable'
    || item.sparklineQuality === 'insufficient_points'
    || item.sparklineQuality === 'fallbackListSparkline'
    || item.sparklinePointCount < LIST_SPARKLINE_TARGET_POINT_COUNT;
}

function extractProviderFailureStatus(error: unknown) {
  if (error instanceof AppError) {
    const upstreamStatus = error.details?.statusCode;
    return typeof upstreamStatus === 'number' ? upstreamStatus : error.statusCode;
  }
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : null;
  }
  return null;
}

function extractProviderFailureReason(error: unknown) {
  if (error instanceof AppError) {
    return error.code ?? error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'provider_candle_unavailable';
}

function getProviderCandleRateLimitProfile(exchange: ContractExchange) {
  return PROVIDER_CANDLE_RATE_LIMIT_PROFILES[exchange];
}

function getProviderCandleRateLimitState(exchange: ContractExchange) {
  let state = providerCandleRateLimitState.get(exchange);
  if (!state) {
    state = { nextStartAt: 0, cooldownUntil: 0 };
    providerCandleRateLimitState.set(exchange, state);
  }
  return state;
}

function classifyProviderDropReason(reason: string, statusCode: number | null) {
  if (statusCode === 429) {
    return 'rate_limited';
  }
  if (reason === 'CANDLES_UNSUPPORTED') {
    return 'unsupported_quote';
  }
  if (reason === 'provider_timeout') {
    return 'provider_timeout';
  }
  if (reason === 'cooldown') {
    return 'cache_pending';
  }
  if (reason === 'budget_exhausted') {
    return 'cache_pending';
  }
  if (reason.startsWith('insufficient_provider_points')) {
    return 'insufficient_points';
  }
  if (reason === 'INVALID_MARKET') {
    return 'provider_market_not_found';
  }
  return 'provider_candle_fetch_failed';
}

function registerProviderCandleFailure(params: {
  exchange: ContractExchange;
  statusCode: number | null;
}) {
  if (params.statusCode !== 429) {
    return;
  }
  const profile = getProviderCandleRateLimitProfile(params.exchange);
  const state = getProviderCandleRateLimitState(params.exchange);
  state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + profile.cooldownMs);
}

function countProviderMetric(stats: ProviderCandleAttachStats, metric: ProviderCandleFetchMetric) {
  if (metric.attempted) {
    stats.attemptedCount += 1;
  }
  if (metric.success) {
    stats.successCount += 1;
  }
  if (metric.attempted && !metric.success) {
    stats.failedCount += 1;
  }
  if (metric.skippedReason === 'budget_exhausted') {
    stats.skippedBudgetCount += 1;
    stats.budgetExhausted = true;
  }
  if (metric.skippedReason === 'cooldown') {
    stats.skippedCooldownCount += 1;
  }
  if (metric.skippedReason === 'provider_market_not_found' || metric.skippedReason === 'unsupported_quote') {
    stats.skippedUnsupportedCount += 1;
  }
  if (metric.statusCode === 429) {
    stats.http429Count += 1;
  }
  if (metric.statusCode !== null && metric.statusCode >= 400 && metric.statusCode < 500) {
    stats.http4xxCount += 1;
  }
  if (metric.statusCode !== null && metric.statusCode >= 500) {
    stats.http5xxCount += 1;
  }
  if (metric.latencyMs > 0) {
    stats.latencyMs.push(metric.latencyMs);
  }
  if (metric.droppedReason) {
    stats.droppedReasons[metric.droppedReason] = (stats.droppedReasons[metric.droppedReason] ?? 0) + 1;
  }
}

async function waitForProviderCandleSlot(params: {
  exchange: ContractExchange;
  deadlineAt: number | null;
}) {
  const profile = getProviderCandleRateLimitProfile(params.exchange);
  const state = getProviderCandleRateLimitState(params.exchange);
  const now = Date.now();
  if (state.cooldownUntil > now) {
    return { allowed: false as const, reason: 'cooldown' as const, waitMs: state.cooldownUntil - now };
  }
  const startAt = Math.max(now, state.nextStartAt);
  if (params.deadlineAt !== null && startAt + 5 > params.deadlineAt) {
    return { allowed: false as const, reason: 'budget_exhausted' as const, waitMs: startAt - now };
  }
  state.nextStartAt = startAt + profile.minIntervalMs + Math.floor(Math.random() * Math.min(profile.minIntervalMs, 40));
  const waitMs = Math.max(startAt - now, 0);
  if (waitMs > 0 && process.env.NODE_ENV !== 'test') {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return { allowed: true as const, reason: null, waitMs };
}

function logProviderCandleFetchDropped(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  marketId: string;
  timeframe: ContractTimeframe;
  statusCode: number | null;
  error: string;
  droppedReason: string;
  latencyMs: number;
  route: '/market/tickers' | 'warmup';
}) {
  logger.warn(
    {
      domain: 'market-contract',
      route: params.route,
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      marketId: params.marketId,
      timeframe: params.timeframe,
      httpStatus: params.statusCode,
      error: params.error,
      droppedReason: params.droppedReason,
      retryable: true,
      latencyMs: params.latencyMs,
    },
    `[ProviderCandleFetchDropped] route=${params.route} exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${params.marketId} timeframe=${params.timeframe} httpStatus=${params.statusCode ?? ''} error=${params.error} droppedReason=${params.droppedReason} retryable=true latencyMs=${params.latencyMs}`,
  );
}

async function fetchProviderListSparklineAttach(item: MarketTickerItem, params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  timeoutMs: number;
  deadlineAt: number | null;
  route: '/market/tickers' | 'warmup';
}): Promise<{ replacement: ListSparklineAttachResult | null; metric: ProviderCandleFetchMetric }> {
  const startedAt = Date.now();
  const key = preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId);
  const timeframe = LIST_SPARKLINE_DEFAULT_TIMEFRAME;
  const providerMarket = resolveProviderMarket(params.exchange, item.symbol, params.quoteCurrency);
  const timeoutSentinel = { timeout: true as const };
  const slot = await waitForProviderCandleSlot({
    exchange: params.exchange,
    deadlineAt: params.deadlineAt,
  });
  if (!slot.allowed) {
    return {
      replacement: null,
      metric: {
        attempted: false,
        skippedReason: slot.reason,
        success: false,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        droppedReason: slot.reason,
      },
    };
  }
  try {
    const candleLoad = getAdapter(params.exchange).getCandles({
      exchange: params.exchange,
      symbol: item.symbol,
      quoteCurrency: params.quoteCurrency,
      timeframe,
      limit: LIST_SPARKLINE_TARGET_POINT_COUNT,
    });
    void candleLoad.catch(() => undefined);
    const result = await Promise.race([
      candleLoad.then((candles) => ({ timeout: false as const, candles })),
      timeoutAfter(params.timeoutMs, timeoutSentinel),
    ]);
    if (result.timeout) {
      throw new Error('provider_timeout');
    }

    const points = result.candles
      .map((candle) => ({
        price: candle.close,
        timestamp: Date.parse(candle.timestamp),
      }))
      .filter((point) => Number.isFinite(point.price) && point.price > 0 && Number.isFinite(point.timestamp))
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-LIST_SPARKLINE_TARGET_POINT_COUNT);
    if (points.length < LIST_SPARKLINE_TARGET_POINT_COUNT) {
      logProviderCandleFetchDropped({
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        marketId: item.marketId,
        timeframe,
        statusCode: null,
        error: `insufficient_provider_points:${points.length}`,
        droppedReason: 'insufficient_points',
        latencyMs: Date.now() - startedAt,
        route: params.route,
      });
      return {
        replacement: null,
        metric: {
          attempted: true,
          skippedReason: null,
          success: false,
          statusCode: null,
          latencyMs: Date.now() - startedAt,
          droppedReason: 'insufficient_points',
        },
      };
    }

    const providerItem = buildProviderCandleSparklineItem({
      item,
      candles: result.candles,
      limit: LIST_SPARKLINE_TARGET_POINT_COUNT,
      interval: timeframe,
    });
    if (providerItem) {
      const normalizedProvider = withProviderDiagnostics(providerItem, {
        providerLatencyMs: Date.now() - startedAt,
        partialReason: null,
        fallbackReason: 'list_provider_candle_attach',
      });
      if (isDisplayableRealSparkline(normalizedProvider)) {
        writeRealSparklineCache(key, normalizedProvider);
      }
    }

    const attachedItem = withListSparklineFields({
      item,
      points,
      quality: 'providerCandle24',
      source: 'provider_candle',
      isDerived: false,
      reason: null,
    });
    logger.debug(
      {
        domain: 'market-contract',
        route: '/market/tickers',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        marketId: item.marketId,
        providerMarket,
        timeframe,
        pointCount: attachedItem.sparklinePointCount,
        quality: attachedItem.sparklineQuality,
        graphDisplayAllowed: attachedItem.graphDisplayAllowed,
        latencyMs: Date.now() - startedAt,
      },
      `[ProviderCandleListAttach] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} providerMarket=${providerMarket} timeframe=${timeframe} pointCount=${attachedItem.sparklinePointCount} quality=${attachedItem.sparklineQuality} graphDisplayAllowed=${attachedItem.graphDisplayAllowed} latencyMs=${Date.now() - startedAt}`,
    );
    return {
      replacement: {
        item: attachedItem,
        elapsedMs: Date.now() - startedAt,
        cacheKey: key,
        rawPointCount: points.length,
        source: 'provider_candle',
        reason: attachedItem.sparklineLowInformationReason ?? attachedItem.sparklineUnavailableReason ?? null,
        candleCacheHit: false,
        ringBufferCount: preparedSparklineCache.get(key)?.length ?? 0,
      },
      metric: {
        attempted: true,
        skippedReason: null,
        success: true,
        statusCode: null,
        latencyMs: Date.now() - startedAt,
        droppedReason: null,
      },
    };
  } catch (error) {
    const reason = extractProviderFailureReason(error);
    const statusCode = extractProviderFailureStatus(error);
    const droppedReason = classifyProviderDropReason(reason, statusCode);
    registerProviderCandleFailure({
      exchange: params.exchange,
      statusCode,
    });
    logProviderCandleFetchDropped({
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      marketId: item.marketId,
      timeframe,
      statusCode,
      error: reason,
      droppedReason,
      latencyMs: Date.now() - startedAt,
      route: params.route,
    });
    return {
      replacement: null,
      metric: {
        attempted: true,
        skippedReason: null,
        success: false,
        statusCode,
        latencyMs: Date.now() - startedAt,
        droppedReason,
      },
    };
  }
}

async function attachProviderListSparklinesForVisibleItems(
  attached: ListSparklineAttachResult[],
  params: {
    exchange: ContractExchange;
    quoteCurrency: ContractQuoteCurrency;
  },
) {
  const profile = getProviderCandleRateLimitProfile(params.exchange);
  const startedAt = Date.now();
  const deadlineAt = startedAt + profile.requestMaxAttachMs;
  const stats: ProviderCandleAttachStats = {
    targetCount: 0,
    attemptedCount: 0,
    successCount: 0,
    failedCount: 0,
    skippedBudgetCount: 0,
    skippedCooldownCount: 0,
    skippedUnsupportedCount: 0,
    warmupQueuedCount: 0,
    http429Count: 0,
    http4xxCount: 0,
    http5xxCount: 0,
    latencyMs: [],
    droppedReasons: {},
    cooldownUntil: null,
    budgetMs: profile.requestMaxAttachMs,
    budgetExhausted: false,
  };
  const fetchTargets = attached
    .map((result, index) => ({ result, index }))
    .filter(({ result }) => shouldFetchProviderListSparkline(result.item));
  stats.targetCount = fetchTargets.length;
  if (fetchTargets.length === 0) {
    return { attached, stats };
  }
  const requestTargets = fetchTargets.slice(0, profile.requestMaxFetches);
  const deferredTargets = fetchTargets.slice(profile.requestMaxFetches);
  stats.warmupQueuedCount = deferredTargets.length;
  stats.skippedBudgetCount += deferredTargets.length;
  stats.budgetExhausted = deferredTargets.length > 0;

  logger.info(
    {
      domain: 'market-contract',
      route: '/market/tickers',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      targetCount: fetchTargets.length,
      requestTargetCount: requestTargets.length,
      deferredTargetCount: deferredTargets.length,
      concurrency: profile.requestConcurrency,
      timeoutMs: profile.timeoutMs,
      budgetMs: profile.requestMaxAttachMs,
    },
    `[ProviderCandleListAttachBatch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} targetCount=${fetchTargets.length} requestTargetCount=${requestTargets.length} deferredTargetCount=${deferredTargets.length} concurrency=${profile.requestConcurrency} timeoutMs=${profile.timeoutMs} budgetMs=${profile.requestMaxAttachMs}`,
  );

  const replacements = await mapBounded(
    requestTargets,
    profile.requestConcurrency,
    async ({ result }) => {
      if (Date.now() >= deadlineAt) {
        return {
          replacement: null,
          metric: {
            attempted: false,
            skippedReason: 'budget_exhausted' as const,
            success: false,
            statusCode: null,
            latencyMs: 0,
            droppedReason: 'budget_exhausted',
          },
        };
      }
      return fetchProviderListSparklineAttach(result.item, {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
        timeoutMs: profile.timeoutMs,
        deadlineAt,
        route: '/market/tickers',
      });
    },
  );
  const next = [...attached];
  replacements.forEach(({ replacement, metric }, replacementIndex) => {
    countProviderMetric(stats, metric);
    if (replacement) {
      next[requestTargets[replacementIndex].index] = replacement;
    }
  });
  const state = getProviderCandleRateLimitState(params.exchange);
  stats.cooldownUntil = state.cooldownUntil > Date.now() ? state.cooldownUntil : null;
  if (deferredTargets.length > 0) {
    scheduleSparklineWarmup({
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      items: deferredTargets.map((target) => target.result.item),
      reason: 'ticker_top_volume',
    });
  }
  stats.budgetExhausted = stats.budgetExhausted || Date.now() >= deadlineAt;
  return { attached: next, stats };
}

function preparedSparklineKey(
  exchange: ContractExchange,
  quoteCurrency: ContractQuoteCurrency,
  marketId: string,
) {
  return `${exchange}:${quoteCurrency}:${marketId.toUpperCase()}`;
}

function isDisplayableRealSparkline(item: ContractSparklineItem) {
  return item.realSeries
    && item.graphDisplayAllowed
    && !item.isDerived
    && item.pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
    && item.diagnostics.uniqueValueCount >= 3
    && item.diagnostics.valueRange > 0
    && !item.diagnostics.isLinearDerived;
}

function resolveProviderMarket(exchange: ContractExchange, symbol: string, quoteCurrency: ContractQuoteCurrency) {
  switch (exchange) {
    case 'binance':
      return `${symbol.toUpperCase()}${quoteCurrency}`;
    case 'coinone':
      return symbol.toUpperCase();
    case 'korbit':
      return `${symbol.toLowerCase()}_${quoteCurrency.toLowerCase()}`;
    case 'upbit':
    case 'bithumb':
      return `${quoteCurrency}-${symbol.toUpperCase()}`;
  }
}

function withSparklineDecision(
  item: ContractSparklineItem,
  decision: SparklineItemDecision,
  extra: Partial<SparklineSeriesDiagnostics> = {},
) {
  return {
    ...item,
    stale: extra.stale ?? item.stale,
    diagnostics: {
      ...item.diagnostics,
      decision,
      ...extra,
    },
  };
}

function withCacheDiagnostics(
  item: ContractSparklineItem,
  params: {
    cacheKey: string;
    cacheWriteDecision?: SparklineCacheWriteDecision | null;
    previousQuality?: SparklineQuality | null;
    newQuality?: SparklineQuality | null;
  },
) {
  return {
    ...item,
    diagnostics: {
      ...item.diagnostics,
      cacheKey: params.cacheKey,
      cacheWriteDecision: params.cacheWriteDecision ?? item.diagnostics.cacheWriteDecision ?? null,
      previousQuality: params.previousQuality ?? item.diagnostics.previousQuality ?? null,
      newQuality: params.newQuality ?? item.diagnostics.newQuality ?? item.quality,
    },
  };
}

function logSparklineItemDecision(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  item: ContractSparklineItem;
  elapsedMs: number;
  reason: string | null;
}) {
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      marketId: params.item.marketId,
      cacheKey: params.item.diagnostics.cacheKey,
      decision: params.item.diagnostics.decision,
      pointCount: params.item.pointCount,
      quality: params.item.quality,
      realSeries: params.item.realSeries,
      graphDisplayAllowed: params.item.graphDisplayAllowed,
      elapsedMs: params.elapsedMs,
      reason: params.reason,
    },
    `[SparklineItemDecision] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${params.item.marketId} cacheKey=${params.item.diagnostics.cacheKey ?? ''} decision=${params.item.diagnostics.decision ?? ''} pointCount=${params.item.pointCount} quality=${params.item.quality} realSeries=${params.item.realSeries} graphDisplayAllowed=${params.item.graphDisplayAllowed} elapsedMs=${params.elapsedMs} reason=${params.reason ?? ''}`,
  );
}

function sparklineQualityRank(item: ContractSparklineItem | null) {
  if (!item) {
    return 0;
  }
  if (!item.realSeries || item.isDerived || !item.graphDisplayAllowed) {
    return isQualityDisplayBlocked(item.quality) ? 5 : 10;
  }
  if (item.quality === 'provider_candle_1m' && item.pointCount >= item.requestedLimit) {
    return 100;
  }
  if ((item.quality === 'prepared_cache' || item.quality === 'prepared_cache_real') && item.pointCount >= item.requestedLimit) {
    return 90;
  }
  if (item.quality === 'provider_partial_real' || item.quality === 'provider_mini_real') {
    return 80;
  }
  if (item.quality === 'cache_partial_real') {
    return 75;
  }
  if (item.quality === 'live_buffer_partial' || item.quality === 'refined_mini_real' || item.quality === 'prepared_cache') {
    return 70;
  }
  if (item.stale || item.quality === 'cache_stale_real' || item.quality === 'refined_mini' || item.quality === 'provider_mini') {
    return 60;
  }
  return 20;
}

function writeRealSparklineCache(key: string, item: ContractSparklineItem) {
  const normalized = withCacheDiagnostics(normalizeSparklineQuality(item), {
    cacheKey: key,
    newQuality: item.quality,
  });
  const previous = marketSparklineFastCache.get(key)?.item ?? lastKnownGoodSparklineCache.get(key) ?? null;
  const previousQuality = previous?.quality ?? null;
  const newQuality = normalized.quality;
  const previousRank = sparklineQualityRank(previous);
  const newRank = sparklineQualityRank(normalized);

  let decision: SparklineCacheWriteDecision = 'write';
  let reason = 'real_graph_cache_write';
  if (!isDisplayableRealSparkline(normalized)) {
    decision = 'skip_low_quality';
    reason = 'new_item_not_displayable_real';
  } else if (
    previous
    && isDisplayableRealSparkline(previous)
    && (previousRank > newRank || (previousRank === newRank && previous.pointCount > normalized.pointCount))
  ) {
    decision = 'skip_keep_better';
    reason = 'existing_real_graph_has_higher_quality';
  }

  const result = withCacheDiagnostics(normalized, {
    cacheKey: key,
    cacheWriteDecision: decision,
    previousQuality,
    newQuality,
  });
  logger.info(
    {
      domain: 'market-contract',
      cacheKey: key,
      previousQuality,
      newQuality,
      previousPointCount: previous?.pointCount ?? 0,
      newPointCount: result.pointCount,
      decision,
      reason,
    },
    `[SparklineCacheWriteDecision] cacheKey=${key} previousQuality=${previousQuality ?? ''} newQuality=${newQuality} previousPointCount=${previous?.pointCount ?? 0} newPointCount=${result.pointCount} decision=${decision} reason=${reason}`,
  );
  if (decision !== 'write') {
    return result;
  }
  const now = Date.now();
  const ttl = result.pointCount >= result.requestedLimit ? SPARKLINE_FULL_REAL_TTL_MS : SPARKLINE_PARTIAL_REAL_TTL_MS;
  marketSparklineFastCache.set(key, {
    item: result,
    savedAt: now,
    expiresAt: now + ttl,
    staleUntil: now + PREPARED_SPARKLINE_USABLE_STALE_MS,
  });
  lastKnownGoodSparklineCache.set(key, result);
  return result;
}

function readCachedSparklineItem(key: string, allowStale = true) {
  const cached = marketSparklineFastCache.get(key);
  if (!cached) {
    return null;
  }
  const now = Date.now();
  if (cached.expiresAt <= now && (!allowStale || cached.staleUntil <= now)) {
    marketSparklineFastCache.delete(key);
    return null;
  }
  const stale = cached.expiresAt <= now;
  const cacheAgeMs = Math.max(now - cached.savedAt, 0);
  const cacheQuality: SparklineQuality = stale
    ? 'cache_stale_real'
    : cached.item.pointCount < cached.item.requestedLimit
      ? 'cache_partial_real'
      : cached.item.quality;
  return normalizeSparklineQuality({
    ...cached.item,
    quality: cacheQuality,
    sparklineQuality: cacheQuality,
    stale,
    diagnostics: {
      ...cached.item.diagnostics,
      cacheKey: key,
      cacheHit: true,
      cacheAgeMs,
      stale,
      fallbackReason: stale ? 'stale_cache' : cached.item.diagnostics.fallbackReason,
      resolvedBy: 'sparkline_cache',
    },
  });
}

function withProviderDiagnostics(item: ContractSparklineItem, params: {
  providerLatencyMs: number;
  providerTimeout?: boolean;
  partialReason?: string | null;
  fallbackReason?: string | null;
}) {
  return normalizeSparklineQuality({
    ...item,
    diagnostics: {
      ...item.diagnostics,
      provider: item.exchange,
      providerFetched: true,
      providerLatencyMs: params.providerLatencyMs,
      providerTimeout: params.providerTimeout ?? false,
      partialReason: params.partialReason ?? item.diagnostics.partialReason,
      fallbackReason: params.fallbackReason ?? item.diagnostics.fallbackReason,
    },
  });
}

function timeoutAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function mapBounded<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

function appendPreparedSparklineSample(item: MarketTickerItem) {
  if (item.currentPrice === null || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0) {
    return;
  }
  const parsedMarket = getAdapter(item.exchange).parseMarket(item.marketId);
  if (
    !parsedMarket
    || parsedMarket.quoteCurrency !== item.quoteCurrency
    || parsedMarket.symbol !== item.symbol
    || !item.displayPair.endsWith(`/${item.quoteCurrency}`)
  ) {
    logger.warn(
      {
        domain: 'market-contract',
        exchange: item.exchange,
        quoteCurrency: item.quoteCurrency,
        marketId: item.marketId,
        symbol: item.symbol,
        displayPair: item.displayPair,
        reason: 'inconsistent_ticker_buffer_key_fields',
      },
      `[SparklineBufferSkip] exchange=${item.exchange} quoteCurrency=${item.quoteCurrency} marketId=${item.marketId} reason=inconsistent_ticker_buffer_key_fields`,
    );
    return;
  }
  const key = preparedSparklineKey(item.exchange, item.quoteCurrency, item.marketId);
  const existing = preparedSparklineCache.get(key) ?? [];
  let timestamp = Date.now();
  const last = existing[existing.length - 1];
  if (last && last.timestamp >= timestamp) {
    timestamp = last.timestamp + 1;
  }
  const next = [...existing, { price: item.currentPrice, timestamp }]
    .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-TICKER_RING_BUFFER_MAX_POINTS);
  preparedSparklineCache.set(key, next);
  logger.info(
    {
      domain: 'market-contract',
      exchange: item.exchange,
      quoteCurrency: item.quoteCurrency,
      marketId: item.marketId,
      bufferKey: key,
      price: item.currentPrice,
      bufferPointCount: next.length,
    },
    `[SparklineBufferAppend] exchange=${item.exchange} quoteCurrency=${item.quoteCurrency} marketId=${item.marketId} bufferKey=${key} price=${item.currentPrice} bufferPointCount=${next.length}`,
  );
}

function sampleSparklinePoints(points: Array<{ price: number; timestamp: number }>, limit: number) {
  if (points.length <= limit) {
    return points;
  }
  return points.slice(-limit);
}

function toContractSparklinePoint(point: { price?: number; value?: number; timestamp: number }): ContractSparklinePoint {
  const price = point.price ?? point.value ?? 0;
  return {
    price,
    value: point.value ?? price,
    timestamp: point.timestamp,
  };
}

function normalizeSparklinePoints(points: Array<{ price?: number; value?: number; timestamp: number }>) {
  const byTimestamp = new Map<number, ContractSparklinePoint>();
  let invalidPointCount = 0;
  let duplicateTimestampCount = 0;
  for (const point of points) {
    const normalized = toContractSparklinePoint(point);
    if (
      !Number.isFinite(normalized.price)
      || !Number.isFinite(normalized.timestamp)
      || normalized.price <= 0
      || normalized.timestamp <= 0
    ) {
      invalidPointCount += 1;
      continue;
    }
    if (byTimestamp.has(normalized.timestamp)) {
      duplicateTimestampCount += 1;
    }
    byTimestamp.set(normalized.timestamp, normalized);
  }
  return {
    points: Array.from(byTimestamp.values()).sort((left, right) => left.timestamp - right.timestamp),
    invalidPointCount,
    duplicateTimestampCount,
  };
}

function roundMetric(value: number, digits = 10) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function recommendedDisplayScaleForRangeRatio(rangeRatio: number) {
  if (rangeRatio < 0.002) return 0.25;
  if (rangeRatio < 0.005) return 0.40;
  if (rangeRatio < 0.015) return 0.60;
  return 0.80;
}

function volatilityHintForRangeRatio(rangeRatio: number): SparklineSeriesDiagnostics['volatilityHint'] {
  if (rangeRatio <= 0) return 'flat';
  if (rangeRatio < 0.005) return 'low';
  if (rangeRatio < 0.015) return 'medium';
  return 'high';
}

function isQualityDisplayBlocked(quality: SparklineQuality) {
  return quality === 'derived_preview'
    || quality === 'derived_interpolated'
    || quality === 'unavailable'
    || quality === 'insufficient_points'
    || quality === 'placeholder'
    || quality === 'flat_current'
    || quality === 'insufficient_variation';
}

function computeSparklineDiagnostics(params: {
  rawPoints: Array<{ price?: number; value?: number; timestamp: number }>;
  points: ContractSparklinePoint[];
  duplicateTimestampCount: number;
  source: ContractSparklineItem['source'];
  quality: SparklineQuality;
  isDerived: boolean;
  requestedLimit?: number;
  decision?: SparklineItemDecision | null;
  provider?: ContractExchange | null;
  providerMarket?: string | null;
  cacheKey?: string | null;
  cacheHit?: boolean;
  cacheAgeMs?: number | null;
  cacheWriteDecision?: SparklineCacheWriteDecision | null;
  previousQuality?: SparklineQuality | null;
  newQuality?: SparklineQuality | null;
  stale?: boolean;
  ringBufferHit?: boolean;
  providerFetched?: boolean;
  providerLatencyMs?: number | null;
  providerTimeout?: boolean;
  providerError?: string | null;
  partialReason?: string | null;
  fallbackReason?: string | null;
  resolvedBy?: string | null;
}): SparklineSeriesDiagnostics {
  const values = params.points.map((point) => point.value);
  const pointCount = values.length;
  const uniqueValueCount = new Set(values.map((value) => roundMetric(value, 8))).size;
  const minValue = pointCount > 0 ? Math.min(...values) : null;
  const maxValue = pointCount > 0 ? Math.max(...values) : null;
  const firstValue = values[0] ?? null;
  const lastValue = values[values.length - 1] ?? null;
  const valueRange = minValue !== null && maxValue !== null ? maxValue - minValue : 0;
  const meanValue = pointCount > 0 ? values.reduce((sum, value) => sum + value, 0) / pointCount : null;
  const average = meanValue ?? 0;
  const denominator = Math.abs(average) || 1;
  const rangeRatio = valueRange / denominator;
  const firstLastChangeRatio = firstValue !== null && lastValue !== null && Math.abs(firstValue) > 0
    ? Math.abs(lastValue - firstValue) / Math.abs(firstValue)
    : 0;
  let zeroDeltaCount = 0;
  let directionChanges = 0;
  let previousSign = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta === 0) {
      zeroDeltaCount += 1;
      continue;
    }
    const sign = delta > 0 ? 1 : -1;
    if (previousSign !== 0 && sign !== previousSign) {
      directionChanges += 1;
    }
    previousSign = sign;
  }

  let maxDeviation = 0;
  if (pointCount >= 3 && firstValue !== null && lastValue !== null) {
    for (let index = 0; index < values.length; index += 1) {
      const expected = firstValue + ((lastValue - firstValue) * index) / (pointCount - 1);
      maxDeviation = Math.max(maxDeviation, Math.abs(values[index] - expected));
    }
  }
  const straightnessScore = pointCount < 3
    ? 0
    : valueRange === 0
      ? 1
      : Math.max(0, Math.min(1, 1 - maxDeviation / valueRange));
  const linearityScore = straightnessScore;
  const isFlat = pointCount > 0 && (valueRange === 0 || uniqueValueCount <= 1 || rangeRatio < 1e-10);
  const derivedLikeSource = params.isDerived
    || params.source === 'derived_change24h'
    || params.source === 'derived_interpolated'
    || params.quality === 'derived_preview'
    || params.quality === 'derived_interpolated';
  const isLinearDerived = pointCount >= 20
    && uniqueValueCount <= 2
      ? true
      : pointCount >= 20 && directionChanges === 0 && straightnessScore >= 0.995 && derivedLikeSource;
  const highQuality = params.quality === 'provider_candle_1m'
    || params.quality === 'provider_partial_real'
    || params.quality === 'provider_mini_real'
    || params.quality === 'cache_partial_real'
    || params.quality === 'cache_stale_real'
    || params.quality === 'prepared_cache_real'
    || params.quality === 'refined_mini_real'
    || params.quality === 'live_buffer_partial'
    || params.quality === 'prepared_cache'
    || params.quality === 'refined_mini'
    || params.quality === 'provider_mini';
  const realSeries = highQuality
    && !params.isDerived
    && pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
    && uniqueValueCount >= 3
    && valueRange > 0
    && !isFlat
    && !isLinearDerived;
  const requestedLimit = params.requestedLimit ?? SPARKLINE_LIMIT_MAX;
  const partial = pointCount > 0 && pointCount < requestedLimit;
  const coverageRatio = requestedLimit > 0 ? pointCount / requestedLimit : 0;
  const partialDisplayAllowed = (params.quality === 'live_buffer_partial' || params.quality === 'provider_partial_real' || params.quality === 'cache_partial_real' || params.quality === 'cache_stale_real')
    && pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
    && uniqueValueCount >= 3;
  const graphDisplayAllowed = realSeries
    && !params.isDerived
    && !isQualityDisplayBlocked(params.quality)
    && uniqueValueCount >= 3
    && valueRange > 0
    && !isFlat
    && !isLinearDerived
    && (pointCount >= Math.min(30, requestedLimit) || partialDisplayAllowed);
  const graphDisplayAllowedReason = graphDisplayAllowed
    ? partial ? 'partial_real_series' : 'real_series_ready'
    : params.isDerived || isQualityDisplayBlocked(params.quality)
      ? 'derived_or_unavailable_quality'
      : pointCount < PREPARED_SPARKLINE_REFINED_MIN_POINTS
        ? 'insufficient_point_count'
        : uniqueValueCount < 3 || valueRange <= 0 || isFlat
          ? 'insufficient_variation'
          : isLinearDerived
            ? 'linear_derived_detected'
            : 'not_real_series';
  const recommendedDisplayScale = recommendedDisplayScaleForRangeRatio(rangeRatio);
  const volatilityHint = volatilityHintForRangeRatio(rangeRatio);

  return {
    decision: params.decision ?? null,
    requestedLimit,
    pointCount,
    provider: params.provider ?? null,
    providerMarket: params.providerMarket ?? null,
    cacheKey: params.cacheKey ?? null,
    cacheHit: params.cacheHit ?? false,
    cacheAgeMs: params.cacheAgeMs ?? null,
    cacheWriteDecision: params.cacheWriteDecision ?? null,
    previousQuality: params.previousQuality ?? null,
    newQuality: params.newQuality ?? params.quality,
    stale: params.stale ?? false,
    ringBufferHit: params.ringBufferHit ?? false,
    providerFetched: params.providerFetched ?? false,
    providerLatencyMs: params.providerLatencyMs ?? null,
    providerTimeout: params.providerTimeout ?? false,
    providerError: params.providerError ?? null,
    partial,
    partialReason: params.partialReason ?? (partial ? 'buffer_warming' : null),
    coverageRatio,
    uniqueValueCount,
    minValue,
    maxValue,
    meanValue,
    firstValue,
    lastValue,
    valueRange,
    rangeRatio,
    firstLastChangeRatio,
    directionChanges,
    zeroDeltaCount,
    duplicateTimestampCount: params.duplicateTimestampCount,
    linearityScore,
    straightnessScore,
    isFlat,
    isLinearDerived,
    realSeries,
    graphDisplayAllowed,
    graphDisplayAllowedReason,
    recommendedDisplayScale,
    volatilityHint,
    fallbackReason: params.fallbackReason ?? null,
    resolvedBy: params.resolvedBy ?? null,
  };
}

function normalizeSparklineQuality(item: ContractSparklineItem): ContractSparklineItem {
  const beforeQuality = item.quality;
  const normalized = normalizeSparklinePoints(item.points);
  const points = normalized.points;
  const pointCount = points.length;
  let quality = item.quality;
  let reason: string | null = null;

  if (pointCount === 0) {
    quality = item.source === 'unavailable' ? 'unavailable' : 'placeholder';
    reason = 'no_valid_points';
  } else if (
    pointCount <= 6
    && (quality === 'prepared_cache' || quality === 'refined_mini' || quality === 'provider_mini' || quality === 'provider_partial_real')
  ) {
    quality = 'derived_preview';
    reason = 'insufficient_points_for_prepared_cache';
  } else if (
    item.isDerived
    && (quality === 'prepared_cache' || quality === 'refined_mini' || quality === 'provider_mini' || quality === 'provider_partial_real')
  ) {
    quality = 'derived_preview';
    reason = 'derived_item_cannot_use_prepared_quality';
  } else if (
    pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
    && item.source === 'prepared_cache'
    && (quality === 'derived_preview' || quality === 'placeholder')
  ) {
    quality = pointCount >= Math.min(item.requestedLimit, SPARKLINE_LIMIT_MAX)
      ? 'prepared_cache'
      : 'live_buffer_partial';
    reason = quality === 'prepared_cache' ? 'prepared_buffer_ready' : 'partial_ring_buffer';
  }

  let isDerived = quality === 'derived_preview' || quality === 'derived_interpolated'
    ? true
    : quality === 'prepared_cache' || quality === 'live_buffer_partial' || quality === 'cache_partial_real' || quality === 'cache_stale_real' || quality === 'refined_mini' || quality === 'provider_mini' || quality === 'provider_candle_1m' || quality === 'provider_partial_real'
      ? false
      : item.source === 'derived_change24h';
  let diagnostics = computeSparklineDiagnostics({
    rawPoints: item.points,
    points,
    duplicateTimestampCount: normalized.duplicateTimestampCount,
    source: item.source,
    quality,
    isDerived,
    requestedLimit: item.requestedLimit,
    decision: item.diagnostics?.decision,
    provider: item.diagnostics?.provider ?? (item.source === 'provider_candle_1m' ? item.exchange : null),
    providerMarket: item.diagnostics?.providerMarket,
    cacheKey: item.diagnostics?.cacheKey,
    cacheHit: item.diagnostics?.cacheHit,
    cacheAgeMs: item.diagnostics?.cacheAgeMs,
    cacheWriteDecision: item.diagnostics?.cacheWriteDecision,
    previousQuality: item.diagnostics?.previousQuality,
    newQuality: item.diagnostics?.newQuality ?? quality,
    stale: item.stale || item.diagnostics?.stale,
    ringBufferHit: item.diagnostics?.ringBufferHit,
    providerFetched: item.diagnostics?.providerFetched,
    providerLatencyMs: item.diagnostics?.providerLatencyMs,
    providerTimeout: item.diagnostics?.providerTimeout,
    partialReason: item.diagnostics?.partialReason,
    fallbackReason: reason ?? item.diagnostics?.fallbackReason ?? item.sourceReason ?? null,
    resolvedBy: item.diagnostics?.resolvedBy ?? item.source,
  });

  if (
    pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
    && (quality === 'prepared_cache' || quality === 'live_buffer_partial' || quality === 'cache_partial_real' || quality === 'cache_stale_real' || quality === 'refined_mini' || quality === 'provider_mini' || quality === 'provider_candle_1m' || quality === 'provider_partial_real')
    && !diagnostics.realSeries
  ) {
    if (diagnostics.isFlat || diagnostics.uniqueValueCount < 3 || diagnostics.valueRange === 0) {
      quality = 'insufficient_variation';
      reason = 'insufficient_variation';
    } else if (diagnostics.isLinearDerived) {
      quality = item.isDerived ? 'derived_interpolated' : 'insufficient_variation';
      reason = 'linear_series_detected';
    }
    isDerived = quality === 'derived_interpolated' ? true : isDerived;
    diagnostics = computeSparklineDiagnostics({
      rawPoints: item.points,
      points,
      duplicateTimestampCount: normalized.duplicateTimestampCount,
      source: item.source,
      quality,
      isDerived,
      requestedLimit: item.requestedLimit,
      decision: item.diagnostics?.decision,
      provider: item.diagnostics?.provider ?? (item.source === 'provider_candle_1m' ? item.exchange : null),
      providerMarket: item.diagnostics?.providerMarket,
      cacheKey: item.diagnostics?.cacheKey,
      cacheHit: item.diagnostics?.cacheHit,
      cacheAgeMs: item.diagnostics?.cacheAgeMs,
      cacheWriteDecision: item.diagnostics?.cacheWriteDecision,
      previousQuality: item.diagnostics?.previousQuality,
      newQuality: item.diagnostics?.newQuality ?? quality,
      stale: item.stale || item.diagnostics?.stale,
      ringBufferHit: item.diagnostics?.ringBufferHit,
      providerFetched: item.diagnostics?.providerFetched,
      providerLatencyMs: item.diagnostics?.providerLatencyMs,
      providerTimeout: item.diagnostics?.providerTimeout,
      partialReason: item.diagnostics?.partialReason,
      fallbackReason: reason ?? item.diagnostics?.fallbackReason ?? item.sourceReason ?? null,
      resolvedBy: item.diagnostics?.resolvedBy ?? item.source,
    });
  }

  const updatedAt = points[points.length - 1]?.timestamp ?? item.updatedAt;
  const next = {
    ...item,
    points,
    sparkline: points.map((point) => point.value),
    sparklinePoints: points,
    quality,
    sparklineQuality: quality,
    sparklinePointCount: pointCount,
    isRenderable: diagnostics.graphDisplayAllowed,
    graphDisplayAllowed: diagnostics.graphDisplayAllowed,
    recommendedDisplayScale: diagnostics.recommendedDisplayScale,
    volatilityHint: diagnostics.volatilityHint,
    isDerived,
    sparklineIsDerived: isDerived,
    realSeries: diagnostics.realSeries,
    partial: diagnostics.partial,
    pointCount,
    updatedAt,
    from: points[0]?.timestamp ?? null,
    to: points[points.length - 1]?.timestamp ?? null,
    sourceReason: reason ?? item.sourceReason,
    invalidPointCount: normalized.invalidPointCount,
    diagnostics,
  };

  const qualityNormalizeReason = reason ?? (diagnostics.realSeries ? 'invalid_points_removed' : 'not_real_series');
  if (beforeQuality !== quality || normalized.invalidPointCount > 0 || !diagnostics.realSeries) {
    const qualityNormalizeMessage = [
      '[SparklineQualityNormalize]',
      `exchange=${item.exchange}`,
      `quoteCurrency=${item.quoteCurrency}`,
      `marketId=${item.marketId}`,
      `oldQuality=${beforeQuality}`,
      `newQuality=${quality}`,
      `pointCount=${pointCount}`,
      `uniqueValueCount=${diagnostics.uniqueValueCount}`,
      `rangeRatio=${diagnostics.rangeRatio}`,
      `directionChanges=${diagnostics.directionChanges}`,
      `isFlat=${diagnostics.isFlat}`,
      `isLinearDerived=${diagnostics.isLinearDerived}`,
      `realSeries=${diagnostics.realSeries}`,
      `graphDisplayAllowed=${diagnostics.graphDisplayAllowed}`,
      `recommendedDisplayScale=${diagnostics.recommendedDisplayScale}`,
      `reason=${qualityNormalizeReason}`,
    ].join(' ');
    logger.info(
      {
        domain: 'market-contract',
        exchange: item.exchange,
        quoteCurrency: item.quoteCurrency,
        marketId: item.marketId,
        oldQuality: beforeQuality,
        newQuality: quality,
        pointCount,
        uniqueValueCount: diagnostics.uniqueValueCount,
        rangeRatio: diagnostics.rangeRatio,
        directionChanges: diagnostics.directionChanges,
        isFlat: diagnostics.isFlat,
        isLinearDerived: diagnostics.isLinearDerived,
        realSeries: diagnostics.realSeries,
        graphDisplayAllowed: diagnostics.graphDisplayAllowed,
        recommendedDisplayScale: diagnostics.recommendedDisplayScale,
        invalidPointCount: normalized.invalidPointCount,
        reason: qualityNormalizeReason,
      },
      qualityNormalizeMessage,
    );
  }

  return next;
}

function buildPreparedSparklineItem(params: {
  item: MarketTickerItem;
  points: Array<{ price: number; timestamp: number }>;
  limit: number;
  interval: ContractTimeframe;
  source: 'prepared_cache' | 'last_known_good';
  sourceReason: string;
  stale?: boolean;
}): ContractSparklineItem | null {
  if (params.points.length < PREPARED_SPARKLINE_REFINED_MIN_POINTS) {
    return null;
  }
  const points = sampleSparklinePoints(params.points, params.limit);
  if (points.length < PREPARED_SPARKLINE_REFINED_MIN_POINTS) {
    return null;
  }
  const updatedAt = points[points.length - 1]?.timestamp ?? null;
  const stale = params.stale ?? (updatedAt !== null && Date.now() - updatedAt > PREPARED_SPARKLINE_STALE_MS);
  const quality: SparklineQuality = points.length >= params.limit ? 'prepared_cache' : 'live_buffer_partial';
  const contractPoints = points.map(toContractSparklinePoint);
  const diagnostics = computeSparklineDiagnostics({
    rawPoints: contractPoints,
    points: contractPoints,
    duplicateTimestampCount: 0,
    source: params.source,
    quality,
    isDerived: false,
    requestedLimit: params.limit,
    stale,
    ringBufferHit: true,
    partialReason: quality === 'live_buffer_partial' ? 'buffer_warming' : null,
    fallbackReason: params.sourceReason,
    resolvedBy: 'ring_buffer',
  });
  return {
    exchange: params.item.exchange,
    symbol: params.item.symbol,
    marketId: params.item.marketId,
    canonicalMarketId: params.item.canonicalMarketId ?? params.item.marketId,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    displayPair: params.item.displayPair,
    points: contractPoints,
    sparkline: contractPoints.map((point) => point.value),
    sparklinePoints: contractPoints,
    source: params.source,
    sparklineSource: params.source,
    quality,
    sparklineQuality: quality,
    sparklinePointCount: points.length,
    isRenderable: diagnostics.graphDisplayAllowed,
    graphDisplayAllowed: diagnostics.graphDisplayAllowed,
    recommendedDisplayScale: diagnostics.recommendedDisplayScale,
    volatilityHint: diagnostics.volatilityHint,
    isDerived: false,
    sparklineIsDerived: false,
    realSeries: diagnostics.realSeries,
    partial: diagnostics.partial,
    pointCount: points.length,
    stale,
    updatedAt,
    interval: params.interval,
    requestedLimit: params.limit,
    from: points[0]?.timestamp ?? null,
    to: updatedAt,
    generatedAt: new Date().toISOString(),
    sourceReason: params.sourceReason,
    unavailableReason: null,
    diagnostics,
  };
}

function buildFallbackSparklineItem(item: MarketTickerItem, limit: number, interval: ContractTimeframe): ContractSparklineItem {
  if (
    item.sparklineSource === 'previous_snapshot'
    && (item.sparklineIsDerived || item.sparklineQuality === 'fallbackListSparkline')
  ) {
    return buildUnavailableSparklineItem({
      item,
      limit,
      interval,
      fallbackReason: item.sparklineUnavailableReason ?? 'list_fallback_not_detailed_series',
    });
  }
  const points = sampleSparklinePoints(item.sparklinePoints, limit).map(toContractSparklinePoint);
  const pointCount = points.length;
  const quality = item.sparklineSource === 'unavailable'
    ? 'unavailable'
    : resolveSparklineQuality(item.sparklineSource, pointCount);
  const isDerived = item.sparklineSource === 'derived_change24h';
  const diagnostics = computeSparklineDiagnostics({
    rawPoints: points,
    points,
    duplicateTimestampCount: 0,
    source: item.sparklineSource,
    quality,
    isDerived,
    requestedLimit: limit,
    partialReason: null,
    fallbackReason: item.sparklineSource === 'previous_snapshot'
      ? 'list_previous_snapshot_fallback'
      : item.sparklineSource === 'ticker_ring_buffer'
        ? 'ticker_ring_buffer_fallback'
        : item.sparklineSource === 'derived_change24h'
      ? 'fallback_current_price_change_rate_24h'
      : item.sparklineSource === 'flat_current'
        ? 'fallback_current_price_only'
        : item.sparklineSource === 'unavailable'
          ? 'no_renderable_price'
          : 'provider_or_cache_ticker_sparkline',
    resolvedBy: 'ticker_preview',
  });
  return {
    exchange: item.exchange,
    symbol: item.symbol,
    marketId: item.marketId,
    canonicalMarketId: item.canonicalMarketId ?? item.marketId,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency,
    displayPair: item.displayPair,
    points,
    sparkline: points.map((point) => point.value),
    sparklinePoints: points,
    source: item.sparklineSource,
    sparklineSource: item.sparklineSource,
    quality,
    sparklineQuality: quality,
    sparklinePointCount: pointCount,
    isRenderable: diagnostics.graphDisplayAllowed,
    graphDisplayAllowed: diagnostics.graphDisplayAllowed,
    recommendedDisplayScale: diagnostics.recommendedDisplayScale,
    volatilityHint: diagnostics.volatilityHint,
    isDerived,
    sparklineIsDerived: isDerived,
    realSeries: diagnostics.realSeries,
    partial: diagnostics.partial,
    pointCount,
    stale: item.stale,
    updatedAt: points[points.length - 1]?.timestamp ?? item.sourceTimestamp ?? null,
    interval,
    requestedLimit: limit,
    from: points[0]?.timestamp ?? null,
    to: points[points.length - 1]?.timestamp ?? item.sourceTimestamp ?? null,
    generatedAt: new Date().toISOString(),
    sourceReason: item.sparklineSource === 'previous_snapshot'
      ? 'list_previous_snapshot_fallback'
      : item.sparklineSource === 'ticker_ring_buffer'
        ? 'ticker_ring_buffer_fallback'
        : item.sparklineSource === 'derived_change24h'
      ? 'fallback_current_price_change_rate_24h'
      : item.sparklineSource === 'flat_current'
        ? 'fallback_current_price_only'
        : item.sparklineSource === 'unavailable'
          ? 'no_renderable_price'
          : 'provider_or_cache_ticker_sparkline',
    unavailableReason: pointCount >= 2 ? null : item.sparklineUnavailableReason ?? 'insufficient_points',
    diagnostics,
  };
}

function buildUnavailableSparklineItem(params: {
  item: MarketTickerItem;
  limit: number;
  interval: ContractTimeframe;
  fallbackReason: string;
  providerFetched?: boolean;
  providerLatencyMs?: number | null;
  providerTimeout?: boolean;
}): ContractSparklineItem {
  const diagnostics = computeSparklineDiagnostics({
    rawPoints: [],
    points: [],
    duplicateTimestampCount: 0,
    source: 'unavailable',
    quality: 'unavailable',
    isDerived: false,
    requestedLimit: params.limit,
    provider: params.item.exchange,
    providerFetched: params.providerFetched ?? false,
    providerLatencyMs: params.providerLatencyMs ?? null,
    providerTimeout: params.providerTimeout ?? false,
    fallbackReason: params.fallbackReason,
    resolvedBy: 'unavailable',
  });
  return {
    exchange: params.item.exchange,
    symbol: params.item.symbol,
    marketId: params.item.marketId,
    canonicalMarketId: params.item.canonicalMarketId ?? params.item.marketId,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    displayPair: params.item.displayPair,
    points: [],
    sparkline: [],
    sparklinePoints: [],
    source: 'unavailable',
    sparklineSource: 'unavailable',
    quality: 'unavailable',
    sparklineQuality: 'unavailable',
    sparklinePointCount: 0,
    isRenderable: false,
    graphDisplayAllowed: false,
    recommendedDisplayScale: diagnostics.recommendedDisplayScale,
    volatilityHint: diagnostics.volatilityHint,
    isDerived: false,
    sparklineIsDerived: false,
    realSeries: false,
    partial: false,
    pointCount: 0,
    stale: false,
    updatedAt: null,
    interval: params.interval,
    requestedLimit: params.limit,
    from: null,
    to: null,
    generatedAt: new Date().toISOString(),
    sourceReason: params.fallbackReason,
    unavailableReason: params.fallbackReason,
    diagnostics,
  };
}

function buildSyntheticTickerForSparkline(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  symbol: string;
  marketId: string;
}): MarketTickerItem {
  const symbol = params.symbol.toUpperCase();
  const displayPair = `${symbol}/${params.quoteCurrency}`;
  return {
    exchange: params.exchange,
    exchangeName: getMarketExchangeContract(params.exchange).displayName,
    market: params.marketId,
    marketId: params.marketId,
    canonicalMarketId: params.marketId,
    originalMarketId: params.marketId,
    exchangeSymbol: params.marketId,
    rawSymbol: params.marketId,
    symbol,
    baseCurrency: symbol,
    displaySymbol: displayPair,
    displayPair,
    displayName: symbol,
    quoteCurrency: params.quoteCurrency,
    koreanName: symbol,
    englishName: symbol,
    currentPrice: null,
    current: null,
    price: null,
    tradePrice: null,
    changeRate24h: null,
    change24h: null,
    percent: null,
    changeRate: null,
    signedChangeRate: null,
    signedChangePrice24h: 0,
    changePrice: 0,
    signedChangePrice: 0,
    accTradePrice24h: 0,
    value: 0,
    accTradeVolume24h: 0,
    volume: 0,
    volume24h: 0,
    high24h: 0,
    low24h: 0,
    previousPrice24h: null,
    timestamp: Date.now(),
    sourceTimestamp: Date.now(),
    stale: false,
    updatedAt: new Date().toISOString(),
    sparkline: [],
    sparklinePoints: [],
    sparklineSource: 'unavailable',
    sparklineQuality: 'unavailable',
    sparklinePointCount: 0,
    sparklineIsDerived: false,
    sparklineUpdatedAt: null,
    sparklineSourceVersion: null,
    sparklinePointsHash: hashSparklinePoints([]),
    sparklineTimeframe: LIST_SPARKLINE_DEFAULT_TIMEFRAME,
    sparklineSourceUpdatedAt: null,
    sparklineUniquePriceCount: 0,
    sparklineUnavailableReason: 'synthetic_ticker_without_price',
    graphDisplayAllowed: false,
    previewGraphQuality: 'unavailable',
    previewGraphIsDerived: false,
    previewGraphPointCount: 0,
    previewGraphRealSeries: false,
    previewGraphDisplayAllowed: false,
  };
}

function buildProviderCandleSparklineItem(params: {
  item: MarketTickerItem;
  candles: MarketCandle[];
  limit: number;
  interval: ContractTimeframe;
}): ContractSparklineItem | null {
  const points = params.candles
    .map((candle) => ({
      price: candle.close,
      value: candle.close,
      timestamp: Date.parse(candle.timestamp),
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0 && Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-params.limit)
    .map(toContractSparklinePoint);
  if (points.length < PREPARED_SPARKLINE_REFINED_MIN_POINTS) {
    return null;
  }
  const quality: SparklineQuality = points.length >= params.limit
    ? params.interval === '1M' ? 'provider_candle_1m' : 'provider_mini'
    : 'provider_partial_real';
  const diagnostics = computeSparklineDiagnostics({
    rawPoints: points,
    points,
    duplicateTimestampCount: 0,
    source: 'provider_candle_1m',
    quality,
    isDerived: false,
    requestedLimit: params.limit,
    provider: params.item.exchange,
    providerFetched: true,
    partialReason: quality === 'provider_partial_real' ? 'provider_partial' : null,
    fallbackReason: 'provider_candle_fallback',
    resolvedBy: 'provider_candle',
  });
  return {
    exchange: params.item.exchange,
    symbol: params.item.symbol,
    marketId: params.item.marketId,
    canonicalMarketId: params.item.canonicalMarketId ?? params.item.marketId,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    displayPair: params.item.displayPair,
    points,
    sparkline: points.map((point) => point.value),
    sparklinePoints: points,
    source: 'provider_candle_1m',
    sparklineSource: 'provider_candle_1m',
    quality,
    sparklineQuality: quality,
    sparklinePointCount: points.length,
    isRenderable: diagnostics.graphDisplayAllowed,
    graphDisplayAllowed: diagnostics.graphDisplayAllowed,
    recommendedDisplayScale: diagnostics.recommendedDisplayScale,
    volatilityHint: diagnostics.volatilityHint,
    isDerived: false,
    sparklineIsDerived: false,
    realSeries: diagnostics.realSeries,
    partial: diagnostics.partial,
    pointCount: points.length,
    stale: false,
    updatedAt: points[points.length - 1]?.timestamp ?? null,
    interval: params.interval,
    requestedLimit: params.limit,
    from: points[0]?.timestamp ?? null,
    to: points[points.length - 1]?.timestamp ?? null,
    generatedAt: new Date().toISOString(),
    sourceReason: 'provider_candle_fallback',
    unavailableReason: null,
    diagnostics,
  };
}

export function normalizeContractMarket(
  exchange: ContractExchange,
  symbol: string,
  quoteCurrency: ContractQuoteCurrency,
) {
  return getAdapter(exchange).normalizeMarket(symbol, quoteCurrency);
}

export function normalizeContractSymbolInput(
  exchange: ContractExchange,
  value: string,
  quoteCurrency: ContractQuoteCurrency,
) {
  const normalized = value.trim().toUpperCase();
  if (!normalized) {
    throw new AppError(400, 'symbol is required', { field: 'symbol' }, 'INVALID_SYMBOL');
  }

  const parsed = getAdapter(exchange).parseMarket(normalized);
  if (parsed) {
    if (parsed.quoteCurrency !== quoteCurrency) {
      throw new AppError(400, 'symbol quote does not match quoteCurrency', {
        field: 'symbol',
        symbol: value,
        quoteCurrency,
      }, 'INVALID_MARKET');
    }
    logger.info(
      {
        domain: 'market-contract',
        exchange,
        inputSymbol: value,
        quoteCurrency,
        baseSymbol: parsed.symbol,
        market: normalizeContractMarket(exchange, parsed.symbol, quoteCurrency),
      },
      `[MarketContract] normalize exchange=${exchange} inputSymbol=${value} quoteCurrency=${quoteCurrency} baseSymbol=${parsed.symbol} market=${normalizeContractMarket(exchange, parsed.symbol, quoteCurrency)}`,
    );
    return parsed.symbol;
  }

  const slashParts = normalized.split('/');
  if (slashParts.length === 2 && slashParts[1] === quoteCurrency) {
    const baseSymbol = slashParts[0];
    logger.info(
      {
        domain: 'market-contract',
        exchange,
        inputSymbol: value,
        quoteCurrency,
        baseSymbol,
        market: normalizeContractMarket(exchange, baseSymbol, quoteCurrency),
      },
      `[MarketContract] normalize exchange=${exchange} inputSymbol=${value} quoteCurrency=${quoteCurrency} baseSymbol=${baseSymbol} market=${normalizeContractMarket(exchange, baseSymbol, quoteCurrency)}`,
    );
    return baseSymbol;
  }

  const underscoreSuffix = `_${quoteCurrency}`;
  if (normalized.endsWith(underscoreSuffix)) {
    const baseSymbol = normalized.slice(0, -underscoreSuffix.length);
    logger.info(
      {
        domain: 'market-contract',
        exchange,
        inputSymbol: value,
        quoteCurrency,
        baseSymbol,
        market: normalizeContractMarket(exchange, baseSymbol, quoteCurrency),
      },
      `[MarketContract] normalize exchange=${exchange} inputSymbol=${value} quoteCurrency=${quoteCurrency} baseSymbol=${baseSymbol} market=${normalizeContractMarket(exchange, baseSymbol, quoteCurrency)}`,
    );
    return baseSymbol;
  }

  logger.info(
    {
      domain: 'market-contract',
      exchange,
      inputSymbol: value,
      quoteCurrency,
      baseSymbol: normalized,
      market: normalizeContractMarket(exchange, normalized, quoteCurrency),
    },
    `[MarketContract] normalize exchange=${exchange} inputSymbol=${value} quoteCurrency=${quoteCurrency} baseSymbol=${normalized} market=${normalizeContractMarket(exchange, normalized, quoteCurrency)}`,
  );
  return normalized;
}

function serializeCandlePoint(candle: MarketCandle) {
  const value = candle.quoteVolume;
  return {
    ...candle,
    value,
    tradePriceVolume: candle.tradePriceVolume ?? value,
  };
}

export async function getMarketCandleSnapshot(params: CandleSnapshotParams) {
  warnUnexpectedSparklineHeavyProviderCall('candles');
  const market = normalizeContractMarket(params.exchange, params.symbol, params.quoteCurrency);
  const key = `candles:${params.exchange}:${market}:${params.quoteCurrency}:${params.timeframe}:${params.limit}`;
  const { cacheHit, inFlightDedupe, promise } = ttlCache(key, env.CANDLE_CACHE_TTL_SECONDS, async () => {
    const candles = await getAdapter(params.exchange).getCandles(params);
    const summary = await getAdapter(params.exchange).getCurrentPrices([market]).catch((error) => {
      logger.warn(
        { domain: 'market-contract', exchange: params.exchange, market, retryable: true, err: error },
        'Candle summary ticker request failed; returning candle points without summary',
      );
      return [];
    });
    const value = { candles, summary: summary[0] ?? null };
    if (candles.length > 0) {
      lastKnownGoodCandles.set(key, { value, savedAt: Date.now() });
    }
    return value;
  });

  logger.debug(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      symbol: params.symbol,
      quote: params.quoteCurrency,
      timeframe: params.timeframe,
      limit: params.limit,
      cacheHit,
      inFlightDedupe,
    },
    `[MarketCandles] request exchange=${params.exchange} symbol=${params.symbol} quote=${params.quoteCurrency} timeframe=${params.timeframe} limit=${params.limit}`,
  );

  let result: CandleLoadResult;
  let stale = false;
  let fallbackReason: string | null = null;
  let lastSuccessfulAt: number | null = null;
  try {
    result = await promise;
  } catch (error) {
    const lastKnownGood = lastKnownGoodCandles.get(key);
    if (!lastKnownGood) {
      throw error;
    }
    stale = true;
    fallbackReason = error instanceof Error ? error.message : 'provider_unavailable';
    lastSuccessfulAt = lastKnownGood.savedAt;
    logger.warn(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        market,
        timeframe: params.timeframe,
        limit: params.limit,
        fallbackReason,
      },
      '[MarketCandles] provider failed; returning last-known-good candle snapshot',
    );
    result = lastKnownGood.value;
  }
  const points = result.candles.map(serializeCandlePoint);
  const status = stale ? 'stale' : points.length > 0 ? 'success' : 'empty';
  logger.debug(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      market,
      count: points.length,
      cacheHit,
      inFlightDedupe,
      status,
    },
    `[MarketCandles] response status=${status} count=${points.length} cacheHit=${cacheHit} inFlightDedupe=${inFlightDedupe}`,
  );

  const latest = result.summary;
  const lastCandle = result.candles[result.candles.length - 1] ?? null;
  return {
    exchange: params.exchange,
    symbol: params.symbol,
    quoteCurrency: params.quoteCurrency,
    market,
    marketId: market,
    displaySymbol: `${params.symbol}/${params.quoteCurrency}`,
    timeframe: params.timeframe,
    source: params.exchange,
    status,
    points,
    candles: points,
    stale,
    meta: {
      freshnessState: stale ? 'stale' : points.length > 0 ? 'live' : 'empty',
      source: stale ? 'last_known_good' : params.exchange,
      fallbackReason,
      lastSuccessfulAt,
      pointCount: points.length,
    },
    emptyState: {
      isEmpty: points.length === 0,
      reason: points.length === 0 ? 'NO_CANDLES_FOR_TIMEFRAME' : null,
    },
    error: null,
    summary: {
      currentPrice: latest?.currentPrice ?? lastCandle?.close ?? null,
      high24h: latest?.high24h ?? null,
      low24h: latest?.low24h ?? null,
      changeRate24h: latest?.changeRate24h ?? null,
      volume24h: latest?.volume24h ?? null,
    },
  };
}

function shouldRunSparklineWarmup() {
  if (process.env.SPARKLINE_WARMUP_ENABLED === 'false') {
    return false;
  }
  return process.env.SPARKLINE_WARMUP_ENABLED === 'true' || process.env.NODE_ENV !== 'test';
}

function buildTickerSparklineSummary(
  items: MarketTickerItem[],
  attachMs: number,
  providerStats?: ProviderCandleAttachStats,
) {
  const now = Date.now();
  const pointCounts = items.map((item) => item.sparklinePointCount ?? 0);
  const avgPointCount = pointCounts.length > 0
    ? pointCounts.reduce((sum, value) => sum + value, 0) / pointCounts.length
    : 0;
  const qualityCount = (quality: SparklineQuality) => items.filter((item) => item.sparklineQuality === quality).length;
  const pointCountDistribution = summarizeSparklinePointCountDistribution(items);
  const missing = items.filter((item) => {
    if (item.sparklineQuality === 'lowInformation') {
      return !item.sparklineLowInformationReason;
    }
    if (item.sparklineQuality === 'unavailable') {
      return !item.sparklineUnavailableReason;
    }
    return !item.sparklineQuality;
  }).length;

  return {
    targetPointCount: LIST_SPARKLINE_TARGET_POINT_COUNT as 24,
    providerCandle24: qualityCount('providerCandle24'),
    listSparkline24: qualityCount('listSparkline24'),
    staleListSparkline24: qualityCount('staleListSparkline24'),
    fallbackListSparkline: qualityCount('fallbackListSparkline'),
    tickerRingBuffer: items.filter((item) => item.sparklineSource === 'ticker_ring_buffer').length,
    graphDisplayAllowed: items.filter((item) => item.graphDisplayAllowed).length,
    lowInformation: qualityCount('lowInformation'),
    unavailable: qualityCount('unavailable') + qualityCount('insufficient_points'),
    missing,
    pointCountDistribution: {
      count0: pointCountDistribution.count0,
      count1: pointCountDistribution.count1,
      count2to11: pointCountDistribution.count2to11,
      count12to23: pointCountDistribution.count12to23,
      count24: pointCountDistribution.count24,
      countOver24: pointCountDistribution.countOver24,
    },
    providerFetchFailed: providerStats?.failedCount ?? 0,
    providerFetchHttp429: providerStats?.http429Count ?? 0,
    providerFetch4xx: providerStats?.http4xxCount ?? 0,
    providerFetch5xx: providerStats?.http5xxCount ?? 0,
    providerLatencyP50Ms: percentile(providerStats?.latencyMs ?? [], 0.5),
    providerLatencyP95Ms: percentile(providerStats?.latencyMs ?? [], 0.95),
    requestProviderFetches: providerStats?.attemptedCount ?? 0,
    warmupQueued: providerStats?.warmupQueuedCount ?? 0,
    attachBudgetMs: providerStats?.budgetMs ?? DEFAULT_LIST_SPARKLINE_ATTACH_BUDGET_MS,
    attachBudgetExhausted: providerStats?.budgetExhausted ?? false,
    avgPointCount,
    updatedWithin30s: items.filter((item) => item.sparklineUpdatedAt && now - Date.parse(item.sparklineUpdatedAt) <= 30_000).length,
    updatedWithin60s: items.filter((item) => item.sparklineUpdatedAt && now - Date.parse(item.sparklineUpdatedAt) <= 60_000).length,
    staleOver120s: items.filter((item) => !item.sparklineUpdatedAt || now - Date.parse(item.sparklineUpdatedAt) > 120_000).length,
    p50PointCount: percentile(pointCounts, 0.5),
    p95PointCount: percentile(pointCounts, 0.95),
    attachMs,
    warmup: items.some((item) => item.sparklinePointCount < LIST_SPARKLINE_TARGET_POINT_COUNT),
  };
}

function summarizeSparklinePointCountDistribution(items: MarketTickerItem[]) {
  const sourceBreakdown = items.reduce<Record<string, {
    count: number;
    count0: number;
    count1: number;
    count2to11: number;
    count12to23: number;
    count24: number;
    countOver24: number;
  }>>((summary, item) => {
    const source = item.sparklineSource ?? 'missing';
    const pointCount = item.sparklinePointCount ?? 0;
    const bucket = summary[source] ?? {
      count: 0,
      count0: 0,
      count1: 0,
      count2to11: 0,
      count12to23: 0,
      count24: 0,
      countOver24: 0,
    };
    bucket.count += 1;
    if (pointCount === 0) bucket.count0 += 1;
    else if (pointCount === 1) bucket.count1 += 1;
    else if (pointCount <= 11) bucket.count2to11 += 1;
    else if (pointCount <= 23) bucket.count12to23 += 1;
    else if (pointCount === 24) bucket.count24 += 1;
    else bucket.countOver24 += 1;
    summary[source] = bucket;
    return summary;
  }, {});

  return {
    count0: items.filter((item) => item.sparklinePointCount === 0).length,
    count1: items.filter((item) => item.sparklinePointCount === 1).length,
    count2to11: items.filter((item) => item.sparklinePointCount >= 2 && item.sparklinePointCount <= 11).length,
    count12to23: items.filter((item) => item.sparklinePointCount >= 12 && item.sparklinePointCount <= 23).length,
    count24: items.filter((item) => item.sparklinePointCount === LIST_SPARKLINE_TARGET_POINT_COUNT).length,
    countOver24: items.filter((item) => item.sparklinePointCount > LIST_SPARKLINE_TARGET_POINT_COUNT).length,
    sourceBreakdown,
  };
}

function scheduleSparklineWarmup(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  items: MarketTickerItem[];
  reason: 'ticker_top_volume' | 'top_cards' | 'stale_refresh';
}) {
  const profile = getProviderCandleRateLimitProfile(params.exchange);
  if (!shouldRunSparklineWarmup() || params.items.length === 0) {
    return;
  }
  const targets = params.items
    .filter((item) => item.currentPrice !== null && item.currentPrice > 0)
    .sort((left, right) => right.accTradePrice24h - left.accTradePrice24h)
    .slice(0, Math.min(SPARKLINE_WARMUP_TOP_LIMIT, profile.warmupBatchSize));
  const marketIds = targets.map((item) => item.marketId);
  let cacheSkippedCount = 0;
  let inFlightSkippedCount = 0;
  const needsWarm = targets.filter((item) => {
    const key = preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId);
    const cached = readCachedSparklineItem(key, true);
    if (cached && isDisplayableRealSparkline(cached)) {
      cacheSkippedCount += 1;
      return false;
    }
    if (sparklineWarmupInFlight.has(key)) {
      inFlightSkippedCount += 1;
      return false;
    }
    sparklineWarmupInFlight.add(key);
    return true;
  });
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      marketIds,
      reason: params.reason,
      inFlightSkippedCount,
      cacheSkippedCount,
      needsWarmCount: needsWarm.length,
      concurrency: profile.warmupConcurrency,
      batchSize: profile.warmupBatchSize,
    },
    `[SparklineWarmupQueued] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketIds=${marketIds.join(',')} reason=${params.reason} inFlightSkippedCount=${inFlightSkippedCount} cacheSkippedCount=${cacheSkippedCount}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      warmedKeys: targets
        .filter((item) => !needsWarm.includes(item))
        .map((item) => preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId)),
      pendingKeys: needsWarm.map((item) => preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId)),
      failedKeys: [],
      reason: params.reason,
    },
    `[SparklineWarmupDebug] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} warmedKeys=${targets.filter((item) => !needsWarm.includes(item)).map((item) => preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId)).join(',')} pendingKeys=${needsWarm.map((item) => preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId)).join(',')} failedKeys= reason=${params.reason}`,
  );
  if (needsWarm.length === 0) {
    return;
  }
  const timer = setTimeout(() => {
    void mapBounded(needsWarm, profile.warmupConcurrency, async (item) => {
      const startedAt = Date.now();
      const key = preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId);
      try {
        const slot = await waitForProviderCandleSlot({
          exchange: params.exchange,
          deadlineAt: null,
        });
        if (!slot.allowed) {
          throw new Error(slot.reason);
        }
        const timeoutSentinel = { timeout: true as const };
        const candleLoad = getAdapter(params.exchange).getCandles({
          exchange: params.exchange,
          symbol: item.symbol,
          quoteCurrency: params.quoteCurrency,
          timeframe: '1M',
          limit: SPARKLINE_LIMIT_MAX,
        });
        void candleLoad.catch(() => undefined);
        const result = await Promise.race([
          candleLoad.then((candles) => ({ timeout: false as const, candles })).catch((error) => {
            throw error;
          }),
          timeoutAfter(SPARKLINE_PROVIDER_TIMEOUT_MS, timeoutSentinel),
        ]);
        if (result.timeout) {
          throw new Error('provider_timeout');
        }
        const providerItem = buildProviderCandleSparklineItem({
          item,
          candles: result.candles,
          limit: SPARKLINE_LIMIT_MAX,
          interval: '1M',
        });
        const normalized = providerItem
          ? withProviderDiagnostics(providerItem, {
              providerLatencyMs: Date.now() - startedAt,
              partialReason: providerItem.pointCount < SPARKLINE_LIMIT_MAX ? 'provider_partial' : null,
            })
          : null;
        if (normalized && isDisplayableRealSparkline(normalized)) {
          const cachedNormalized = writeRealSparklineCache(key, normalized);
          logger.debug(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              cacheKey: key,
              pointCount: cachedNormalized.pointCount,
              quality: cachedNormalized.quality,
              realSeries: cachedNormalized.realSeries,
              graphDisplayAllowed: cachedNormalized.graphDisplayAllowed,
              cacheWriteDecision: cachedNormalized.diagnostics.cacheWriteDecision,
              cacheTtlMs: normalized.pointCount >= SPARKLINE_LIMIT_MAX ? SPARKLINE_FULL_REAL_TTL_MS : SPARKLINE_PARTIAL_REAL_TTL_MS,
            },
            `[SparklineWarmupStored] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} cacheKey=${key} pointCount=${cachedNormalized.pointCount} quality=${cachedNormalized.quality} realSeries=${cachedNormalized.realSeries} graphDisplayAllowed=${cachedNormalized.graphDisplayAllowed} cacheWriteDecision=${cachedNormalized.diagnostics.cacheWriteDecision ?? ''} cacheTtlMs=${normalized.pointCount >= SPARKLINE_LIMIT_MAX ? SPARKLINE_FULL_REAL_TTL_MS : SPARKLINE_PARTIAL_REAL_TTL_MS}`,
          );
        } else {
          const prepared = buildPreparedSparklineItem({
            item,
            points: preparedSparklineCache.get(key) ?? [],
            limit: SPARKLINE_LIMIT_MAX,
            interval: '1M',
            source: 'prepared_cache',
            sourceReason: 'warmup_ring_buffer_partial',
          });
          if (prepared) {
            const normalizedPrepared = normalizeSparklineQuality(prepared);
            const cachedPrepared = writeRealSparklineCache(key, normalizedPrepared);
            if (isDisplayableRealSparkline(cachedPrepared)) {
              logger.debug(
                {
                  domain: 'market-contract',
                  exchange: params.exchange,
                  quoteCurrency: params.quoteCurrency,
                  marketId: item.marketId,
                  cacheKey: key,
                  pointCount: cachedPrepared.pointCount,
                  quality: cachedPrepared.quality,
                  realSeries: cachedPrepared.realSeries,
                  graphDisplayAllowed: cachedPrepared.graphDisplayAllowed,
                  cacheWriteDecision: cachedPrepared.diagnostics.cacheWriteDecision,
                  cacheTtlMs: cachedPrepared.pointCount >= SPARKLINE_LIMIT_MAX ? SPARKLINE_FULL_REAL_TTL_MS : SPARKLINE_PARTIAL_REAL_TTL_MS,
                },
                `[SparklineWarmupStored] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} cacheKey=${key} pointCount=${cachedPrepared.pointCount} quality=${cachedPrepared.quality} realSeries=${cachedPrepared.realSeries} graphDisplayAllowed=${cachedPrepared.graphDisplayAllowed} cacheWriteDecision=${cachedPrepared.diagnostics.cacheWriteDecision ?? ''} cacheTtlMs=${cachedPrepared.pointCount >= SPARKLINE_LIMIT_MAX ? SPARKLINE_FULL_REAL_TTL_MS : SPARKLINE_PARTIAL_REAL_TTL_MS}`,
              );
            }
          }
        }
        logger.debug(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            success: Boolean(normalized?.realSeries),
            pointCount: normalized?.pointCount ?? 0,
            quality: normalized?.quality ?? 'unavailable',
            realSeries: normalized?.realSeries ?? false,
            graphDisplayAllowed: normalized?.graphDisplayAllowed ?? false,
            elapsedMs: Date.now() - startedAt,
            reason: params.reason,
          },
          `[SparklineWarmupResult] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} success=${Boolean(normalized?.realSeries)} pointCount=${normalized?.pointCount ?? 0} quality=${normalized?.quality ?? 'unavailable'} realSeries=${normalized?.realSeries ?? false} graphDisplayAllowed=${normalized?.graphDisplayAllowed ?? false} elapsedMs=${Date.now() - startedAt} reason=${params.reason}`,
        );
      } catch (error) {
        const reason = extractProviderFailureReason(error);
        logProviderCandleFetchDropped({
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          marketId: item.marketId,
          timeframe: '1M',
          statusCode: extractProviderFailureStatus(error),
          error: reason,
          droppedReason: classifyProviderDropReason(reason, extractProviderFailureStatus(error)),
          latencyMs: Date.now() - startedAt,
          route: 'warmup',
        });
        registerProviderCandleFailure({
          exchange: params.exchange,
          statusCode: extractProviderFailureStatus(error),
        });
        logger.debug(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            success: false,
            pointCount: 0,
            quality: 'unavailable',
            realSeries: false,
            graphDisplayAllowed: false,
            elapsedMs: Date.now() - startedAt,
            reason,
          },
          `[SparklineWarmupResult] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} success=false pointCount=0 quality=unavailable realSeries=false graphDisplayAllowed=false elapsedMs=${Date.now() - startedAt} reason=${reason}`,
        );
      } finally {
        sparklineWarmupInFlight.delete(key);
      }
    });
  }, 10);
  timer.unref?.();
}

export async function getMarketTickerList(params: TickerListParams) {
  const exchangeContract = getMarketExchangeContract(params.exchange);
  const requestedLimit = Math.min(params.limit ?? TICKER_LIMIT_MAX, TICKER_LIMIT_MAX);
  const startedAt = Date.now();
  const requestId = params.requestId ?? `ticker-${++tickerRequestSeq}`;
  const serverReceivedAt = new Date(startedAt).toISOString();
  const snapshotAt = serverReceivedAt;
  const normalizedQuery = normalizeTickerSearchQuery(params.query);
  const displayHint = quoteDisplayHint(params.quoteCurrency);
  if (!isQuoteCurrencySupported(params.exchange, params.quoteCurrency)) {
    logger.debug(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        requestedQuoteCurrency: params.quoteCurrency,
        supportedQuotes: exchangeContract.supportedQuotes,
        reason: 'quote_currency_not_supported',
      },
      `[MarketTickerUnsupportedQuote] exchange=${params.exchange} requestedQuoteCurrency=${params.quoteCurrency} supportedQuotes=${exchangeContract.supportedQuotes.join(',')} reason=quote_currency_not_supported`,
    );
    return {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      status: 'unsupported' as const,
      total: 0,
      meta: {
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        requestId,
        generationHint: `${params.exchange}:${params.quoteCurrency}:unsupported`,
        requestedLimit,
        returnedCount: 0,
        query: normalizedQuery,
        sortKey: toPublicTickerSortKey(params.sort ?? 'volume'),
        sortDirection: params.order ?? 'desc',
        nextCursor: null,
        hasNext: false,
        snapshotAt,
        serverReceivedAt,
        serverRespondedAt: new Date().toISOString(),
        sparklineTargetPointCount: LIST_SPARKLINE_TARGET_POINT_COUNT,
	        sparklineAttachedCount: 0,
	        sparklineMissingCount: 0,
	        sparklineUnavailableCount: 0,
	        sparklineLowInformationCount: 0,
	        sparklineSummary: buildTickerSparklineSummary([], 0),
	        supportedQuotes: exchangeContract.supportedQuotes,
        defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
        quoteDisplayHint: displayHint,
        timing: {
          totalMs: 0,
          tickerFetchMs: 0,
          sortMs: 0,
          cursorMs: 0,
          sparklineAttachMs: 0,
        },
      },
      items: [],
      diagnostics: createTickerDiagnostics({
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        supported: false,
        providerStatus: 'unsupported',
        reason: 'quote_currency_not_supported',
      }),
    };
  }
  const sort = params.sort ?? 'volume';
  const order = params.order ?? (sort === 'name' ? 'asc' : 'desc');
  const key = `tickers:${params.exchange}:${params.quoteCurrency}:${sort}:${order}:all`;
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      sortKey: toPublicTickerSortKey(sort),
      sortDirection: order,
      queryExists: normalizedQuery !== null,
      cursorExists: Boolean(params.cursor),
      limit: requestedLimit,
    },
    `[CursorPaginationRequest] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} sortKey=${toPublicTickerSortKey(sort)} sortDirection=${order} queryExists=${normalizedQuery !== null} cursorExists=${Boolean(params.cursor)} limit=${requestedLimit}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      recommendedPrecision: displayHint,
    },
    `[QuoteDisplayHint] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} recommendedPrecision=${JSON.stringify(displayHint)}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      limit: requestedLimit,
      requestId,
    },
    `[MarketTickerRequest] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestId=${requestId} limit=${requestedLimit}`,
  );
  const tickerFetchStartedAt = Date.now();
  const { cacheHit, inFlightDedupe, promise } = ttlCache(key, env.TICKER_CACHE_TTL_SECONDS, () => getAdapter(params.exchange).getTickers({
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    sort,
    order,
  }));

  logger.info(
    { domain: 'market-contract', source: 'service', exchange: params.exchange, quoteCurrency: params.quoteCurrency, cacheHit, inFlightDedupe },
    `[MarketTickers] request source=service exchange=${params.exchange} quoteCurrency=${params.quoteCurrency}`,
  );

  const rawLoadedItems = await promise;
  const tickerFetchMs = Date.now() - tickerFetchStartedAt;
  const loadedItems = rawLoadedItems.map(withTickerSparklineMetadata);
  const zeroPriceCount = loadedItems.filter((item) => (item.currentPrice ?? 0) <= 0).length;
  const zeroVolumeCount = loadedItems.filter((item) => item.accTradePrice24h <= 0).length;
  const droppedReasonSummary: Record<string, number> = {};
  const identityCheckedItems = loadedItems.filter((item) => {
    const mismatchReason = validateTickerIdentity(item, params.exchange, params.quoteCurrency);
    if (mismatchReason) {
      droppedReasonSummary[mismatchReason] = (droppedReasonSummary[mismatchReason] ?? 0) + 1;
      logMarketIdentityMismatch({
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        rawMarketId: item.originalMarketId ?? item.rawSymbol ?? item.marketId,
        canonicalMarketId: item.canonicalMarketId ?? item.marketId,
        symbol: item.symbol,
        reason: mismatchReason,
      });
      return false;
    }
    return true;
  });
  const deduped = dedupeTickerItemsByCanonical(identityCheckedItems);
  const filteredItems = deduped.items.filter((item) => tickerSearchMatches(item, normalizedQuery));
  for (const item of filteredItems) {
    appendPreparedSparklineSample(item);
  }
  const sortStartedAt = Date.now();
  const stableSorted = stableSortTickerItems(filteredItems, sort, order);
  const sortMs = Date.now() - sortStartedAt;
  const items = stableSorted.items;
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      sortKey: toPublicTickerSortKey(sort),
      sortDirection: order,
      inputCount: filteredItems.length,
      sortedCount: items.length,
      nullSortValueCount: stableSorted.nullSortValueCount,
      duplicateCanonicalDropped: deduped.duplicateCount,
    },
    `[TickerStableSort] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} sortKey=${toPublicTickerSortKey(sort)} sortDirection=${order} inputCount=${filteredItems.length} sortedCount=${items.length} nullSortValueCount=${stableSorted.nullSortValueCount} duplicateCanonicalDropped=${deduped.duplicateCount}`,
  );
  const cursorStartedAt = Date.now();
  const paginated = paginateTickerItems(items, {
    limit: requestedLimit,
    cursor: params.cursor,
    sort,
    order,
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    query: normalizedQuery,
    snapshotAt,
  });
  const cursorMs = Date.now() - cursorStartedAt;
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      limit: requestedLimit,
      cursor: params.cursor ?? null,
      sortKey: sort,
      sortDirection: order,
      returnedCount: paginated.page.length,
      nextCursor: paginated.nextCursor,
      hasNext: paginated.hasNext,
      duplicateDroppedCount: deduped.duplicateCount + paginated.duplicateDroppedCount,
    },
    `[TickerPagination] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} limit=${requestedLimit} cursor=${params.cursor ?? ''} sortKey=${sort} sortDirection=${order} returnedCount=${paginated.page.length} nextCursor=${paginated.nextCursor ?? ''} hasNext=${paginated.hasNext} duplicateDroppedCount=${deduped.duplicateCount + paginated.duplicateDroppedCount}`,
  );
  const attachStartedAt = Date.now();
  const attachLatencies: number[] = [];
  const attachedItems: MarketTickerItem[] = [];
  const initialAttached = paginated.page.map((item) => attachListSparkline(item, {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
  }));
  const providerAttachResult = await attachProviderListSparklinesForVisibleItems(initialAttached, {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
  });
  const providerAttachStats = providerAttachResult.stats;
  for (const attached of providerAttachResult.attached) {
    const attachedItem = {
      ...attached.item,
      priceDisplayHint: displayHint,
    };
    attachLatencies.push(attached.elapsedMs);
    attachedItems.push(attachedItem);
    const uniquePriceCount = new Set(attachedItem.sparklinePoints.map((point) => point.price)).size;
    logger.debug(
      {
        domain: 'market-contract',
        exchange: attachedItem.exchange,
        quoteCurrency: attachedItem.quoteCurrency,
        canonicalMarketId: attachedItem.canonicalMarketId,
        symbol: attachedItem.symbol,
        pointCount: attachedItem.sparklinePointCount,
        quality: attachedItem.sparklineQuality,
        source: attachedItem.sparklineSource,
        isDerived: attachedItem.sparklineIsDerived,
        lowInformationReason: attachedItem.sparklineLowInformationReason ?? null,
        unavailableReason: attachedItem.sparklineUnavailableReason ?? null,
        updatedAt: attachedItem.sparklineUpdatedAt,
        sourceVersion: attachedItem.sparklineSourceVersion,
        pointsHash: attachedItem.sparklinePointsHash,
        uniquePriceCount,
        elapsedMs: attached.elapsedMs,
      },
      `[ListSparklineAttach] exchange=${attachedItem.exchange} quoteCurrency=${attachedItem.quoteCurrency} canonicalMarketId=${attachedItem.canonicalMarketId} symbol=${attachedItem.symbol} pointCount=${attachedItem.sparklinePointCount} quality=${attachedItem.sparklineQuality} source=${attachedItem.sparklineSource} isDerived=${attachedItem.sparklineIsDerived} lowInformationReason=${attachedItem.sparklineLowInformationReason ?? ''} unavailableReason=${attachedItem.sparklineUnavailableReason ?? ''}`,
    );
    logger.debug(
      {
        domain: 'market-contract',
        exchange: attached.item.exchange,
        quoteCurrency: attached.item.quoteCurrency,
        canonicalMarketId: attached.item.canonicalMarketId,
        pointCount: attached.item.sparklinePointCount,
        quality: attached.item.sparklineQuality,
        source: attached.item.sparklineSource,
        updatedAt: attached.item.sparklineUpdatedAt,
        sourceVersion: attached.item.sparklineSourceVersion,
        pointsHash: attached.item.sparklinePointsHash,
        uniquePriceCount,
      },
      `[SparklineVersionDebug] exchange=${attached.item.exchange} quoteCurrency=${attached.item.quoteCurrency} canonicalMarketId=${attached.item.canonicalMarketId} pointCount=${attached.item.sparklinePointCount} quality=${attached.item.sparklineQuality} source=${attached.item.sparklineSource} updatedAt=${attached.item.sparklineUpdatedAt ?? ''} sourceVersion=${attached.item.sparklineSourceVersion ?? ''} pointsHash=${attached.item.sparklinePointsHash} uniquePriceCount=${uniquePriceCount}`,
    );
    const versionKey = `${attached.item.exchange}:${attached.item.quoteCurrency}:${attached.item.canonicalMarketId}`;
    const previousVersion = lastTickerSparklineVersionByMarket.get(versionKey);
    if (
      previousVersion
      && previousVersion.price !== null
      && attached.item.currentPrice !== null
      && previousVersion.price !== attached.item.currentPrice
      && previousVersion.pointsHash === attached.item.sparklinePointsHash
    ) {
      logger.warn(
        {
          domain: 'market-contract',
          exchange: attached.item.exchange,
          quoteCurrency: attached.item.quoteCurrency,
          canonicalMarketId: attached.item.canonicalMarketId,
          oldPrice: previousVersion.price,
          newPrice: attached.item.currentPrice,
          oldHash: previousVersion.pointsHash,
          newHash: attached.item.sparklinePointsHash,
          updatedAt: attached.item.sparklineUpdatedAt,
          reason: 'price_changed_without_sparkline_hash_change',
        },
        `[SparklineStaleWhilePriceChanged] exchange=${attached.item.exchange} quoteCurrency=${attached.item.quoteCurrency} canonicalMarketId=${attached.item.canonicalMarketId} oldPrice=${previousVersion.price} newPrice=${attached.item.currentPrice} oldHash=${previousVersion.pointsHash} newHash=${attached.item.sparklinePointsHash} updatedAt=${attached.item.sparklineUpdatedAt ?? ''} reason=price_changed_without_sparkline_hash_change`,
      );
    }
    lastTickerSparklineVersionByMarket.set(versionKey, {
      price: attached.item.currentPrice,
      pointsHash: attached.item.sparklinePointsHash,
      updatedAt: attached.item.sparklineUpdatedAt,
    });
    if (params.exchange === 'korbit') {
      logger.debug(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          canonicalMarketId: attached.item.canonicalMarketId,
          symbol: attached.item.symbol,
          source: attached.source,
          rawPointCount: attached.rawPointCount,
          finalPointCount: attached.item.sparklinePointCount,
          quality: attached.item.sparklineQuality,
          reason: attached.reason,
          cacheKey: attached.cacheKey,
          candleCacheHit: attached.candleCacheHit,
          ringBufferCount: attached.ringBufferCount,
        },
        `[KorbitSparklineAttachDebug] canonicalMarketId=${attached.item.canonicalMarketId} symbol=${attached.item.symbol} source=${attached.source} rawPointCount=${attached.rawPointCount} finalPointCount=${attached.item.sparklinePointCount} quality=${attached.item.sparklineQuality} reason=${attached.reason ?? ''} cacheKey=${attached.cacheKey} candleCacheHit=${attached.candleCacheHit} ringBufferCount=${attached.ringBufferCount}`,
      );
    }
  }
  scheduleSparklineWarmup({
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    items: attachedItems,
    reason: 'ticker_top_volume',
  });
  const attachMs = Date.now() - attachStartedAt;
  const sparklineSummary = buildTickerSparklineSummary(attachedItems, attachMs, providerAttachStats);
  const pointCountDistribution = summarizeSparklinePointCountDistribution(attachedItems);
  const fallbackRatio = attachedItems.length > 0 ? sparklineSummary.fallbackListSparkline / attachedItems.length : 0;
  const previewGraphDerivedCount = attachedItems.filter((item) => item.sparklineIsDerived).length;
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      rawCount: loadedItems.length,
      mappedCount: items.length,
      returnedCount: attachedItems.length,
      supportedQuotes: exchangeContract.supportedQuotes,
      zeroPriceCount,
      zeroVolumeCount,
      dropped: loadedItems.length - identityCheckedItems.length,
      duplicateDroppedCount: deduped.duplicateCount,
      reasonSummary: droppedReasonSummary,
    },
    `[MarketTickerMapping] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} received=${loadedItems.length} mapped=${items.length} dropped=${loadedItems.length - identityCheckedItems.length} reasonSummary=${JSON.stringify(droppedReasonSummary)}`,
  );
  logger.info(
    { domain: 'market-contract', source: 'service', exchange: params.exchange, quoteCurrency: params.quoteCurrency, count: attachedItems.length, cacheHit, inFlightDedupe },
    `[MarketTickers] response count=${attachedItems.length} cacheHit=${cacheHit} inFlightDedupe=${inFlightDedupe}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestId,
      limit: requestedLimit,
      cursor: params.cursor ?? null,
      returnedCount: attachedItems.length,
      duplicateCount: deduped.duplicateCount + paginated.duplicateDroppedCount,
      identityMismatchCount: loadedItems.length - identityCheckedItems.length,
      sparklineMissing: sparklineSummary.missing,
      sparklineLowInformation: sparklineSummary.lowInformation,
      sparklineFresh24: sparklineSummary.providerCandle24 + sparklineSummary.listSparkline24,
    },
    `[TickerPageSummary] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestId=${requestId} limit=${requestedLimit} cursor=${params.cursor ?? ''} returnedCount=${attachedItems.length} duplicateCount=${deduped.duplicateCount + paginated.duplicateDroppedCount} identityMismatchCount=${loadedItems.length - identityCheckedItems.length} sparklineMissing=${sparklineSummary.missing} sparklineLowInformation=${sparklineSummary.lowInformation} sparklineFresh24=${sparklineSummary.providerCandle24 + sparklineSummary.listSparkline24}`,
  );
  const qualitySummary = attachedItems.reduce<Record<string, number>>((summary, item) => {
    summary[item.sparklineQuality] = (summary[item.sparklineQuality] ?? 0) + 1;
    return summary;
  }, {});
  const averagePointCount = attachedItems.length > 0
    ? attachedItems.reduce((sum, item) => sum + item.sparklinePointCount, 0) / attachedItems.length
    : 0;
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedLimit,
      returnedCount: attachedItems.length,
      graphDisplayAllowed: attachedItems.filter((item) => item.graphDisplayAllowed).length,
      providerCandle24: qualitySummary.providerCandle24 ?? 0,
      listSparkline24: qualitySummary.listSparkline24 ?? 0,
      staleListSparkline24: qualitySummary.staleListSparkline24 ?? 0,
      tickerRingBuffer: attachedItems.filter((item) => item.sparklineSource === 'ticker_ring_buffer').length,
      lowInformation: qualitySummary.lowInformation ?? 0,
      unavailable: (qualitySummary.unavailable ?? 0) + (qualitySummary.insufficient_points ?? 0),
      pointCountDistribution,
      sparklineAttachMs: attachMs,
      totalMs: Date.now() - startedAt,
      providerFetchFailed: providerAttachStats.failedCount,
      providerFetchHttp429: providerAttachStats.http429Count,
      providerFetch4xx: providerAttachStats.http4xxCount,
      providerFetch5xx: providerAttachStats.http5xxCount,
    },
    `[TickerSparklineCoverageByExchange] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} returnedCount=${attachedItems.length} graphDisplayAllowed=${attachedItems.filter((item) => item.graphDisplayAllowed).length} providerCandle24=${qualitySummary.providerCandle24 ?? 0} listSparkline24=${qualitySummary.listSparkline24 ?? 0} staleListSparkline24=${qualitySummary.staleListSparkline24 ?? 0} tickerRingBuffer=${attachedItems.filter((item) => item.sparklineSource === 'ticker_ring_buffer').length} lowInformation=${qualitySummary.lowInformation ?? 0} unavailable=${(qualitySummary.unavailable ?? 0) + (qualitySummary.insufficient_points ?? 0)} count0=${pointCountDistribution.count0} count1=${pointCountDistribution.count1} count2to11=${pointCountDistribution.count2to11} count12to23=${pointCountDistribution.count12to23} count24=${pointCountDistribution.count24} countOver24=${pointCountDistribution.countOver24} sparklineAttachMs=${attachMs} totalMs=${Date.now() - startedAt}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      targetCount: providerAttachStats.targetCount,
      attemptedCount: providerAttachStats.attemptedCount,
      successCount: providerAttachStats.successCount,
      failedCount: providerAttachStats.failedCount,
      skippedBudgetCount: providerAttachStats.skippedBudgetCount,
      skippedCooldownCount: providerAttachStats.skippedCooldownCount,
      skippedUnsupportedCount: providerAttachStats.skippedUnsupportedCount,
      warmupQueuedCount: providerAttachStats.warmupQueuedCount,
      http429Count: providerAttachStats.http429Count,
      http4xxCount: providerAttachStats.http4xxCount,
      http5xxCount: providerAttachStats.http5xxCount,
      latencyP50Ms: percentile(providerAttachStats.latencyMs, 0.5),
      latencyP95Ms: percentile(providerAttachStats.latencyMs, 0.95),
      cooldownUntil: providerAttachStats.cooldownUntil ? new Date(providerAttachStats.cooldownUntil).toISOString() : null,
      droppedReasons: providerAttachStats.droppedReasons,
    },
    `[ProviderCandleRateLimitSummary] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} targetCount=${providerAttachStats.targetCount} attemptedCount=${providerAttachStats.attemptedCount} successCount=${providerAttachStats.successCount} failedCount=${providerAttachStats.failedCount} skippedBudgetCount=${providerAttachStats.skippedBudgetCount} skippedCooldownCount=${providerAttachStats.skippedCooldownCount} warmupQueuedCount=${providerAttachStats.warmupQueuedCount} http429Count=${providerAttachStats.http429Count} http4xxCount=${providerAttachStats.http4xxCount} http5xxCount=${providerAttachStats.http5xxCount} latencyP50Ms=${percentile(providerAttachStats.latencyMs, 0.5)} latencyP95Ms=${percentile(providerAttachStats.latencyMs, 0.95)}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      sparklineAttachMs: attachMs,
      totalMs: Date.now() - startedAt,
      budgetMs: providerAttachStats.budgetMs,
      budgetExhausted: providerAttachStats.budgetExhausted,
      requestProviderFetches: providerAttachStats.attemptedCount,
      warmupQueued: providerAttachStats.warmupQueuedCount,
    },
    `[SparklineAttachPerformanceSummary] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} sparklineAttachMs=${attachMs} totalMs=${Date.now() - startedAt} budgetMs=${providerAttachStats.budgetMs} budgetExhausted=${providerAttachStats.budgetExhausted} requestProviderFetches=${providerAttachStats.attemptedCount} warmupQueued=${providerAttachStats.warmupQueuedCount}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedLimit,
      returnedCount: attachedItems.length,
      ...pointCountDistribution,
    },
    `[SparklinePointCountDistribution] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestedLimit=${requestedLimit} returnedCount=${attachedItems.length} count0=${pointCountDistribution.count0} count1=${pointCountDistribution.count1} count2to11=${pointCountDistribution.count2to11} count12to23=${pointCountDistribution.count12to23} count24=${pointCountDistribution.count24} countOver24=${pointCountDistribution.countOver24} sourceBreakdown=${JSON.stringify(pointCountDistribution.sourceBreakdown)}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      cursor: params.cursor ?? null,
      pageSize: requestedLimit,
      pageMarketCount: paginated.page.length,
      attached24: attachedItems.filter((item) => item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT).length,
      lowInformation: sparklineSummary.lowInformation,
      unavailable: sparklineSummary.unavailable,
      missing: sparklineSummary.missing,
    },
    `[TickerPaginationSparklineDebug] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} cursor=${params.cursor ?? ''} pageSize=${requestedLimit} pageMarketCount=${paginated.page.length} attached24=${attachedItems.filter((item) => item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT).length} lowInformation=${sparklineSummary.lowInformation} unavailable=${sparklineSummary.unavailable} missing=${sparklineSummary.missing}`,
  );
  if (fallbackRatio > 0.2) {
    logger.warn(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        requestedLimit,
        returnedCount: attachedItems.length,
        fallbackListSparkline: sparklineSummary.fallbackListSparkline,
        fallbackRatio,
      },
      `[SparklineFallbackRatioWarn] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} fallbackListSparkline=${sparklineSummary.fallbackListSparkline} returnedCount=${attachedItems.length} ratio=${fallbackRatio}`,
    );
  }
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedLimit,
      returnedCount: attachedItems.length,
      attachedCount: attachedItems.filter((item) => item.sparklinePointCount >= 2).length,
      missingCount: 0,
      unavailableCount: attachedItems.filter((item) => item.sparklineQuality === 'unavailable' || item.sparklinePointCount < 2).length,
      lowInformationCount: attachedItems.filter((item) => item.sparklineQuality === 'lowInformation').length,
      providerCandle24: qualitySummary.providerCandle24 ?? 0,
      listSparkline24: qualitySummary.listSparkline24 ?? 0,
      staleListSparkline24: qualitySummary.staleListSparkline24 ?? 0,
      tickerRingBuffer24: attachedItems.filter((item) => item.sparklineSource === 'ticker_ring_buffer' && item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT).length,
      fallbackBackfill: attachedItems.filter((item) => item.sparklineSource === 'fallback_backfill').length,
      avgPointCount: averagePointCount,
      sparklineAttachMs: attachMs,
    },
    `[ListSparklineSummary] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestedLimit=${requestedLimit} returnedCount=${attachedItems.length} attachedCount=${attachedItems.filter((item) => item.sparklinePointCount >= 2).length} missingCount=0 unavailableCount=${attachedItems.filter((item) => item.sparklineQuality === 'unavailable' || item.sparklinePointCount < 2).length} lowInformationCount=${attachedItems.filter((item) => item.sparklineQuality === 'lowInformation').length} providerCandle24=${qualitySummary.providerCandle24 ?? 0} candleCache24=${qualitySummary.listSparkline24 ?? 0} tickerRingBuffer24=${attachedItems.filter((item) => item.sparklineSource === 'ticker_ring_buffer' && item.sparklinePointCount >= LIST_SPARKLINE_TARGET_POINT_COUNT).length} fallbackBackfill=${attachedItems.filter((item) => item.sparklineSource === 'fallback_backfill').length} avgPointCount=${averagePointCount} sparklineAttachMs=${attachMs}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      returnedCount: attachedItems.length,
      providerCandle24: qualitySummary.providerCandle24 ?? 0,
      listSparkline24: qualitySummary.listSparkline24 ?? 0,
      staleListSparkline24: qualitySummary.staleListSparkline24 ?? 0,
      lowInformation: qualitySummary.lowInformation ?? 0,
      unavailable: qualitySummary.unavailable ?? 0,
      avgPointCount: averagePointCount,
    },
    `[SparklineSummary] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} returnedCount=${attachedItems.length} providerCandle24=${qualitySummary.providerCandle24 ?? 0} listSparkline24=${qualitySummary.listSparkline24 ?? 0} staleListSparkline24=${qualitySummary.staleListSparkline24 ?? 0} lowInformation=${qualitySummary.lowInformation ?? 0} unavailable=${qualitySummary.unavailable ?? 0} avgPointCount=${averagePointCount}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      query: normalizedQuery,
      returnedCount: attachedItems.length,
      hasNext: paginated.hasNext,
      nextCursorExists: Boolean(paginated.nextCursor),
      firstCanonicalMarketId: attachedItems[0]?.canonicalMarketId ?? null,
      lastCanonicalMarketId: attachedItems[attachedItems.length - 1]?.canonicalMarketId ?? null,
      snapshotAt,
    },
    `[CursorPaginationResponse] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} query=${normalizedQuery ?? ''} returnedCount=${attachedItems.length} hasNext=${paginated.hasNext} nextCursorExists=${Boolean(paginated.nextCursor)} firstCanonicalMarketId=${attachedItems[0]?.canonicalMarketId ?? ''} lastCanonicalMarketId=${attachedItems[attachedItems.length - 1]?.canonicalMarketId ?? ''} snapshotAt=${snapshotAt}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      totalMs: Date.now() - startedAt,
      sparklineAttachMs: attachMs,
    },
    `[TickerResponseTiming] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} totalMs=${Date.now() - startedAt} sparklineAttachMs=${attachMs}`,
  );

  return {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    supportedQuotes: exchangeContract.supportedQuotes,
    defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
    status: attachedItems.length > 0 ? 'success' : 'empty',
    total: attachedItems.length,
    meta: {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestId,
      generationHint: `${params.exchange}:${params.quoteCurrency}:${sort}:${order}:${serverReceivedAt}`,
      requestedLimit,
      returnedCount: attachedItems.length,
      query: normalizedQuery,
      sortKey: toPublicTickerSortKey(sort),
      sortDirection: order,
      nextCursor: paginated.nextCursor,
      hasNext: paginated.hasNext,
      snapshotAt,
      serverReceivedAt,
      serverRespondedAt: new Date().toISOString(),
      sparklineTargetPointCount: LIST_SPARKLINE_TARGET_POINT_COUNT,
      sparklineAttachedCount: attachedItems.filter((item) => item.sparklinePointCount >= 2).length,
	      sparklineMissingCount: 0,
	      sparklineUnavailableCount: attachedItems.filter((item) => item.sparklineQuality === 'unavailable' || item.sparklinePointCount < 2).length,
	      sparklineLowInformationCount: attachedItems.filter((item) => item.sparklineQuality === 'lowInformation').length,
	      sparklineSummary,
	      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      quoteDisplayHint: displayHint,
      timing: {
        totalMs: Date.now() - startedAt,
        tickerFetchMs,
        sortMs,
        cursorMs,
        sparklineAttachMs: attachMs,
      },
    },
    items: attachedItems,
    diagnostics: createTickerDiagnostics({
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supported: true,
      providerStatus: attachedItems.length > 0 ? 'active' : 'degraded',
      providerLatencyMs: Date.now() - startedAt,
      rawCount: loadedItems.length,
      mappedCount: items.length,
      returnedCount: attachedItems.length,
      omittedCount: Math.max(loadedItems.length - attachedItems.length, 0),
      zeroPriceCount,
      zeroVolumeCount,
      staleCount: attachedItems.filter((item) => item.stale).length,
      reason: attachedItems.length > 0 ? null : 'empty_provider_response',
      previewGraphDerivedCount,
    }),
  };
}

export function summarizeTickerSparklines(items: Array<{
  sparklinePointCount?: number;
  sparklineSource?: string;
}>) {
  return items.reduce(
    (summary, item) => {
      if ((item.sparklinePointCount ?? 0) >= 2) {
        summary.ready += 1;
      }
      if (item.sparklineSource === 'provider_candle' || item.sparklineSource === 'provider') {
        summary.provider += 1;
      } else if (item.sparklineSource === 'sparkline_cache' || item.sparklineSource === 'cache') {
        summary.cache += 1;
      } else if (item.sparklineSource === 'ticker_ring_buffer' || item.sparklineSource === 'previous_snapshot' || item.sparklineSource === 'derived_change24h') {
        summary.derived += 1;
      } else if (item.sparklineSource === 'flat_current') {
        summary.derived += 1;
        summary.flat += 1;
      } else {
        summary.unavailable += 1;
      }
      return summary;
    },
    { ready: 0, provider: 0, cache: 0, derived: 0, flat: 0, unavailable: 0 },
  );
}

function normalizeSparklineSymbols(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  symbols: string[];
}) {
  const normalized: string[] = [];
  for (const input of params.symbols) {
    const raw = input.trim();
    const wildcard = raw.toLowerCase();
    if (SPARKLINE_WILDCARDS.has(wildcard)) {
      throw new AppError(400, 'wildcard symbols are not supported for /market/sparkline', {
        field: 'symbols',
        rejectedValue: raw,
        acceptedFormat: 'comma-separated base symbols or market ids',
      }, 'WILDCARD_SYMBOLS_UNSUPPORTED');
    }
    if (!raw) {
      continue;
    }
    normalized.push(normalizeContractSymbolInput(params.exchange, raw, params.quoteCurrency));
  }
  return Array.from(new Set(normalized));
}

function resolveSparklineInputs(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  symbols: string[];
  marketIds?: string[];
}) {
  const adapter = getAdapter(params.exchange);
  const hasMarketIds = (params.marketIds?.length ?? 0) > 0;
  const inputs = hasMarketIds ? params.marketIds ?? [] : params.symbols;
  const resolved: Array<{
    input: string;
    symbol: string | null;
    marketId: string | null;
    resolvedBy: 'marketId' | 'symbol';
    mismatchReason: string | null;
  }> = [];

  for (const input of inputs) {
    const raw = input.trim();
    if (!raw) {
      continue;
    }
    if (SPARKLINE_WILDCARDS.has(raw.toLowerCase())) {
      throw new AppError(400, 'wildcard symbols are not supported for /market/sparkline', {
        field: hasMarketIds ? 'marketIds' : 'symbols',
        rejectedValue: raw,
        acceptedFormat: 'comma-separated base symbols or market ids',
      }, 'WILDCARD_SYMBOLS_UNSUPPORTED');
    }

    if (hasMarketIds) {
      const parsed = adapter.parseMarket(raw);
      if (!parsed) {
        resolved.push({
          input: raw,
          symbol: null,
          marketId: null,
          resolvedBy: 'marketId',
          mismatchReason: 'invalid_market_id',
        });
        continue;
      }
      if (parsed.quoteCurrency !== params.quoteCurrency) {
        resolved.push({
          input: raw,
          symbol: parsed.symbol,
          marketId: adapter.normalizeMarket(parsed.symbol, parsed.quoteCurrency),
          resolvedBy: 'marketId',
          mismatchReason: 'quote_currency_mismatch',
        });
        continue;
      }
      resolved.push({
        input: raw,
        symbol: parsed.symbol,
        marketId: adapter.normalizeMarket(parsed.symbol, params.quoteCurrency),
        resolvedBy: 'marketId',
        mismatchReason: null,
      });
      continue;
    }

    const symbol = normalizeContractSymbolInput(params.exchange, raw, params.quoteCurrency);
    resolved.push({
      input: raw,
      symbol,
      marketId: adapter.normalizeMarket(symbol, params.quoteCurrency),
      resolvedBy: 'symbol',
      mismatchReason: null,
    });
  }

  const unique = new Map<string, typeof resolved[number]>();
  for (const item of resolved) {
    const key = item.marketId ?? `${item.resolvedBy}:${item.input}`;
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  return Array.from(unique.values());
}

export async function getMarketSparklineBatch(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  symbols: string[];
  marketIds?: string[];
  interval?: ContractTimeframe;
  limit?: number;
  priority?: Exclude<SparklinePriority, 'normal'>;
}) {
  const startedAt = Date.now();
  const interval = params.interval ?? SPARKLINE_DEFAULT_INTERVAL;
  const limit = Math.min(Math.max(params.limit ?? SPARKLINE_DEFAULT_LIMIT, 1), SPARKLINE_LIMIT_MAX);
  const requestedInputCount = (params.marketIds && params.marketIds.length > 0 ? params.marketIds : params.symbols)
    .map((value) => value.trim())
    .filter(Boolean)
    .length;
  const priority: SparklinePriority = params.priority
    ?? (requestedInputCount >= 1 && requestedInputCount <= 4 && limit === SPARKLINE_LIMIT_MAX ? 'top' : 'normal');
  const isInteractivePriority = priority === 'top' || priority === 'interactive';
  const timeoutMs = isInteractivePriority ? SPARKLINE_TOP_RESPONSE_TIMEOUT_MS : SPARKLINE_PROVIDER_TIMEOUT_MS;
  const providerTimeoutMs = isInteractivePriority ? SPARKLINE_TOP_PROVIDER_TIMEOUT_MS : SPARKLINE_PROVIDER_TIMEOUT_MS;
  const exchangeContract = getMarketExchangeContract(params.exchange);
  const requestedInputs = (params.marketIds && params.marketIds.length > 0 ? params.marketIds : params.symbols)
    .map((value) => value.trim())
    .filter(Boolean);
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedCount: requestedInputs.length,
      marketIdsCount: params.marketIds?.length ?? 0,
      symbolsCount: params.symbols.length,
      symbols: params.symbols,
      marketIds: params.marketIds ?? [],
      limit,
      interval,
      priority,
      timeoutMs,
    },
    `[SparklineRequest] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestedCount=${requestedInputs.length} marketIdsCount=${params.marketIds?.length ?? 0} symbolsCount=${params.symbols.length} limit=${limit} interval=${interval} priority=${priority}`,
  );
  if (isInteractivePriority) {
    logger.info(
      {
        domain: 'market-contract',
        priority,
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        marketIds: params.marketIds ?? [],
        requestedCount: requestedInputs.length,
        limit,
        interval,
        timeoutMs,
      },
      `[SparklineTopRequest] priority=${priority} exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketIds=${(params.marketIds ?? []).join(',')} requestedCount=${requestedInputs.length} limit=${limit} interval=${interval} timeoutMs=${timeoutMs}`,
    );
  }
  if (!isQuoteCurrencySupported(params.exchange, params.quoteCurrency)) {
    logger.info(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        requestedQuoteCurrency: params.quoteCurrency,
        supportedQuotes: exchangeContract.supportedQuotes,
        reason: 'quote_currency_not_supported',
      },
      `[MarketTickerUnsupportedQuote] exchange=${params.exchange} requestedQuoteCurrency=${params.quoteCurrency} supportedQuotes=${exchangeContract.supportedQuotes.join(',')} reason=quote_currency_not_supported`,
    );
    return {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      interval,
      limit,
      items: [],
      missing: requestedInputs.map((input) => ({
        marketId: input,
        canonicalMarketId: null,
        symbol: null,
        reason: 'quote_currency_not_supported',
      })),
      unsupportedSymbols: requestedInputs,
      unavailableSymbols: [],
      diagnostics: {
        priority,
        timeoutMs,
        elapsedMs: Date.now() - startedAt,
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        requestedExchange: params.exchange,
        requestedQuoteCurrency: params.quoteCurrency,
        requestedCount: requestedInputs.length,
        returnedCount: 0,
        fullCount: 0,
        partialCount: 0,
        fallbackCount: 0,
        derivedCount: 0,
        realSeriesCount: 0,
        displayAllowedCount: 0,
        unavailableCount: 0,
        qualities: {},
        unsupported: true,
        unsupportedDetails: requestedInputs.map((input) => ({
          input,
          symbol: null,
          marketId: null,
          reason: 'quote_currency_not_supported',
          resolvedBy: params.marketIds && params.marketIds.length > 0 ? 'marketId' : 'symbol',
        })),
        reason: 'quote_currency_not_supported',
        supportedQuotes: exchangeContract.supportedQuotes,
        defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
        minPointCount: 0,
        maxPointCount: 0,
        cacheHitCount: 0,
        staleCacheHitCount: 0,
        ringBufferHitCount: 0,
        providerFetchCount: 0,
        providerTimeoutCount: 0,
        providerFailedCount: 0,
        resolveFailedCount: requestedInputs.length,
        quoteMismatchCount: 0,
        avgLatencyMs: 0,
        maxLatencyMs: 0,
        pointCountMin: 0,
        pointCountMax: 0,
        invalidPointCount: 0,
        heavyPathUsed: false,
      },
    };
  }
  const resolvedInputs = resolveSparklineInputs({
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    symbols: params.symbols,
    marketIds: params.marketIds,
  });
  if (resolvedInputs.length === 0) {
    throw new AppError(400, 'symbols is required', { field: 'symbols' }, 'INVALID_SYMBOLS');
  }
  if (resolvedInputs.length > SPARKLINE_SYMBOL_CAP) {
    throw new AppError(400, `symbols must contain at most ${SPARKLINE_SYMBOL_CAP} items`, {
      field: 'symbols',
      max: SPARKLINE_SYMBOL_CAP,
      requested: resolvedInputs.length,
    }, 'SYMBOLS_LIMIT_EXCEEDED');
  }

  contractSparklineHeavyPathUsed = false;
  const requested = new Set(resolvedInputs.map((item) => item.symbol).filter((symbol): symbol is string => Boolean(symbol)));
  let rowsBySymbol = new Map<string, MarketTickerItem>();
  let rowsByMarketId = new Map<string, MarketTickerItem>();
  activeContractSparklineRequests += 1;
  try {
    const tickerResponse = await getMarketTickerList({
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
    });
    rowsBySymbol = new Map(tickerResponse.items.map((item) => [item.symbol, item]));
    rowsByMarketId = new Map(tickerResponse.items.map((item) => [item.marketId.toUpperCase(), item]));
  } catch (error) {
    if (!isInteractivePriority) {
      throw error;
    }
    logger.warn(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        reason: error instanceof Error ? error.message : 'ticker_snapshot_unavailable',
      },
      '[SparklineTickerFallback] using synthetic rows after ticker snapshot lookup failed',
    );
    const targetItems = resolvedInputs
      .filter((input) => !input.mismatchReason && input.symbol && input.marketId)
      .map((input) => buildSyntheticTickerForSparkline({
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        symbol: input.symbol!,
        marketId: input.marketId!,
      }));
    rowsBySymbol = new Map(targetItems.map((item) => [item.symbol, item]));
    rowsByMarketId = new Map(targetItems.map((item) => [item.marketId.toUpperCase(), item]));
  } finally {
    activeContractSparklineRequests -= 1;
  }
  const unsupportedDetails = resolvedInputs
    .filter((input) => input.mismatchReason || !input.symbol || !input.marketId || !(rowsByMarketId.has(input.marketId.toUpperCase()) || rowsBySymbol.has(input.symbol)))
    .map((input) => ({
      input: input.input,
      symbol: input.symbol,
      marketId: input.marketId,
      reason: input.mismatchReason ?? 'market_not_found',
      resolvedBy: input.resolvedBy,
    }));
  const unsupportedSymbols = unsupportedDetails.map((input) => input.input);
  const quoteMismatchCount = unsupportedDetails.filter((input) => input.reason === 'quote_currency_mismatch').length;
  const resolveFailedCount = unsupportedDetails.length - quoteMismatchCount;
  let cacheHitCount = 0;
  let staleCacheHitCount = 0;
  let ringBufferHitCount = 0;
  let providerFetchCount = 0;
  let providerTimeoutCount = 0;
  let providerFailedCount = 0;
  const itemLatencies: number[] = [];
  for (const input of resolvedInputs) {
    const matchedTicker = input.marketId ? rowsByMarketId.get(input.marketId.toUpperCase()) ?? null : input.symbol ? rowsBySymbol.get(input.symbol) ?? null : null;
    const providerMarket = input.symbol ? resolveProviderMarket(params.exchange, input.symbol, params.quoteCurrency) : null;
    logger.info(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        input: input.input,
        resolvedMarketId: matchedTicker?.marketId ?? null,
        resolvedSymbol: input.symbol,
        displayPair: matchedTicker?.displayPair ?? null,
        providerMarket,
        resolvedBy: params.marketIds && params.marketIds.length > 0 ? 'marketId' : 'symbol',
        matchedTicker: Boolean(matchedTicker),
        supportedQuote: isQuoteCurrencySupported(params.exchange, params.quoteCurrency),
        mismatchReason: input.mismatchReason,
      },
      `[SparklineResolve] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} input=${input.input} resolvedMarketId=${matchedTicker?.marketId ?? ''} resolvedSymbol=${input.symbol ?? ''} displayPair=${matchedTicker?.displayPair ?? ''} resolvedBy=${input.resolvedBy} matchedTicker=${Boolean(matchedTicker)} supportedQuote=${isQuoteCurrencySupported(params.exchange, params.quoteCurrency)} mismatchReason=${input.mismatchReason ?? ''}`,
    );
    logger.info(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        requestedMarketId: input.input,
        canonicalMarketId: input.marketId,
        symbol: input.symbol,
      },
      `[SparklineKeyNormalize] requestedMarketId=${input.input} canonicalMarketId=${input.marketId ?? ''} symbol=${input.symbol ?? ''}`,
    );
    if (params.exchange === 'bithumb' || params.exchange === 'coinone' || params.exchange === 'korbit') {
      const resolveLogName = params.exchange === 'coinone'
        ? 'SparklineCoinoneResolve'
        : params.exchange === 'korbit'
          ? 'SparklineKorbitResolve'
          : 'SparklineBithumbResolve';
      const cacheKey = input.marketId ? preparedSparklineKey(params.exchange, params.quoteCurrency, input.marketId) : null;
      logger.info(
        {
          domain: 'market-contract',
          inputMarketId: input.input,
          canonicalMarketId: input.marketId,
          providerMarket,
          quoteCurrency: params.quoteCurrency,
          cacheKey,
          resolved: Boolean(matchedTicker && !input.mismatchReason),
          reason: input.mismatchReason ?? (matchedTicker ? 'ok' : 'market_not_found'),
        },
        `[${resolveLogName}] inputMarketId=${input.input} canonicalMarketId=${input.marketId ?? ''} providerMarket=${providerMarket ?? ''} quoteCurrency=${params.quoteCurrency} cacheKey=${cacheKey ?? ''} resolved=${Boolean(matchedTicker && !input.mismatchReason)} reason=${input.mismatchReason ?? (matchedTicker ? 'ok' : 'market_not_found')}`,
      );
    }
  }
  const rawItems = await Promise.all(resolvedInputs
    .filter((input) => !input.mismatchReason && input.symbol && input.marketId)
    .map((input) => rowsByMarketId.get(input.marketId!.toUpperCase()) ?? rowsBySymbol.get(input.symbol!))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(async (item) => {
      const itemStartedAt = Date.now();
      const providerMarket = resolveProviderMarket(params.exchange, item.symbol, params.quoteCurrency);
      const responseItem = params.exchange === 'binance'
        ? { ...item, marketId: providerMarket, market: providerMarket, exchangeSymbol: providerMarket }
        : item;
      const preparedKey = preparedSparklineKey(params.exchange, params.quoteCurrency, responseItem.marketId);
      const cachedSparkline = readCachedSparklineItem(preparedKey, true);
      const preparedPoints = preparedSparklineCache.get(preparedKey) ?? [];
      const ringPartialCandidate = buildPreparedSparklineItem({
        item: responseItem,
        points: preparedPoints,
        limit,
        interval,
        source: 'prepared_cache',
        sourceReason: 'ticker_snapshot_ring_buffer',
      });
      logger.info(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          marketId: responseItem.marketId,
          deadlineMs: providerTimeoutMs,
          hasFullCache: Boolean(cachedSparkline && cachedSparkline.pointCount >= limit && !cachedSparkline.stale),
          hasStaleCache: Boolean(cachedSparkline?.stale),
          hasRingPartial: Boolean(ringPartialCandidate && ringPartialCandidate.pointCount > 0 && ringPartialCandidate.pointCount < limit),
          providerWillFetch: !(cachedSparkline && cachedSparkline.pointCount >= limit && !cachedSparkline.stale),
        },
        `[SparklineItemDeadline] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${responseItem.marketId} deadlineMs=${providerTimeoutMs} hasFullCache=${Boolean(cachedSparkline && cachedSparkline.pointCount >= limit && !cachedSparkline.stale)} hasStaleCache=${Boolean(cachedSparkline?.stale)} hasRingPartial=${Boolean(ringPartialCandidate && ringPartialCandidate.pointCount > 0 && ringPartialCandidate.pointCount < limit)} providerWillFetch=${!(cachedSparkline && cachedSparkline.pointCount >= limit && !cachedSparkline.stale)}`,
      );
      if (cachedSparkline && isDisplayableRealSparkline(cachedSparkline)) {
        cacheHitCount += 1;
        if (cachedSparkline.stale) {
          staleCacheHitCount += 1;
        }
        itemLatencies.push(Date.now() - itemStartedAt);
        const decision: SparklineItemDecision = cachedSparkline.stale
          ? 'cache_stale_full'
          : cachedSparkline.pointCount >= limit
            ? 'cache_full'
            : 'cache_partial';
        const decided = withSparklineDecision(cachedSparkline, decision, {
          providerMarket,
          cacheKey: preparedKey,
          cacheHit: true,
          stale: cachedSparkline.stale,
          fallbackReason: cachedSparkline.stale ? 'stale_cache' : cachedSparkline.diagnostics.fallbackReason,
        });
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            key: preparedKey,
            cacheHit: true,
            ringBufferHit: false,
            providerNeeded: false,
            decision,
            pointCount: cachedSparkline.pointCount,
            quality: cachedSparkline.quality,
            elapsedMs: Date.now() - itemStartedAt,
          },
          `[SparklineFastPath] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} key=${preparedKey} cacheHit=true ringBufferHit=false providerNeeded=false decision=${decision} pointCount=${cachedSparkline.pointCount} quality=${cachedSparkline.quality} elapsedMs=${Date.now() - itemStartedAt}`,
        );
        if (decided.stale) {
          scheduleSparklineWarmup({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            items: [item],
            reason: 'stale_refresh',
          });
        }
        logSparklineItemDecision({
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          item: decided,
          elapsedMs: Date.now() - itemStartedAt,
          reason: decided.diagnostics.fallbackReason,
        });
        return decided;
      }
      const bufferDiagnostics = computeSparklineDiagnostics({
        rawPoints: preparedPoints,
        points: preparedPoints.map(toContractSparklinePoint),
        duplicateTimestampCount: 0,
        source: 'prepared_cache',
        quality: 'prepared_cache',
        isDerived: false,
        fallbackReason: preparedPoints.length > 0 ? null : 'missing_buffer_points',
        resolvedBy: 'ring_buffer',
      });
      logger.info(
        {
          domain: 'market-contract',
          key: preparedKey,
          pointCount: preparedPoints.length,
          uniqueValueCount: bufferDiagnostics.uniqueValueCount,
          firstTimestamp: preparedPoints[0]?.timestamp ?? null,
          lastTimestamp: preparedPoints[preparedPoints.length - 1]?.timestamp ?? null,
          min: bufferDiagnostics.minValue,
          max: bufferDiagnostics.maxValue,
          range: bufferDiagnostics.valueRange,
          mean: bufferDiagnostics.meanValue,
          rangeRatio: bufferDiagnostics.rangeRatio,
          duplicateTimestampCount: bufferDiagnostics.duplicateTimestampCount,
          zeroDeltaCount: bufferDiagnostics.zeroDeltaCount,
        },
        `[SparklineBufferRead] key=${preparedKey} pointCount=${preparedPoints.length} uniqueValueCount=${bufferDiagnostics.uniqueValueCount} firstTimestamp=${preparedPoints[0]?.timestamp ?? ''} lastTimestamp=${preparedPoints[preparedPoints.length - 1]?.timestamp ?? ''} min=${bufferDiagnostics.minValue ?? ''} max=${bufferDiagnostics.maxValue ?? ''} mean=${bufferDiagnostics.meanValue ?? ''} range=${bufferDiagnostics.valueRange} rangeRatio=${bufferDiagnostics.rangeRatio} duplicateTimestampCount=${bufferDiagnostics.duplicateTimestampCount} zeroDeltaCount=${bufferDiagnostics.zeroDeltaCount}`,
      );
      let partialFallback: ContractSparklineItem | null = null;
      const prepared = ringPartialCandidate;
      if (prepared) {
        const normalizedPrepared = writeRealSparklineCache(preparedKey, normalizeSparklineQuality(prepared));
        ringBufferHitCount += 1;
        const itemBuildMessage = `[SparklineItemBuild] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} displayPair=${item.displayPair} pointCount=${normalizedPrepared.pointCount} quality=${normalizedPrepared.quality} source=${normalizedPrepared.source} isDerived=${normalizedPrepared.isDerived} realSeries=${normalizedPrepared.realSeries} graphDisplayAllowed=${normalizedPrepared.graphDisplayAllowed} recommendedDisplayScale=${normalizedPrepared.recommendedDisplayScale} uniqueValueCount=${normalizedPrepared.diagnostics.uniqueValueCount} rangeRatio=${normalizedPrepared.diagnostics.rangeRatio} directionChanges=${normalizedPrepared.diagnostics.directionChanges} first=${normalizedPrepared.diagnostics.firstValue ?? ''} last=${normalizedPrepared.diagnostics.lastValue ?? ''} min=${normalizedPrepared.diagnostics.minValue ?? ''} max=${normalizedPrepared.diagnostics.maxValue ?? ''}`;
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            bufferKey: preparedKey,
            bufferPointCount: preparedPoints.length,
            returnedPointCount: normalizedPrepared.pointCount,
            quality: normalizedPrepared.quality,
            source: normalizedPrepared.source,
            isDerived: normalizedPrepared.isDerived,
            realSeries: normalizedPrepared.realSeries,
            graphDisplayAllowed: normalizedPrepared.graphDisplayAllowed,
            recommendedDisplayScale: normalizedPrepared.recommendedDisplayScale,
            uniqueValueCount: normalizedPrepared.diagnostics.uniqueValueCount,
            rangeRatio: normalizedPrepared.diagnostics.rangeRatio,
            directionChanges: normalizedPrepared.diagnostics.directionChanges,
            first: normalizedPrepared.diagnostics.firstValue,
            last: normalizedPrepared.diagnostics.lastValue,
            min: normalizedPrepared.diagnostics.minValue,
            max: normalizedPrepared.diagnostics.maxValue,
            reason: normalizedPrepared.sourceReason,
          },
          itemBuildMessage,
        );
        if (normalizedPrepared.partial && normalizedPrepared.realSeries) {
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              pointCount: normalizedPrepared.pointCount,
              requestedLimit: limit,
              coverageRatio: normalizedPrepared.diagnostics.coverageRatio,
              quality: normalizedPrepared.quality,
              realSeries: normalizedPrepared.realSeries,
              graphDisplayAllowed: normalizedPrepared.graphDisplayAllowed,
              partialReason: normalizedPrepared.diagnostics.partialReason,
            },
            `[SparklinePartialReturn] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} pointCount=${normalizedPrepared.pointCount} requestedLimit=${limit} coverageRatio=${normalizedPrepared.diagnostics.coverageRatio} quality=${normalizedPrepared.quality} realSeries=${normalizedPrepared.realSeries} graphDisplayAllowed=${normalizedPrepared.graphDisplayAllowed} partialReason=${normalizedPrepared.diagnostics.partialReason ?? ''}`,
          );
        }
        itemLatencies.push(Date.now() - itemStartedAt);
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            key: preparedKey,
            cacheHit: false,
            ringBufferHit: true,
            providerNeeded: isInteractivePriority && normalizedPrepared.partial,
            decision: normalizedPrepared.pointCount >= limit ? 'cache_full' : 'ring_partial',
            pointCount: normalizedPrepared.pointCount,
            quality: normalizedPrepared.quality,
            elapsedMs: Date.now() - itemStartedAt,
          },
          `[SparklineFastPath] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} key=${preparedKey} cacheHit=false ringBufferHit=true providerNeeded=${isInteractivePriority && normalizedPrepared.partial} decision=${normalizedPrepared.pointCount >= limit ? 'cache_full' : 'ring_partial'} pointCount=${normalizedPrepared.pointCount} quality=${normalizedPrepared.quality} elapsedMs=${Date.now() - itemStartedAt}`,
        );
        const decidedPrepared = withSparklineDecision(
          normalizedPrepared,
          normalizedPrepared.pointCount >= limit ? 'cache_full' : 'ring_partial',
          { providerMarket, cacheKey: preparedKey, ringBufferHit: true },
        );
        if (!isInteractivePriority || !normalizedPrepared.partial) {
          logSparklineItemDecision({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            item: decidedPrepared,
            elapsedMs: Date.now() - itemStartedAt,
            reason: decidedPrepared.diagnostics.fallbackReason,
          });
          return decidedPrepared;
        }
        partialFallback = decidedPrepared;
      }

      let providerFailureReason: string | null = null;
      const providerStartedAt = Date.now();
      providerFetchCount += 1;
      try {
        const timeoutSentinel = { timeout: true as const };
        const candleLoad = getAdapter(params.exchange).getCandles({
          exchange: params.exchange,
          symbol: item.symbol,
          quoteCurrency: params.quoteCurrency,
          timeframe: interval,
          limit,
        });
        void candleLoad.catch(() => undefined);
        const providerResult = await Promise.race([
          candleLoad.then((candles) => ({ timeout: false as const, candles })).catch((error) => {
            throw error;
          }),
          timeoutAfter(providerTimeoutMs, timeoutSentinel),
        ]);
        if (providerResult.timeout) {
          providerTimeoutCount += 1;
          providerFailureReason = 'provider_timeout';
          const providerLatencyMs = Date.now() - providerStartedAt;
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              providerMarket,
              success: false,
              pointCount: partialFallback?.pointCount ?? 0,
              latencyMs: providerLatencyMs,
              timeout: true,
              reason: providerFailureReason,
            },
            `[SparklineProviderQuickFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} providerMarket=${providerMarket} success=false pointCount=${partialFallback?.pointCount ?? 0} latencyMs=${providerLatencyMs} timeout=true reason=${providerFailureReason}`,
          );
          if (partialFallback) {
            const timeoutPartial = withSparklineDecision(partialFallback, 'timeout_with_partial', {
              providerMarket,
              cacheKey: preparedKey,
              providerFetched: true,
              providerLatencyMs,
              providerTimeout: true,
              providerError: providerFailureReason,
              fallbackReason: providerFailureReason,
            });
            itemLatencies.push(Date.now() - itemStartedAt);
            logSparklineItemDecision({
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              item: timeoutPartial,
              elapsedMs: Date.now() - itemStartedAt,
              reason: providerFailureReason,
            });
            return timeoutPartial;
          }
          const tickerPreviewFallback = buildFallbackSparklineItem(responseItem, limit, interval);
          if (tickerPreviewFallback.pointCount >= 2) {
            const timeoutPreview = withSparklineDecision(tickerPreviewFallback, 'timeout_with_partial', {
              providerMarket,
              cacheKey: preparedKey,
              providerFetched: true,
              providerLatencyMs,
              providerTimeout: true,
              providerError: providerFailureReason,
              fallbackReason: providerFailureReason,
              ringBufferHit: true,
            });
            ringBufferHitCount += 1;
            itemLatencies.push(Date.now() - itemStartedAt);
            logger.info(
              {
                domain: 'market-contract',
                key: preparedKey,
                pointCount: timeoutPreview.pointCount,
              },
              `[SparklineDerivedFallback] key=${preparedKey} pointCount=${timeoutPreview.pointCount}`,
            );
            logSparklineItemDecision({
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              item: timeoutPreview,
              elapsedMs: Date.now() - itemStartedAt,
              reason: providerFailureReason,
            });
            return timeoutPreview;
          }
          const unavailable = buildUnavailableSparklineItem({
            item: responseItem,
            limit,
            interval,
            fallbackReason: providerFailureReason,
            providerFetched: true,
            providerLatencyMs,
            providerTimeout: true,
          });
          const timeoutUnavailable = withSparklineDecision(unavailable, 'timeout_unavailable', {
            providerMarket,
            cacheKey: preparedKey,
            providerError: providerFailureReason,
          });
          itemLatencies.push(Date.now() - itemStartedAt);
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              provider: params.exchange,
              providerMarket,
              limit,
              interval,
              success: false,
              pointCount: 0,
              reason: providerFailureReason,
              latencyMs: providerLatencyMs,
            },
            `[SparklineProviderFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} provider=${params.exchange} providerMarket=${providerMarket} limit=${limit} interval=${interval} success=false pointCount=0 reason=${providerFailureReason} latencyMs=${providerLatencyMs}`,
          );
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              key: preparedKey,
              cacheHit: false,
              ringBufferHit: false,
              providerNeeded: true,
              decision: 'timeout_unavailable',
              pointCount: 0,
              quality: timeoutUnavailable.quality,
              elapsedMs: Date.now() - itemStartedAt,
            },
            `[SparklineFastPath] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} key=${preparedKey} cacheHit=false ringBufferHit=false providerNeeded=true decision=timeout_unavailable pointCount=0 quality=${timeoutUnavailable.quality} elapsedMs=${Date.now() - itemStartedAt}`,
          );
          logSparklineItemDecision({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            item: timeoutUnavailable,
            elapsedMs: Date.now() - itemStartedAt,
            reason: providerFailureReason,
          });
          return timeoutUnavailable;
        }
        const candles = providerResult.candles;
        const providerItem = buildProviderCandleSparklineItem({
          item: responseItem,
          candles,
          limit,
          interval,
        });
        const normalizedProvider = providerItem
          ? withProviderDiagnostics(providerItem, {
              providerLatencyMs: Date.now() - providerStartedAt,
              partialReason: providerItem.pointCount < limit ? 'provider_partial' : null,
            })
          : null;
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            providerMarket,
            success: Boolean(normalizedProvider?.realSeries),
            pointCount: normalizedProvider?.pointCount ?? candles.length,
            latencyMs: Date.now() - providerStartedAt,
            timeout: false,
            reason: normalizedProvider
              ? normalizedProvider.realSeries
                ? 'ok'
                : normalizedProvider.diagnostics.fallbackReason ?? normalizedProvider.sourceReason
              : 'insufficient_provider_points',
          },
          `[SparklineProviderQuickFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} providerMarket=${providerMarket} success=${Boolean(normalizedProvider?.realSeries)} pointCount=${normalizedProvider?.pointCount ?? candles.length} latencyMs=${Date.now() - providerStartedAt} timeout=false reason=${normalizedProvider ? (normalizedProvider.realSeries ? 'ok' : normalizedProvider.diagnostics.fallbackReason ?? normalizedProvider.sourceReason) : 'insufficient_provider_points'}`,
        );
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            provider: params.exchange,
            providerMarket,
            limit,
            interval,
            success: Boolean(normalizedProvider?.realSeries),
            pointCount: normalizedProvider?.pointCount ?? candles.length,
            reason: normalizedProvider
              ? normalizedProvider.realSeries
                ? 'ok'
                : normalizedProvider.diagnostics.fallbackReason ?? normalizedProvider.sourceReason
              : 'insufficient_provider_points',
            latencyMs: Date.now() - providerStartedAt,
          },
          `[SparklineProviderFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} provider=${params.exchange} providerMarket=${providerMarket} limit=${limit} interval=${interval} success=${Boolean(normalizedProvider?.realSeries)} pointCount=${normalizedProvider?.pointCount ?? candles.length} reason=${normalizedProvider ? (normalizedProvider.realSeries ? 'ok' : normalizedProvider.diagnostics.fallbackReason ?? normalizedProvider.sourceReason) : 'insufficient_provider_points'} latencyMs=${Date.now() - providerStartedAt}`,
        );
        if (normalizedProvider && (normalizedProvider.realSeries || normalizedProvider.pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS)) {
          const providerDecision: SparklineItemDecision = normalizedProvider.pointCount >= limit ? 'provider_full' : 'provider_partial';
          let decidedProvider = withSparklineDecision(normalizedProvider, providerDecision, {
            providerMarket,
            cacheKey: preparedKey,
            providerFetched: true,
            providerLatencyMs: Date.now() - providerStartedAt,
          });
          if (decidedProvider.realSeries) {
            decidedProvider = writeRealSparklineCache(preparedKey, decidedProvider);
          }
          const providerItemBuildMessage = `[SparklineItemBuild] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} displayPair=${item.displayPair} pointCount=${decidedProvider.pointCount} quality=${decidedProvider.quality} source=${decidedProvider.source} isDerived=${decidedProvider.isDerived} realSeries=${decidedProvider.realSeries} graphDisplayAllowed=${decidedProvider.graphDisplayAllowed} recommendedDisplayScale=${decidedProvider.recommendedDisplayScale} uniqueValueCount=${decidedProvider.diagnostics.uniqueValueCount} rangeRatio=${decidedProvider.diagnostics.rangeRatio} directionChanges=${decidedProvider.diagnostics.directionChanges} first=${decidedProvider.diagnostics.firstValue ?? ''} last=${decidedProvider.diagnostics.lastValue ?? ''} min=${decidedProvider.diagnostics.minValue ?? ''} max=${decidedProvider.diagnostics.maxValue ?? ''}`;
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              pointCount: decidedProvider.pointCount,
              quality: decidedProvider.quality,
              source: decidedProvider.source,
              isDerived: decidedProvider.isDerived,
              realSeries: decidedProvider.realSeries,
              graphDisplayAllowed: decidedProvider.graphDisplayAllowed,
              recommendedDisplayScale: decidedProvider.recommendedDisplayScale,
              uniqueValueCount: decidedProvider.diagnostics.uniqueValueCount,
              rangeRatio: decidedProvider.diagnostics.rangeRatio,
              directionChanges: decidedProvider.diagnostics.directionChanges,
              first: decidedProvider.diagnostics.firstValue,
              last: decidedProvider.diagnostics.lastValue,
              min: decidedProvider.diagnostics.minValue,
              max: decidedProvider.diagnostics.maxValue,
            },
            providerItemBuildMessage,
          );
          if (decidedProvider.partial && decidedProvider.realSeries) {
            logger.info(
              {
                domain: 'market-contract',
                exchange: params.exchange,
                quoteCurrency: params.quoteCurrency,
                marketId: item.marketId,
                pointCount: decidedProvider.pointCount,
                requestedLimit: limit,
                coverageRatio: decidedProvider.diagnostics.coverageRatio,
                quality: decidedProvider.quality,
                realSeries: decidedProvider.realSeries,
                graphDisplayAllowed: decidedProvider.graphDisplayAllowed,
                partialReason: decidedProvider.diagnostics.partialReason,
              },
              `[SparklinePartialReturn] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} pointCount=${decidedProvider.pointCount} requestedLimit=${limit} coverageRatio=${decidedProvider.diagnostics.coverageRatio} quality=${decidedProvider.quality} realSeries=${decidedProvider.realSeries} graphDisplayAllowed=${decidedProvider.graphDisplayAllowed} partialReason=${decidedProvider.diagnostics.partialReason ?? ''}`,
            );
          }
          itemLatencies.push(Date.now() - itemStartedAt);
          logger.info(
            {
              domain: 'market-contract',
              exchange: params.exchange,
              quoteCurrency: params.quoteCurrency,
              marketId: item.marketId,
              key: preparedKey,
              cacheHit: false,
              ringBufferHit: false,
              providerNeeded: true,
              decision: providerDecision,
              pointCount: decidedProvider.pointCount,
              quality: decidedProvider.quality,
              elapsedMs: Date.now() - itemStartedAt,
            },
            `[SparklineFastPath] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} key=${preparedKey} cacheHit=false ringBufferHit=false providerNeeded=true decision=${providerDecision} pointCount=${decidedProvider.pointCount} quality=${decidedProvider.quality} elapsedMs=${Date.now() - itemStartedAt}`,
          );
          logSparklineItemDecision({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            item: decidedProvider,
            elapsedMs: Date.now() - itemStartedAt,
            reason: decidedProvider.diagnostics.fallbackReason,
          });
          return decidedProvider;
        }
        providerFailureReason = normalizedProvider?.diagnostics.fallbackReason ?? 'insufficient_provider_points';
        if (partialFallback) {
          const providerUnavailablePartial = withSparklineDecision(partialFallback, 'provider_unavailable', {
            providerMarket,
            cacheKey: preparedKey,
            providerFetched: true,
            providerLatencyMs: Date.now() - providerStartedAt,
            providerError: providerFailureReason,
            fallbackReason: providerFailureReason,
          });
          itemLatencies.push(Date.now() - itemStartedAt);
          logSparklineItemDecision({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            item: providerUnavailablePartial,
            elapsedMs: Date.now() - itemStartedAt,
            reason: providerFailureReason,
          });
          return providerUnavailablePartial;
        }
      } catch (error) {
        providerFailureReason = 'provider_unavailable';
        providerFailedCount += 1;
        const providerLatencyMs = Date.now() - providerStartedAt;
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            provider: params.exchange,
            providerMarket,
            limit,
            interval,
            success: false,
            pointCount: 0,
            reason: providerFailureReason,
            latencyMs: providerLatencyMs,
          },
          `[SparklineProviderFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} provider=${params.exchange} providerMarket=${providerMarket} limit=${limit} interval=${interval} success=false pointCount=0 reason=${providerFailureReason} latencyMs=${providerLatencyMs}`,
        );
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            providerMarket,
            success: false,
            pointCount: partialFallback?.pointCount ?? 0,
            latencyMs: providerLatencyMs,
            timeout: false,
            reason: providerFailureReason,
          },
          `[SparklineProviderQuickFetch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} providerMarket=${providerMarket} success=false pointCount=${partialFallback?.pointCount ?? 0} latencyMs=${providerLatencyMs} timeout=false reason=${providerFailureReason}`,
        );
        if (partialFallback) {
          const providerUnavailablePartial = withSparklineDecision(partialFallback, 'provider_unavailable', {
            providerMarket,
            cacheKey: preparedKey,
            providerFetched: true,
            providerLatencyMs,
            providerError: providerFailureReason,
            fallbackReason: providerFailureReason,
          });
          itemLatencies.push(Date.now() - itemStartedAt);
          logSparklineItemDecision({
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            item: providerUnavailablePartial,
            elapsedMs: Date.now() - itemStartedAt,
            reason: providerFailureReason,
          });
          return providerUnavailablePartial;
        }
      }

      const lastKnownGood = lastKnownGoodSparklineCache.get(preparedKey);
      if (
        lastKnownGood
        && lastKnownGood.updatedAt !== null
        && Date.now() - lastKnownGood.updatedAt <= PREPARED_SPARKLINE_USABLE_STALE_MS
      ) {
        staleCacheHitCount += 1;
        const staleItem = withSparklineDecision(normalizeSparklineQuality({
          ...lastKnownGood,
          source: 'last_known_good' as const,
          sparklineSource: 'last_known_good' as const,
          quality: 'prepared_cache' as const,
          sparklineQuality: 'prepared_cache' as const,
          stale: true,
          sourceReason: providerFailureReason ?? 'last_known_good_prepared_sparkline',
          diagnostics: {
            ...lastKnownGood.diagnostics,
            fallbackReason: providerFailureReason ?? 'last_known_good_prepared_sparkline',
            resolvedBy: 'last_known_good',
          },
        }), 'cache_stale_full', {
          providerMarket,
          cacheKey: preparedKey,
          stale: true,
          providerFetched: true,
          providerError: providerFailureReason,
          fallbackReason: providerFailureReason ?? 'last_known_good_prepared_sparkline',
        });
        itemLatencies.push(Date.now() - itemStartedAt);
        scheduleSparklineWarmup({
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          items: [item],
          reason: 'stale_refresh',
        });
        logSparklineItemDecision({
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          item: staleItem,
          elapsedMs: Date.now() - itemStartedAt,
          reason: staleItem.diagnostics.fallbackReason,
        });
        return staleItem;
      }

      const tickerPreviewFallback = buildFallbackSparklineItem(responseItem, limit, interval);
      if (tickerPreviewFallback.pointCount >= 2) {
        const decidedPreview = withSparklineDecision(tickerPreviewFallback, 'provider_unavailable', {
          providerMarket,
          cacheKey: preparedKey,
          providerFetched: true,
          providerLatencyMs: Date.now() - providerStartedAt,
          providerError: providerFailureReason,
          fallbackReason: providerFailureReason ?? tickerPreviewFallback.sourceReason ?? 'ticker_preview_fallback',
          ringBufferHit: tickerPreviewFallback.diagnostics.resolvedBy === 'ticker_preview',
        });
        ringBufferHitCount += 1;
        itemLatencies.push(Date.now() - itemStartedAt);
        logger.info(
          {
            domain: 'market-contract',
            key: preparedKey,
            pointCount: decidedPreview.pointCount,
          },
          `[SparklineDerivedFallback] key=${preparedKey} pointCount=${decidedPreview.pointCount}`,
        );
        logSparklineItemDecision({
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          item: decidedPreview,
          elapsedMs: Date.now() - itemStartedAt,
          reason: decidedPreview.diagnostics.fallbackReason,
        });
        return decidedPreview;
      }

      const fallback = buildUnavailableSparklineItem({
        item: responseItem,
        limit,
        interval,
        fallbackReason: providerFailureReason ?? (preparedPoints.length > 0 ? 'insufficient_buffer_points' : 'missing_buffer_points'),
        providerFetched: true,
        providerLatencyMs: Date.now() - providerStartedAt,
        providerTimeout: providerFailureReason === 'provider_timeout',
      });
      const unavailableDecision: SparklineItemDecision = providerFailureReason === 'provider_timeout' ? 'timeout_unavailable' : 'provider_unavailable';
      const decidedFallback = withSparklineDecision(fallback, unavailableDecision, {
        providerMarket,
        cacheKey: preparedKey,
        providerError: providerFailureReason,
      });
      logger.info(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          marketId: item.marketId,
          bufferKey: preparedKey,
          reason: decidedFallback.diagnostics.fallbackReason,
          fallbackPointCount: decidedFallback.pointCount,
          quality: decidedFallback.quality,
        },
        `[SparklineFallback] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} reason=${decidedFallback.diagnostics.fallbackReason} bufferPointCount=${preparedPoints.length} fallbackPointCount=${decidedFallback.pointCount} quality=${decidedFallback.quality}`,
      );
      itemLatencies.push(Date.now() - itemStartedAt);
      logSparklineItemDecision({
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        item: decidedFallback,
        elapsedMs: Date.now() - itemStartedAt,
        reason: decidedFallback.diagnostics.fallbackReason,
      });
      return decidedFallback;
    }));
  const items = rawItems.map((item) => {
    const cached = withCacheDiagnostics(item, {
      cacheKey: preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId),
      newQuality: item.quality,
    });
    const publicQuality = toPublicBatchSparklineQuality(cached);
    return {
      ...cached,
      marketId: cached.marketId,
      canonicalMarketId: cached.canonicalMarketId ?? cached.marketId,
      quality: publicQuality,
      sparklineQuality: publicQuality,
      unavailableReason: cached.pointCount >= 2
        ? null
        : cached.unavailableReason ?? cached.diagnostics.fallbackReason ?? cached.sourceReason ?? 'insufficient_points',
    };
  });
  const unavailableSymbols = items
    .filter((item) => item.pointCount < 2)
    .map((item) => item.symbol)
    .filter((symbol) => requested.has(symbol));
  const missing = [
    ...unsupportedDetails.map((item) => ({
      marketId: item.marketId ?? item.input,
      canonicalMarketId: item.marketId,
      symbol: item.symbol,
      reason: item.reason,
    })),
    ...items
      .filter((item) => item.pointCount < 2)
      .map((item) => ({
        marketId: item.marketId,
        canonicalMarketId: item.canonicalMarketId,
        symbol: item.symbol,
        reason: item.unavailableReason ?? item.diagnostics.fallbackReason ?? 'insufficient_points',
      })),
  ];
  const qualities = items.reduce<Record<string, number>>((summary, item) => {
    summary[item.quality] = (summary[item.quality] ?? 0) + 1;
    return summary;
  }, {});
  const fullCount = items.filter((item) => item.realSeries && item.pointCount >= limit).length;
  const partialCount = items.filter((item) => item.realSeries && item.pointCount > 0 && item.pointCount < limit).length;
  const staleCount = items.filter((item) => item.stale || item.diagnostics.stale).length;
  const fallbackCount = items.filter((item) => !item.realSeries || item.isDerived).length;
  const derivedCount = items.filter((item) => item.isDerived).length;
  const displayAllowedCount = items.filter((item) => item.graphDisplayAllowed).length;
  const unavailableCount = unavailableSymbols.length;
  const avgLatencyMs = itemLatencies.length > 0
    ? Math.round(itemLatencies.reduce((sum, value) => sum + value, 0) / itemLatencies.length)
    : 0;
  const maxLatencyMs = itemLatencies.length > 0 ? Math.max(...itemLatencies) : 0;
  const heavyPathUsed = isInteractivePriority ? false : contractSparklineHeavyPathUsed || providerFetchCount > 0;

  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedCount: resolvedInputs.length,
      providerFetchCount,
      timeoutMs: providerTimeoutMs,
      successCount: items.filter((item) => item.realSeries).length,
      timeoutCount: providerTimeoutCount,
      failedCount: fallbackCount,
      elapsedMs: Date.now() - startedAt,
    },
    `[SparklineProviderBatch] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestedCount=${resolvedInputs.length} providerFetchCount=${providerFetchCount} timeoutMs=${providerTimeoutMs} successCount=${items.filter((item) => item.realSeries).length} timeoutCount=${providerTimeoutCount} failedCount=${fallbackCount} elapsedMs=${Date.now() - startedAt}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      priority,
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedCount: resolvedInputs.length,
      displayAllowedCount,
      partialCount,
      fullCount,
      staleCount,
      unavailableCount,
      elapsedMs: Date.now() - startedAt,
      providerTimeoutCount,
      resolveFailedCount,
      quoteMismatchCount,
    },
    `[SparklineResponseSummary] priority=${priority} exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} requestedCount=${resolvedInputs.length} displayAllowedCount=${displayAllowedCount} partialCount=${partialCount} fullCount=${fullCount} staleCount=${staleCount} unavailableCount=${unavailableCount} elapsedMs=${Date.now() - startedAt} providerTimeoutCount=${providerTimeoutCount} resolveFailedCount=${resolveFailedCount} quoteMismatchCount=${quoteMismatchCount}`,
  );
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      interval,
      requested: resolvedInputs.length,
      returned: items.length,
      missing: missing.length,
      live: items.filter((item) => item.quality === 'liveDetailed').length,
      stale: items.filter((item) => item.quality === 'staleRealSeries').length,
      derived: items.filter((item) => item.quality === 'derivedPreview').length,
      unavailable: missing.length,
    },
    `[SparklineBatchSummary] requested=${resolvedInputs.length} returned=${items.length} missing=${missing.length} live=${items.filter((item) => item.quality === 'liveDetailed').length} stale=${items.filter((item) => item.quality === 'staleRealSeries').length} derived=${items.filter((item) => item.quality === 'derivedPreview').length} unavailable=${missing.length}`,
  );
  for (const item of missing) {
    logger.info(
      {
        domain: 'market-contract',
        exchange: params.exchange,
        quoteCurrency: params.quoteCurrency,
        marketId: item.marketId,
        reason: item.reason,
      },
      `[SparklineMissing] marketId=${item.marketId} reason=${item.reason}`,
    );
  }

  return {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    supportedQuotes: exchangeContract.supportedQuotes,
    defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
    interval,
    limit,
    items,
    missing,
    unsupportedSymbols,
    unavailableSymbols,
    diagnostics: {
      priority,
      timeoutMs,
      elapsedMs: Date.now() - startedAt,
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      requestedExchange: params.exchange,
      requestedQuoteCurrency: params.quoteCurrency,
      requestedCount: resolvedInputs.length,
      returnedCount: items.length,
      fullCount,
      partialCount,
      staleCount,
      fallbackCount,
      derivedCount,
      realSeriesCount: items.filter((item) => item.realSeries).length,
      displayAllowedCount,
      unavailableCount,
      qualities,
      cacheHitCount,
      staleCacheHitCount,
      ringBufferHitCount,
      providerFetchCount,
      providerTimeoutCount,
      providerFailedCount,
      resolveFailedCount,
      quoteMismatchCount,
      avgLatencyMs,
      maxLatencyMs,
      unsupported: false,
      unsupportedDetails,
      reason: null,
      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      minPointCount: items.length > 0 ? Math.min(...items.map((item) => item.pointCount)) : 0,
      maxPointCount: items.length > 0 ? Math.max(...items.map((item) => item.pointCount)) : 0,
      pointCountMin: items.length > 0 ? Math.min(...items.map((item) => item.pointCount)) : 0,
      pointCountMax: items.length > 0 ? Math.max(...items.map((item) => item.pointCount)) : 0,
      invalidPointCount: items.reduce((sum, item) => sum + (item.invalidPointCount ?? 0), 0),
      heavyPathUsed,
    },
  };
}

export async function getCurrentPriceSnapshots(markets: Array<{
  exchange: ContractExchange;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
}>): Promise<CurrentPriceSnapshot[]> {
  const byExchange = new Map<ContractExchange, string[]>();
  for (const item of markets) {
    const market = normalizeContractMarket(item.exchange, item.symbol, item.quoteCurrency);
    byExchange.set(item.exchange, [...(byExchange.get(item.exchange) ?? []), market]);
  }

  const results = await Promise.all(Array.from(byExchange.entries()).map(([exchange, marketCodes]) => (
    getAdapter(exchange).getCurrentPrices(marketCodes)
  )));
  return results.flat();
}

export function parseContractExchange(value: string | undefined): ContractExchange | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'upbit'
    || normalized === 'bithumb'
    || normalized === 'coinone'
    || normalized === 'korbit'
    || normalized === 'binance'
    ? normalized
    : null;
}

export function parseContractQuoteCurrency(value: string | undefined): ContractQuoteCurrency | null {
  const normalized = value?.trim().toUpperCase();
  return normalized === 'KRW' || normalized === 'BTC' || normalized === 'USDT' || normalized === 'ETH' ? normalized : null;
}

export function parseContractTimeframe(value: string | undefined): ContractTimeframe | null {
  const normalized = value?.trim().toUpperCase();
  return ['1M', '5M', '15M', '1H', '4H', '1D', '1W'].includes(normalized ?? '')
    ? normalized as ContractTimeframe
    : null;
}

export function parseTickerSort(value: string | undefined): TickerSort | undefined {
  if (!value) return undefined;
  const normalizedInput = value.trim();
  const normalized = normalizedInput === 'volume24h' || normalizedInput === 'volume_24h' || normalizedInput === 'tradeValue'
    ? 'volume'
    : normalizedInput === 'change' || normalizedInput === 'changeRate24h'
      ? 'changeRate'
      : normalizedInput === 'currentPrice'
        ? 'price'
        : normalizedInput === 'assetName' || normalizedInput === 'symbol'
          ? 'name'
          : normalizedInput === 'volume_desc'
    ? 'volume'
    : normalizedInput === 'change_desc'
      ? 'changeRate'
      : normalizedInput === 'price_desc'
        ? 'price'
        : normalizedInput === 'volume_asc'
          ? 'volume'
          : normalizedInput === 'change_asc'
            ? 'changeRate'
            : normalizedInput === 'price_asc'
              ? 'price'
              : normalizedInput;
  if (['volume', 'changeRate', 'price', 'name'].includes(normalized)) return normalized as TickerSort;
  throw new AppError(400, 'unsupported sort', { field: 'sort', acceptedValues: ['volume', 'changeRate', 'price', 'name', 'volume_desc', 'change_desc', 'price_desc'] }, 'INVALID_SORT');
}

export function parseTickerSortOrder(sort: string | undefined, order: string | undefined): SortOrder | undefined {
  if (order) {
    return parseSortOrder(order);
  }
  if (sort?.endsWith('_asc')) {
    return 'asc';
  }
  if (sort?.endsWith('_desc')) {
    return 'desc';
  }
  return undefined;
}

export function parseSortOrder(value: string | undefined): SortOrder | undefined {
  if (!value) return undefined;
  if (value === 'asc' || value === 'desc') return value;
  throw new AppError(400, 'unsupported order', { field: 'order', acceptedValues: ['asc', 'desc'] }, 'INVALID_ORDER');
}

export function parseContractLimit(value: string | undefined, defaultValue: number, max: number) {
  if (!value) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new AppError(400, `limit must be between 1 and ${max}`, { field: 'limit', max }, 'INVALID_LIMIT');
  }
  return parsed;
}
