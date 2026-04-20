import { COIN_MAP } from '../../config/constants';
import { env } from '../../config/env';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import type {
  DomesticExchangeId,
  FxRate,
  KimchiPremiumDelayBucket,
  KimchiPremiumDisplayHint,
  KimchiPremiumEntry,
  KimchiPremiumFailureStage,
  KimchiPremiumFreshnessState,
  KimchiPremiumQuote,
  KimchiPremiumRowStatus,
  KimchiPremiumSparklineStatus,
  KimchiPremiumStableStatus,
  KimchiPremiumStatusReason,
  MarketDataMode,
  SnapshotErrorCode,
  SnapshotItemStatus,
  SnapshotOverallStatus,
  SnapshotPartialFailure,
  SnapshotSource,
} from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';
import { AppError } from '../../utils/errors';
import { assetMetadataService } from '../assets/asset-metadata.service';
import {
  calculateDataAge,
  createFreshnessMetadata,
  getExchangeTickerLoads,
  isMarketDataStale,
  resolveTickerDataMode,
  type TickerSnapshotLoad,
  type TickerSnapshotSource,
} from '../market-data/ticker-snapshot.resolver';
import { marketIngestHealth } from '../market-data/market.ingest-health';
import {
  DEFAULT_KIMCHI_LIST_LIMIT,
  DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT,
  getRepresentativeSymbolsForExchange,
  PRIORITY_FRESHNESS_TARGET_MS,
} from '../market-data/market-priority';
import {
  getComparableKimchiSymbolSet,
  listComparableKimchiSymbols,
} from '../market-data/market-data.service';

const SUPPORTED_DOMESTIC_VENUES = ['upbit', 'bithumb', 'coinone', 'korbit'] as const satisfies readonly DomesticExchangeId[];
const DEFAULT_DOMESTIC_VENUE: DomesticExchangeId = 'upbit';
const KIMCHI_FRESH_THRESHOLD_MS = 5_000;
const KIMCHI_SLIGHTLY_STALE_THRESHOLD_MS = 20_000;
const KIMCHI_PROVIDER_TIMEOUT_MS = 1_800;
const KIMCHI_SPARKLINE_POINT_LIMIT = 60;
const KIMCHI_SPARKLINE_MIN_POINTS = 30;
const KIMCHI_SPARKLINE_SAMPLE_INTERVAL_MS = 5_000;
const KIMCHI_LAST_KNOWN_GOOD_TTL_MS = 15 * 60_000;

type KimchiSnapshotOutcome = 'cache_hit' | 'inflight_dedupe' | 'external_fetch' | 'stale_cache';
type KimchiSnapshotCacheKind = 'representative' | 'visible' | 'batch';
type KimchiResponseFreshnessBucket = 'fresh' | 'slightly_delayed' | 'delayed' | 'stale' | 'unavailable';
type KimchiRecommendedUiState = 'ready' | 'syncing' | 'delayed' | 'degraded';
type KimchiRecommendedInitialBadge = 'ready' | 'delayed' | 'sync';
type KimchiRepresentativeSource = 'fresh_cache' | 'stale_cache' | 'provider_fetch' | 'mixed' | 'none';
type KimchiHydrationPhase = 'representative_fast_path' | 'background_batch' | 'hydrated' | 'degraded';
type KimchiFullHydrationUiHint = 'ready' | 'background_hydration_only' | 'sync_required' | 'degraded';

type KimchiSnapshotLoad = {
  entries: KimchiPremiumEntry[];
  domesticVenues: DomesticExchangeId[];
  tickerSources: Array<{ exchange: 'binance' | DomesticExchangeId; symbol: string; source: TickerSnapshotSource }>;
  fxProvider: string | null;
  rowStatusSummary: Record<KimchiPremiumRowStatus, number>;
  resolvedSymbols: string[];
  droppedSymbols: Array<{ symbol: string; venue: DomesticExchangeId; reason: string }>;
  partialFailures: SnapshotPartialFailure[];
  status: SnapshotOverallStatus;
  source: SnapshotSource;
  asOf: number | null;
  freshnessMs: number | null;
  stale: boolean;
  supportedPairs: string[];
};

type KimchiSparklinePoint = {
  price: number;
  premiumPercent: number;
  timestamp: number;
};

export type KimchiPremiumSnapshotResponse = {
  domesticExchange: DomesticExchangeId;
  globalExchange: 'binance';
  items: KimchiPremiumEntry[];
  partialFailures: SnapshotPartialFailure[];
  supportedPairs: string[];
  status: SnapshotOverallStatus;
  source: SnapshotSource;
  asOf: number | null;
  freshnessMs: number | null;
  stale: boolean;
  total: number;
  cacheOutcome?: KimchiSnapshotOutcome;
  requestKind?: KimchiSnapshotCacheKind;
};

type KimchiPremiumSymbolFailure = {
  input?: string;
  symbol?: string;
  reason: string;
  retryable: boolean;
};

export type KimchiPremiumBatchResponse = KimchiPremiumSnapshotResponse & {
  requestedSymbols: string[];
  acceptedSymbols: string[];
  rejectedSymbols: KimchiPremiumSymbolFailure[];
  unsupportedSymbols: KimchiPremiumSymbolFailure[];
  unavailableSymbols: KimchiPremiumSymbolFailure[];
  partial: boolean;
  meta: {
    requestedCount: number;
    normalizedCount: number;
    acceptedCount: number;
    hydratedCount: number;
    rejectedCount: number;
    unsupportedCount: number;
    unavailableCount: number;
    staleCount: number;
    pendingEstimate: number;
    hydrationPhase: KimchiHydrationPhase;
    representativeHint: boolean;
    representativeReady: boolean;
    hasUsableRepresentativeData: boolean;
    representativeCount: number;
    lastRepresentativeUpdateAt: number | null;
    representativeFreshness: KimchiResponseFreshnessBucket;
    representativeFreshnessBucket: KimchiResponseFreshnessBucket;
    representativeSource: KimchiRepresentativeSource;
    recommendedUiState: KimchiRecommendedUiState;
    recommendedInitialBadge: KimchiRecommendedInitialBadge;
    fullHydrationPending: boolean;
    cacheSource: SnapshotSource;
    freshness: 'fresh' | 'stale';
    freshnessBucket: KimchiResponseFreshnessBucket;
    batchFreshnessBucket: KimchiResponseFreshnessBucket;
    uiHint: KimchiFullHydrationUiHint;
    generatedAt: number;
    representative: {
      ready: boolean;
      hasUsableData: boolean;
      count: number;
      lastUpdateAt: number | null;
      source: KimchiRepresentativeSource;
      freshnessBucket: KimchiResponseFreshnessBucket;
      recommendedInitialBadge: KimchiRecommendedInitialBadge;
    };
    fullHydration: {
      pending: boolean;
      phase: KimchiHydrationPhase;
      freshnessBucket: KimchiResponseFreshnessBucket;
      hydratedCount: number;
      unavailableCount: number;
      uiHint: KimchiFullHydrationUiHint;
    };
  };
};

export type KimchiPremiumDisplayStatus = 'fresh' | 'delayed' | 'partial' | 'unavailable';

export type KimchiPremiumViewportRow = {
  selectedExchange: DomesticExchangeId;
  sourceExchange: DomesticExchangeId | null;
  symbol: string;
  displayName: string;
  canonicalAssetKey: string | null;
  assetImageUrl: string | null;
  representative: boolean;
  updatedAt: number | null;
  displayStatus: KimchiPremiumDisplayStatus;
  stableStatus?: KimchiPremiumStableStatus;
  delayBucket?: KimchiPremiumDelayBucket;
  displayHint?: KimchiPremiumDisplayHint;
  hasUsableDomesticPrice?: boolean;
  hasUsableReferencePrice?: boolean;
  hasUsableFxRate?: boolean;
  lastSuccessfulDomesticAt?: number | null;
  lastSuccessfulReferenceAt?: number | null;
  lastSuccessfulFxAt?: number | null;
  partial: boolean;
  binanceKrwPrice: number | null;
  domesticPrice: number | null;
  premiumPercent: number | null;
  sparkline?: number[] | null;
  sparklinePointCount?: number | null;
  debugReasons?: string[];
};

type KimchiViewportDebugSymbol = {
  symbol: string;
  reason: string;
};

type KimchiViewportDebugMeta = {
  requestKind: 'representatives' | 'list' | 'sparkline';
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbolCount: number;
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  websocketMergeLagMs: number | null;
  staleReused: boolean;
  skippedSymbols: KimchiViewportDebugSymbol[];
};

type KimchiCursorPage = {
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
  total: number;
};

export type KimchiPremiumRepresentativesResponse = {
  selectedExchange: DomesticExchangeId;
  sourceExchange: DomesticExchangeId;
  updatedAt: number | null;
  displayStatus: KimchiPremiumDisplayStatus;
  partial: boolean;
  skippedSymbolCount: number;
  items: KimchiPremiumViewportRow[];
  page: KimchiCursorPage;
  meta?: {
    representativeReady: boolean;
    hasUsableRepresentativeData: boolean;
    representativeCount: number;
    lastRepresentativeUpdateAt: number | null;
    representativeFreshness: KimchiResponseFreshnessBucket;
    representativeFreshnessBucket: KimchiResponseFreshnessBucket;
    representativeSource: KimchiRepresentativeSource;
    recommendedUiState: KimchiRecommendedUiState;
    recommendedInitialBadge: KimchiRecommendedInitialBadge;
    fullHydrationPending: boolean;
    generatedAt: number;
    representative: {
      ready: boolean;
      hasUsableData: boolean;
      count: number;
      lastUpdateAt: number | null;
      source: KimchiRepresentativeSource;
      freshnessBucket: KimchiResponseFreshnessBucket;
      recommendedInitialBadge: KimchiRecommendedInitialBadge;
    };
    fullHydration: {
      pending: boolean;
      phase: KimchiHydrationPhase;
      freshnessBucket: KimchiResponseFreshnessBucket;
      uiHint: KimchiFullHydrationUiHint;
    };
  };
  debug?: KimchiViewportDebugMeta;
};

export type KimchiPremiumListResponse = KimchiPremiumRepresentativesResponse;

export type KimchiPremiumSparklineResponse = {
  selectedExchange: DomesticExchangeId;
  sourceExchange: DomesticExchangeId;
  updatedAt: number | null;
  displayStatus: KimchiPremiumDisplayStatus;
  partial: boolean;
  skippedSymbolCount: number;
  items: Array<Pick<
    KimchiPremiumViewportRow,
    | 'selectedExchange'
    | 'sourceExchange'
    | 'symbol'
    | 'displayName'
    | 'canonicalAssetKey'
    | 'assetImageUrl'
    | 'representative'
    | 'updatedAt'
    | 'displayStatus'
    | 'stableStatus'
    | 'delayBucket'
    | 'displayHint'
    | 'hasUsableDomesticPrice'
    | 'hasUsableReferencePrice'
    | 'hasUsableFxRate'
    | 'lastSuccessfulDomesticAt'
    | 'lastSuccessfulReferenceAt'
    | 'lastSuccessfulFxAt'
    | 'partial'
    | 'sparkline'
    | 'sparklinePointCount'
    | 'debugReasons'
  >>;
  debug?: KimchiViewportDebugMeta;
};

type CachedKimchiSnapshot = {
  value: KimchiSnapshotLoad;
  expiresAt: number;
  staleUntil: number;
};

type RepresentativeStabilitySummary = {
  representativeReady: boolean;
  hasUsableRepresentativeData: boolean;
  representativeCount: number;
  lastRepresentativeUpdateAt: number | null;
  representativeFreshness: KimchiResponseFreshnessBucket;
  representativeFreshnessBucket: KimchiResponseFreshnessBucket;
  representativeSource: KimchiRepresentativeSource;
};

const KIMCHI_SNAPSHOT_CACHE_POLICY: Record<KimchiSnapshotCacheKind, { ttlMs: number; staleTtlMs: number }> = {
  representative: { ttlMs: 2_500, staleTtlMs: 45_000 },
  visible: { ttlMs: 1_500, staleTtlMs: 12_000 },
  batch: { ttlMs: 1_000, staleTtlMs: 8_000 },
};

const kimchiRepresentativeSnapshotCache = new Map<string, CachedKimchiSnapshot>();
const kimchiVisibleSnapshotCache = new Map<string, CachedKimchiSnapshot>();
const kimchiBatchSnapshotCache = new Map<string, CachedKimchiSnapshot>();
const kimchiSnapshotInFlight = new Map<string, Promise<KimchiSnapshotLoad>>();
const kimchiSnapshotLastOutcome = new Map<string, KimchiSnapshotOutcome>();

class KimchiLastKnownGoodValueStore {
  private fxRate: FxRate | null = null;
  private readonly referenceTickers = new Map<string, NonNullable<TickerSnapshotLoad['ticker']>>();
  private readonly domesticTickers = new Map<string, NonNullable<TickerSnapshotLoad['ticker']>>();

  recordFx(rate: FxRate | null) {
    if (!rate || rate.provider.startsWith('last_good')) {
      return;
    }
    this.fxRate = rate;
  }

  recordReference(symbol: string, ticker: TickerSnapshotLoad['ticker']) {
    if (!ticker) {
      return;
    }
    this.referenceTickers.set(toCanonicalSymbol(symbol), ticker);
  }

  recordDomestic(exchange: DomesticExchangeId, symbol: string, ticker: TickerSnapshotLoad['ticker']) {
    if (!ticker) {
      return;
    }
    this.domesticTickers.set(this.domesticKey(exchange, symbol), ticker);
  }

  getFx(now = Date.now()) {
    if (!this.fxRate || !this.isUsable(this.fxRate.timestamp, now)) {
      return null;
    }
    return {
      ...this.fxRate,
      provider: `last_good:${this.fxRate.provider}`,
    };
  }

  getReference(symbol: string, now = Date.now()) {
    const ticker = this.referenceTickers.get(toCanonicalSymbol(symbol));
    return ticker && this.isUsable(ticker.timestamp, now) ? { ...ticker } : null;
  }

  getDomestic(exchange: DomesticExchangeId, symbol: string, now = Date.now()) {
    const ticker = this.domesticTickers.get(this.domesticKey(exchange, symbol));
    return ticker && this.isUsable(ticker.timestamp, now) ? { ...ticker } : null;
  }

  resetForTest() {
    this.fxRate = null;
    this.referenceTickers.clear();
    this.domesticTickers.clear();
  }

  private domesticKey(exchange: DomesticExchangeId, symbol: string) {
    return `${exchange}:${toCanonicalSymbol(symbol)}`;
  }

  private isUsable(timestamp: number, now: number) {
    return Math.max(now - timestamp, 0) <= KIMCHI_LAST_KNOWN_GOOD_TTL_MS;
  }
}

const kimchiLastKnownGoodStore = new KimchiLastKnownGoodValueStore();

function getKimchiSnapshotCacheBucket(kind: KimchiSnapshotCacheKind) {
  switch (kind) {
    case 'representative':
      return kimchiRepresentativeSnapshotCache;
    case 'visible':
      return kimchiVisibleSnapshotCache;
    case 'batch':
    default:
      return kimchiBatchSnapshotCache;
  }
}

function getKimchiSnapshotCachePolicy(kind: KimchiSnapshotCacheKind) {
  return KIMCHI_SNAPSHOT_CACHE_POLICY[kind];
}

function kimchiInFlightKey(kind: KimchiSnapshotCacheKind, cacheKey: string) {
  return `${kind}:${cacheKey}`;
}

function kimchiSparklineKey(exchange: DomesticExchangeId, symbol: string) {
  return `${exchange}:${symbol}`;
}

class KimchiPremiumSparklineStore {
  private readonly points = new Map<string, KimchiSparklinePoint[]>();

  record(params: {
    exchange: DomesticExchangeId;
    symbol: string;
    premiumPercent: number | null;
    timestamp: number;
  }) {
    if (
      params.premiumPercent === null
      || !Number.isFinite(params.premiumPercent)
      || !Number.isFinite(params.timestamp)
      || params.timestamp <= 0
    ) {
      return;
    }

    const key = kimchiSparklineKey(params.exchange, params.symbol);
    const buffer = this.points.get(key) ?? [];
    const last = buffer[buffer.length - 1];

    if (!last) {
      buffer.push({
        price: params.premiumPercent,
        premiumPercent: params.premiumPercent,
        timestamp: params.timestamp,
      });
    } else {
      const elapsedMs = Math.max(params.timestamp - last.timestamp, 0);
      if (elapsedMs >= KIMCHI_SPARKLINE_SAMPLE_INTERVAL_MS) {
        buffer.push({
          price: params.premiumPercent,
          premiumPercent: params.premiumPercent,
          timestamp: params.timestamp,
        });
      } else {
        last.price = params.premiumPercent;
        last.premiumPercent = params.premiumPercent;
        last.timestamp = Math.max(last.timestamp, params.timestamp);
      }
    }

    if (buffer.length > KIMCHI_SPARKLINE_POINT_LIMIT) {
      buffer.splice(0, buffer.length - KIMCHI_SPARKLINE_POINT_LIMIT);
    }

    this.points.set(key, buffer);
  }

  getPoints(exchange: DomesticExchangeId, symbol: string, limit = KIMCHI_SPARKLINE_POINT_LIMIT) {
    return (this.points.get(kimchiSparklineKey(exchange, symbol)) ?? [])
      .slice(-Math.max(limit, 0))
      .map((point) => ({ ...point }));
  }

  clearForTest() {
    this.points.clear();
  }
}

const kimchiPremiumSparklineStore = new KimchiPremiumSparklineStore();

function toCacheKey(symbols: string[], domesticVenues: DomesticExchangeId[]) {
  return `${[...domesticVenues].sort().join('|')}::${[...symbols].sort().join(',')}`;
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

function buildCursorPage(offset: number, limit: number, total: number): KimchiCursorPage {
  const nextOffset = offset + limit;
  return {
    cursor: offset > 0 ? String(offset) : null,
    nextCursor: nextOffset < total ? String(nextOffset) : null,
    limit,
    total,
  };
}

function summarizeViewportDisplayStatus(rows: Array<{ displayStatus: KimchiPremiumDisplayStatus }>, skippedSymbolCount: number) {
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

function computeViewportLagMs(rows: Array<{ updatedAt: number | null }>) {
  const lags = rows
    .map((row) => (row.updatedAt ? Math.max(Date.now() - row.updatedAt, 0) : null))
    .filter((lag): lag is number => lag !== null);

  return lags.length > 0 ? Math.max(...lags) : null;
}

function summarizeTickerSources(tickerSources: KimchiSnapshotLoad['tickerSources']) {
  return tickerSources.reduce<Record<string, number>>((summary, item) => {
    const key = `${item.exchange}:${item.source}`;
    summary[key] = (summary[key] ?? 0) + 1;
    return summary;
  }, {});
}

function summarizeRowStatuses(entries: KimchiPremiumEntry[]) {
  return entries.reduce<Record<KimchiPremiumRowStatus, number>>(
    (summary, entry) => {
      summary[entry.status] += 1;
      return summary;
    },
    { loaded: 0, stale: 0, partial: 0, unavailable: 0, failed: 0 },
  );
}

function logKimchiSnapshotOutcome(
  outcome: KimchiSnapshotOutcome,
  symbols: string[],
  payload: KimchiSnapshotLoad,
) {
  logger.info(
    {
      domain: 'kimchi-premium',
      operation: 'kimchi-premium',
      venue: payload.domesticVenues[0],
      venues: payload.domesticVenues,
      requestedSymbolCount: symbols.length,
      normalizedSymbolCount: symbols.length,
      responseItemCount: payload.entries.length,
      resolvedCount: payload.resolvedSymbols.length,
      returnedCount: payload.entries.length,
      skippedCount: payload.droppedSymbols.length,
      snapshotSource: outcome,
      fxProvider: payload.fxProvider,
      requestedSymbols: symbols,
      resolvedSymbols: payload.resolvedSymbols,
      returnedSymbols: payload.entries.map((entry) => entry.symbol),
      droppedSymbols: payload.droppedSymbols,
      tickerSources: summarizeTickerSources(payload.tickerSources),
      kimchiRowStatusSummary: payload.rowStatusSummary,
      ingestHealth: payload.domesticVenues.reduce<Record<string, ReturnType<typeof marketIngestHealth.getExchangeHealth>>>((summary, exchange) => {
        summary[exchange] = marketIngestHealth.getExchangeHealth(exchange);
        return summary;
      }, {}),
    },
    '[KimchiPremium] response_built',
  );
}

function serializeReason(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    promise
      .then(resolve, reject)
      .finally(() => clearTimeout(timeout));
  });
}

async function timedKimchiStage<T>(params: {
  stage: string;
  exchange?: DomesticExchangeId | 'binance' | 'fx';
  symbol?: string;
  timeoutMs?: number;
  run: () => Promise<T>;
}) {
  const startedAt = Date.now();
  logger.debug(
    {
      domain: 'kimchi-premium',
      operation: 'kimchi-premium',
      stage: params.stage,
      exchange: params.exchange,
      symbol: params.symbol,
      event: 'fetch_start',
    },
    '[KimchiPremium] fetch_start',
  );

  try {
    const result = params.timeoutMs
      ? await withTimeout(params.run(), params.timeoutMs, `${params.exchange ?? 'kimchi'} ${params.stage}`)
      : await params.run();
    const latencyMs = Date.now() - startedAt;
    const log = latencyMs > 1_000 ? logger.warn.bind(logger) : logger.debug.bind(logger);
    log(
      {
        domain: 'kimchi-premium',
        operation: 'kimchi-premium',
        stage: params.stage,
        exchange: params.exchange,
        symbol: params.symbol,
        event: 'fetch_end',
        latencyMs,
        slow: latencyMs > 1_000,
      },
      '[KimchiPremium] fetch_end',
    );
    return result;
  } catch (error) {
    logger.warn(
      {
        domain: 'kimchi-premium',
        operation: 'kimchi-premium',
        stage: params.stage,
        exchange: params.exchange,
        symbol: params.symbol,
        latencyMs: Date.now() - startedAt,
        err: error,
      },
      '[KimchiPremium] fetch_failed',
    );
    throw error;
  }
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

function collectMissingFields(fields: Array<string | null | undefined>) {
  return Array.from(new Set(fields.filter((field): field is string => Boolean(field)))).sort((left, right) => left.localeCompare(right));
}

function calculateStaleAge(timestamp: number | null | undefined) {
  return calculateDataAge(timestamp);
}

function determineSourceStaleReason(params: {
  timestamp: number | null;
  missing: boolean;
  staleThresholdMs: number;
  skewMs?: number | null;
  usesFallback?: boolean;
}) {
  if (params.missing) {
    return 'missing';
  }

  const ageMs = calculateStaleAge(params.timestamp);
  if (params.usesFallback) {
    return 'fallback_source';
  }
  if (ageMs !== null && ageMs > params.staleThresholdMs) {
    return 'stale_threshold_exceeded';
  }
  if (params.skewMs !== null && params.skewMs !== undefined && params.skewMs > env.FX_TIMESTAMP_SKEW_THRESHOLD_MS) {
    return 'timestamp_skew_exceeded';
  }

  return null;
}

function compactReason(parts: Array<string | null | undefined>) {
  const reasons = Array.from(new Set(parts.filter((part): part is string => Boolean(part))));
  return reasons.length > 0 ? reasons.join(',') : null;
}

function getSourceAgeMs(timestamp: number | null | undefined, now: number) {
  if (!timestamp) {
    return null;
  }

  return Math.max(now - timestamp, 0);
}

function determineKimchiFreshness(params: {
  hasReference: boolean;
  hasFx: boolean;
  hasDomestic: boolean;
  hasPremium: boolean;
  timestamps: {
    domestic: number | null;
    global: number | null;
    fx: number | null;
  };
  timestampSkewMs: number | null;
  usesFallbackFx: boolean;
  now: number;
}): {
  freshnessState: KimchiPremiumFreshnessState;
  freshnessReason: string | null;
  freshnessMs: number | null;
} {
  const ageBySource = {
    domestic: getSourceAgeMs(params.timestamps.domestic, params.now),
    global: getSourceAgeMs(params.timestamps.global, params.now),
    fx: getSourceAgeMs(params.timestamps.fx, params.now),
  };
  const availableAges = Object.values(ageBySource).filter((age): age is number => age !== null);
  const freshnessMs = availableAges.length > 0 ? Math.max(...availableAges) : null;

  if (!params.hasReference && !params.hasDomestic) {
    return {
      freshnessState: 'unavailable',
      freshnessReason: compactReason([
        'global_price_missing',
        'domestic_price_missing',
        params.hasFx ? null : 'fx_rate_missing',
      ]),
      freshnessMs,
    };
  }

  if (!params.hasReference || !params.hasFx || !params.hasDomestic || !params.hasPremium) {
    return {
      freshnessState: 'partial',
      freshnessReason: compactReason([
        params.hasReference ? null : 'global_price_missing',
        params.hasDomestic ? null : 'domestic_price_missing',
        params.hasFx ? null : 'fx_rate_missing',
        params.hasPremium ? null : 'premium_unavailable',
        params.usesFallbackFx ? 'fx_fallback_source' : null,
      ]),
      freshnessMs,
    };
  }

  const freshnessScoreMs = Math.max(freshnessMs ?? 0, params.timestampSkewMs ?? 0);
  const delayedReasons = [
    ageBySource.domestic !== null && ageBySource.domestic > KIMCHI_FRESH_THRESHOLD_MS ? 'domestic_price_delayed' : null,
    ageBySource.global !== null && ageBySource.global > KIMCHI_FRESH_THRESHOLD_MS ? 'global_price_delayed' : null,
    ageBySource.fx !== null && ageBySource.fx > KIMCHI_FRESH_THRESHOLD_MS ? 'fx_rate_delayed' : null,
    params.timestampSkewMs !== null && params.timestampSkewMs > KIMCHI_FRESH_THRESHOLD_MS ? 'timestamp_skew_detected' : null,
    params.usesFallbackFx ? 'fx_fallback_source' : null,
  ];

  if (freshnessScoreMs > KIMCHI_SLIGHTLY_STALE_THRESHOLD_MS || params.usesFallbackFx) {
    return {
      freshnessState: 'stale',
      freshnessReason: compactReason([
        ...delayedReasons,
        freshnessScoreMs > KIMCHI_SLIGHTLY_STALE_THRESHOLD_MS ? 'freshness_threshold_exceeded' : null,
      ]),
      freshnessMs,
    };
  }

  if (freshnessScoreMs > KIMCHI_FRESH_THRESHOLD_MS) {
    return {
      freshnessState: 'slightly_stale',
      freshnessReason: compactReason(delayedReasons),
      freshnessMs,
    };
  }

  return {
    freshnessState: 'fresh',
    freshnessReason: 'all_sources_fresh',
    freshnessMs,
  };
}

function summarizeDomesticVenueFreshness(
  entries: Array<{
    symbol: string;
    venue: DomesticExchangeId;
    load: TickerSnapshotLoad;
  }>,
) {
  return entries.reduce<Record<string, {
    comparedSymbolCount: number;
    loadedSymbolCount: number;
    latestAsOf: number | null;
    stalestAgeMs: number | null;
    sourceBreakdown: Record<string, number>;
    missingReasons: Record<string, number>;
  }>>((summary, entry) => {
    const bucket = summary[entry.venue] ?? {
      comparedSymbolCount: 0,
      loadedSymbolCount: 0,
      latestAsOf: null,
      stalestAgeMs: null,
      sourceBreakdown: {},
      missingReasons: {},
    };

    bucket.comparedSymbolCount += 1;
    bucket.sourceBreakdown[entry.load.source] = (bucket.sourceBreakdown[entry.load.source] ?? 0) + 1;
    if (entry.load.ticker) {
      bucket.loadedSymbolCount += 1;
      bucket.latestAsOf = bucket.latestAsOf === null ? entry.load.ticker.timestamp : Math.max(bucket.latestAsOf, entry.load.ticker.timestamp);
      const ageMs = calculateStaleAge(entry.load.ticker.timestamp);
      bucket.stalestAgeMs = bucket.stalestAgeMs === null ? ageMs : Math.max(bucket.stalestAgeMs ?? 0, ageMs ?? 0);
    } else {
      const reason = entry.load.reason ?? 'missing_domestic_snapshot';
      bucket.missingReasons[reason] = (bucket.missingReasons[reason] ?? 0) + 1;
    }

    summary[entry.venue] = bucket;
    return summary;
  }, {});
}

function buildFailedTickerLoadMap(symbols: string[], reason: string, error: unknown) {
  return new Map<string, TickerSnapshotLoad>(
    symbols.map((symbol) => [toCanonicalSymbol(symbol), {
      ticker: null,
      source: 'provider_snapshot',
      reason,
      error,
    }]),
  );
}

function isLastGoodTickerLoad(load: TickerSnapshotLoad | null | undefined) {
  return Boolean(load?.reason?.includes('last_good'));
}

function applyLastKnownGoodTicker(params: {
  component: 'reference' | 'domestic';
  exchange: DomesticExchangeId | 'binance';
  symbol: string;
  load: TickerSnapshotLoad;
}): TickerSnapshotLoad {
  if (params.load.ticker) {
    if (!isLastGoodTickerLoad(params.load)) {
      if (params.component === 'reference') {
        kimchiLastKnownGoodStore.recordReference(params.symbol, params.load.ticker);
      } else {
        kimchiLastKnownGoodStore.recordDomestic(params.exchange as DomesticExchangeId, params.symbol, params.load.ticker);
      }
    }
    return params.load;
  }

  const fallback = params.component === 'reference'
    ? kimchiLastKnownGoodStore.getReference(params.symbol)
    : kimchiLastKnownGoodStore.getDomestic(params.exchange as DomesticExchangeId, params.symbol);
  if (!fallback) {
    return params.load;
  }

  logger.info(
    {
      domain: 'kimchi-premium',
      symbol: params.symbol,
      component: params.component,
      exchange: params.exchange,
      reason: params.load.reason ?? null,
    },
    `[KimchiSnapshotDebug] action=retain_last_good symbol=${params.symbol} component=${params.component}`,
  );
  return {
    ticker: fallback,
    source: 'public_store_expired',
    reason: `last_good_${params.component}_retained${params.load.reason ? `:${params.load.reason}` : ''}`,
    error: params.load.error,
  };
}

function applyLastKnownGoodFx(rate: FxRate | null, error: unknown) {
  if (rate) {
    kimchiLastKnownGoodStore.recordFx(rate);
    return rate;
  }

  const fallback = kimchiLastKnownGoodStore.getFx();
  if (!fallback) {
    return null;
  }

  logger.info(
    {
      domain: 'kimchi-premium',
      symbol: 'USD/KRW',
      component: 'fx',
      reason: error ? serializeReason(error) : null,
    },
    '[KimchiSnapshotDebug] action=retain_last_good symbol=USD/KRW component=fx',
  );
  return fallback;
}

function isLastGoodFx(rate: FxRate | null) {
  return Boolean(rate?.provider.startsWith('last_good'));
}

function computeKimchiDelayBucket(timestamps: Array<number | null | undefined>): KimchiPremiumDelayBucket {
  const ages = timestamps
    .map((timestamp) => (timestamp ? Math.max(Date.now() - timestamp, 0) : null))
    .filter((age): age is number => age !== null);
  if (ages.length === 0) {
    return 'severe';
  }

  const maxAge = Math.max(...ages);
  if (maxAge <= KIMCHI_FRESH_THRESHOLD_MS) {
    return 'none';
  }
  if (maxAge <= KIMCHI_SLIGHTLY_STALE_THRESHOLD_MS) {
    return 'slight';
  }
  if (maxAge <= env.MARKET_DATA_STALE_THRESHOLD_MS) {
    return 'moderate';
  }
  return 'severe';
}

function buildKimchiDisplayMeta(params: {
  hasDomestic: boolean;
  hasReference: boolean;
  hasFx: boolean;
  lastDomesticAt: number | null;
  lastReferenceAt: number | null;
  lastFxAt: number | null;
  retainedLastGood: boolean;
  rowStatus: KimchiPremiumRowStatus;
  freshnessState: KimchiPremiumFreshnessState;
}): {
  status: KimchiPremiumStableStatus;
  hasUsableDomesticPrice: boolean;
  hasUsableReferencePrice: boolean;
  hasUsableFxRate: boolean;
  lastSuccessfulDomesticAt: number | null;
  lastSuccessfulReferenceAt: number | null;
  lastSuccessfulFxAt: number | null;
  delayBucket: KimchiPremiumDelayBucket;
  displayHint: KimchiPremiumDisplayHint;
} {
  const hasAnyUsable = params.hasDomestic || params.hasReference || params.hasFx;
  const allUsable = params.hasDomestic && params.hasReference && params.hasFx;
  const delayBucket = computeKimchiDelayBucket([
    params.lastDomesticAt,
    params.lastReferenceAt,
    params.lastFxAt,
  ]);
  const status: KimchiPremiumStableStatus = allUsable
    ? params.retainedLastGood || params.rowStatus === 'stale' || params.freshnessState === 'stale'
      ? 'stale'
      : 'ready'
    : hasAnyUsable
      ? 'partial'
      : 'unavailable';
  const displayHint: KimchiPremiumDisplayHint = status === 'unavailable'
    ? 'unavailable_cold'
    : status === 'ready'
      ? 'keep_last_good'
      : params.retainedLastGood || hasAnyUsable
        ? 'keep_last_good'
        : 'loading_initial';

  return {
    status,
    hasUsableDomesticPrice: params.hasDomestic,
    hasUsableReferencePrice: params.hasReference,
    hasUsableFxRate: params.hasFx,
    lastSuccessfulDomesticAt: params.lastDomesticAt,
    lastSuccessfulReferenceAt: params.lastReferenceAt,
    lastSuccessfulFxAt: params.lastFxAt,
    delayBucket,
    displayHint,
  };
}

function buildQuote(params: {
  exchange: DomesticExchangeId;
  ticker: NonNullable<TickerSnapshotLoad['ticker']>;
  convertedReferencePrice: number | null;
  reason?: string | null;
}): KimchiPremiumQuote {
  const staleAgeMs = calculateStaleAge(params.ticker.timestamp) ?? 0;
  const premiumPercent = params.convertedReferencePrice && params.convertedReferencePrice > 0
    ? ((params.ticker.price - params.convertedReferencePrice) / params.convertedReferencePrice) * 100
    : null;

  return {
    exchange: params.exchange,
    market: params.ticker.market,
    priceKrw: params.ticker.price,
    premiumPercent,
    timestamp: params.ticker.timestamp,
    sourceExchange: params.exchange,
    sourceTimestamp: params.ticker.timestamp,
    stale: isMarketDataStale(params.ticker.timestamp),
    staleAgeMs,
    krwConvertedReference: params.convertedReferencePrice,
    reason: params.reason ?? (premiumPercent === null ? 'missing_converted_reference_price' : null),
  };
}

function determineFailureStage(params: {
  missingFields: string[];
  hasReference: boolean;
  hasFx: boolean;
  hasDomestic: boolean;
  hasPremium: boolean;
}): KimchiPremiumFailureStage | null {
  if (!params.hasReference) {
    return 'reference_ticker';
  }
  if (!params.hasFx) {
    return 'fx_rate';
  }
  if (!params.hasDomestic) {
    return 'domestic_ticker';
  }
  if (!params.hasPremium || params.missingFields.includes('premiumPercent')) {
    return 'premium_compute';
  }

  return null;
}

function determineRowStatus(params: {
  missingFields: string[];
  hasReference: boolean;
  hasFx: boolean;
  hasDomestic: boolean;
  hasPremium: boolean;
  hasAnyProviderError: boolean;
  isStale: boolean;
}): KimchiPremiumRowStatus {
  if (params.missingFields.length === 0 && params.hasReference && params.hasFx && params.hasDomestic && params.hasPremium) {
    return params.isStale ? 'stale' : 'loaded';
  }

  const hasAnyValue = params.hasReference || params.hasDomestic;
  if (!hasAnyValue) {
    return params.hasAnyProviderError ? 'failed' : 'unavailable';
  }

  return 'partial';
}

function normalizeDomesticVenues(venues?: DomesticExchangeId[]) {
  const source = venues && venues.length > 0 ? venues : [DEFAULT_DOMESTIC_VENUE];
  return Array.from(new Set(source));
}

function mapKimchiDataModeToSource(
  dataMode: MarketDataMode,
  fxRate: FxRate | null,
): Exclude<SnapshotSource, 'mixed'> {
  if (fxRate?.provider === 'fallback') {
    return 'fallback';
  }
  if (dataMode === 'cached_snapshot') {
    return 'cache';
  }
  return 'derived';
}

function toKimchiPartialFailure(params: {
  code: SnapshotErrorCode;
  message: string;
  symbol: string;
  exchange?: DomesticExchangeId | 'binance' | 'fx';
  stage?: string;
  source?: SnapshotSource;
  retryable?: boolean;
}): SnapshotPartialFailure {
  return {
    code: params.code,
    message: params.message,
    symbol: params.symbol,
    exchange: params.exchange,
    stage: params.stage,
    source: params.source,
    retryable: params.retryable,
  };
}

function summarizeKimchiSnapshotStatus(entries: KimchiPremiumEntry[]) {
  const successful = entries.filter((entry) => entry.status !== 'failed' && entry.status !== 'unavailable');
  if (successful.length === 0) {
    return 'failure' as SnapshotOverallStatus;
  }

  return entries.some((entry) => entry.status !== 'loaded') ? 'partial_success' : 'success';
}

function summarizeKimchiSnapshotSource(entries: KimchiPremiumEntry[]): SnapshotSource {
  const sources = Array.from(new Set(entries.map((entry) => entry.source ?? 'derived')));
  if (sources.length === 0) {
    return 'derived';
  }
  if (sources.length === 1) {
    return sources[0];
  }
  return 'mixed';
}

function kimchiFreshnessBucketRank(bucket: KimchiResponseFreshnessBucket) {
  switch (bucket) {
    case 'fresh':
      return 0;
    case 'slightly_delayed':
      return 1;
    case 'delayed':
      return 2;
    case 'stale':
      return 3;
    case 'unavailable':
    default:
      return 4;
  }
}

function mapKimchiFreshnessStateToBucket(state: KimchiPremiumFreshnessState | null | undefined): KimchiResponseFreshnessBucket {
  switch (state) {
    case 'fresh':
      return 'fresh';
    case 'slightly_stale':
      return 'slightly_delayed';
    case 'stale':
      return 'delayed';
    case 'partial':
      return 'stale';
    case 'unavailable':
    default:
      return 'unavailable';
  }
}

function mapKimchiAgeToFreshnessBucket(timestamp: number | null | undefined): KimchiResponseFreshnessBucket {
  if (!timestamp) {
    return 'unavailable';
  }

  const ageMs = Math.max(Date.now() - timestamp, 0);
  if (ageMs <= KIMCHI_FRESH_THRESHOLD_MS) {
    return 'fresh';
  }
  if (ageMs <= KIMCHI_SLIGHTLY_STALE_THRESHOLD_MS) {
    return 'slightly_delayed';
  }
  if (ageMs <= KIMCHI_SNAPSHOT_CACHE_POLICY.representative.staleTtlMs) {
    return 'delayed';
  }
  return 'stale';
}

function chooseWorseKimchiFreshnessBucket(
  left: KimchiResponseFreshnessBucket,
  right: KimchiResponseFreshnessBucket,
) {
  return kimchiFreshnessBucketRank(left) > kimchiFreshnessBucketRank(right) ? left : right;
}

function getKimchiEntryFreshnessBucket(entry: KimchiPremiumEntry): KimchiResponseFreshnessBucket {
  const stateBucket = mapKimchiFreshnessStateToBucket(entry.freshnessState);
  const timestampBucket = mapKimchiAgeToFreshnessBucket(entry.updatedAt ?? entry.lastUpdatedAt ?? entry.asOf ?? entry.computedAt);
  return chooseWorseKimchiFreshnessBucket(stateBucket, timestampBucket);
}

function summarizeKimchiFreshnessBucket(entries: KimchiPremiumEntry[]): KimchiResponseFreshnessBucket {
  const usableEntries = entries.filter((entry) => entry.status !== 'failed' && entry.status !== 'unavailable');
  if (usableEntries.length === 0) {
    return 'unavailable';
  }

  return usableEntries.reduce<KimchiResponseFreshnessBucket>((current, entry) => {
    const candidate = getKimchiEntryFreshnessBucket(entry);
    return chooseWorseKimchiFreshnessBucket(candidate, current);
  }, 'fresh');
}

function mapKimchiSnapshotToRepresentativeSource(params: {
  source: SnapshotSource;
  stale: boolean;
  cacheOutcome?: KimchiSnapshotOutcome;
}): KimchiRepresentativeSource {
  if (params.source === 'derived' && params.cacheOutcome === undefined) {
    return 'none';
  }

  if (params.source === 'mixed') {
    return 'mixed';
  }

  if (params.cacheOutcome === 'cache_hit' || params.cacheOutcome === 'inflight_dedupe') {
    return params.stale || params.source === 'fallback' ? 'stale_cache' : 'fresh_cache';
  }

  if (params.cacheOutcome === 'stale_cache') {
    return 'stale_cache';
  }

  return 'provider_fetch';
}

function isUsableRepresentativeEntry(entry: KimchiPremiumEntry) {
  return entry.status !== 'failed'
    && entry.status !== 'unavailable'
    && (entry.premiumPercent !== null || entry.domesticPrice !== null || entry.binanceKrwPrice !== null);
}

function summarizeRepresentativeStability(params: {
  entries: KimchiPremiumEntry[];
  representativeSymbols?: Set<string>;
  representativeSource: KimchiRepresentativeSource;
}): RepresentativeStabilitySummary {
  const representativeEntries = params.representativeSymbols
    ? params.entries.filter((entry) => params.representativeSymbols?.has(entry.symbol))
    : params.entries;
  const usableEntries = representativeEntries.filter(isUsableRepresentativeEntry);
  const updatedAtValues = usableEntries
    .map((entry) => entry.updatedAt ?? entry.lastUpdatedAt ?? null)
    .filter((value): value is number => value !== null);

  return {
    representativeReady: usableEntries.length > 0,
    hasUsableRepresentativeData: usableEntries.length > 0,
    representativeCount: usableEntries.length,
    lastRepresentativeUpdateAt: updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : null,
    representativeFreshness: summarizeKimchiFreshnessBucket(usableEntries),
    representativeFreshnessBucket: summarizeKimchiFreshnessBucket(usableEntries),
    representativeSource: params.representativeSource,
  };
}

function preferRepresentativeSummary(
  primary: RepresentativeStabilitySummary,
  fallback?: RepresentativeStabilitySummary | null,
): RepresentativeStabilitySummary {
  if (!fallback) {
    return primary;
  }

  if (primary.representativeReady !== fallback.representativeReady) {
    return primary.representativeReady ? primary : fallback;
  }

  if (primary.representativeCount !== fallback.representativeCount) {
    return primary.representativeCount > fallback.representativeCount ? primary : fallback;
  }

  const primaryFreshnessRank = kimchiFreshnessBucketRank(primary.representativeFreshness);
  const fallbackFreshnessRank = kimchiFreshnessBucketRank(fallback.representativeFreshness);
  if (primaryFreshnessRank !== fallbackFreshnessRank) {
    return primaryFreshnessRank < fallbackFreshnessRank ? primary : fallback;
  }

  return (primary.lastRepresentativeUpdateAt ?? 0) >= (fallback.lastRepresentativeUpdateAt ?? 0)
    ? primary
    : fallback;
}

function getRepresentativeCacheSummary(exchange: DomesticExchangeId): RepresentativeStabilitySummary | null {
  const now = Date.now();
  let preferred: RepresentativeStabilitySummary | null = null;

  for (const cached of kimchiRepresentativeSnapshotCache.values()) {
    if (cached.value.domesticVenues[0] !== exchange || cached.staleUntil <= now) {
      continue;
    }

    const summary = summarizeRepresentativeStability({
      entries: cached.value.entries,
      representativeSource: cached.expiresAt > now && !cached.value.stale
        ? 'fresh_cache'
        : 'stale_cache',
    });
    preferred = preferRepresentativeSummary(summary, preferred);
  }

  return preferred;
}

function determineRecommendedUiState(params: {
  representativeReady: boolean;
  freshness: KimchiResponseFreshnessBucket;
  hydrationPhase: KimchiHydrationPhase;
  unavailableCount: number;
}): KimchiRecommendedUiState {
  if (params.representativeReady) {
    if (params.freshness === 'fresh' || params.freshness === 'slightly_delayed') {
      return 'ready';
    }
    if (params.freshness === 'delayed' || params.freshness === 'stale') {
      return 'delayed';
    }
    return 'degraded';
  }

  if (params.unavailableCount > 0 && params.hydrationPhase === 'degraded') {
    return 'degraded';
  }

  return 'syncing';
}

function determineRecommendedInitialBadge(params: {
  hasUsableRepresentativeData: boolean;
  freshness: KimchiResponseFreshnessBucket;
}): KimchiRecommendedInitialBadge {
  if (!params.hasUsableRepresentativeData) {
    return 'sync';
  }

  if (params.freshness === 'fresh' || params.freshness === 'slightly_delayed') {
    return 'ready';
  }

  return 'delayed';
}

function determineFullHydrationUiHint(params: {
  representativeReady: boolean;
  hydrationPhase: KimchiHydrationPhase;
  unavailableCount: number;
  fullHydrationPending: boolean;
}): KimchiFullHydrationUiHint {
  if (params.hydrationPhase === 'degraded' && !params.representativeReady) {
    return 'degraded';
  }
  if (params.representativeReady && (params.fullHydrationPending || params.hydrationPhase === 'background_batch' || params.unavailableCount > 0)) {
    return 'background_hydration_only';
  }
  if (params.representativeReady) {
    return 'ready';
  }
  return 'sync_required';
}

function determineHydrationPhase(params: {
  requestedCount: number;
  acceptedCount: number;
  hydratedCount: number;
  unavailableCount: number;
}): KimchiHydrationPhase {
  if (params.acceptedCount === 0 && params.unavailableCount > 0) {
    return 'degraded';
  }

  if (params.requestedCount <= DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT) {
    return 'representative_fast_path';
  }

  if (params.hydratedCount < params.acceptedCount || params.unavailableCount > 0) {
    return 'background_batch';
  }

  return 'hydrated';
}

function chunkKimchiSymbols(symbols: string[], size: number) {
  if (size <= 0 || symbols.length <= size) {
    return [symbols];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }
  return chunks;
}

function buildKimchiFailedChunkLoad(
  symbols: string[],
  domesticVenues: DomesticExchangeId[],
  reason: string,
): KimchiSnapshotLoad {
  const primaryVenue = domesticVenues[0];
  const now = Date.now();
  const entries = symbols.map<KimchiPremiumEntry>((symbol) => {
    const canonicalSymbol = toCanonicalSymbol(symbol);
    const coin = COIN_MAP.get(canonicalSymbol);
    return {
      symbol: canonicalSymbol,
      nameKo: coin?.nameKo ?? canonicalSymbol,
      nameEn: coin?.nameEn ?? canonicalSymbol,
      quoteCurrency: 'KRW',
      status: 'failed',
      statusReason: 'UNKNOWN',
      domesticVenue: primaryVenue,
      missingFields: ['referencePrice', 'usdKrwRate', 'domesticPrice', 'premiumPercent'],
      failureStage: 'settlement',
      referenceExchange: null,
      referenceMarket: null,
      referenceTimestamp: null,
      referenceStale: true,
      referenceStaleAgeMs: null,
      binancePrice: null,
      binanceUsdtPrice: null,
      usdKrwRate: null,
      binanceKrwPrice: null,
      krwConvertedReference: null,
      domesticExchange: primaryVenue,
      domesticMarket: null,
      domesticPrice: null,
      domesticPriceKRW: null,
      premiumPercent: null,
      premiumAmountKRW: null,
      selectedExchange: primaryVenue,
      sourceExchange: null,
      domesticPriceTimestamp: null,
      globalPriceTimestamp: null,
      fxRateTimestamp: null,
      computedAt: now,
      freshnessState: 'unavailable',
      freshnessReason: reason,
      fxProvider: null,
      fxTimestamp: null,
      fxStale: true,
      fxStaleAgeMs: null,
      globalPrice: null,
      fxRate: null,
      convertedGlobalPriceKRW: null,
      domestic: [],
      sparkline: [],
      sparklinePoints: [],
      sparklineSource: 'unavailable',
      sparklineValueType: 'premium_percent',
      sparklineStatus: 'empty',
      sparklinePointCount: 0,
      pointCount: 0,
      rangeMin: null,
      rangeMax: null,
      sparklineLastUpdatedAt: null,
      sourceTimestamps: {
        reference: null,
        domestic: null,
        fx: null,
      },
      dataMode: 'cached_snapshot',
      isStale: true,
      updatedAt: null,
      lastUpdatedAt: null,
      sourceTimestamp: null,
      cacheAgeMs: null,
      stale: true,
      timestampSkewMs: null,
      asOf: null,
      freshnessMs: null,
      source: 'fallback',
      errorCode: 'EXCHANGE_TEMPORARILY_UNAVAILABLE',
      errorMessage: reason,
    };
  });

  return {
    entries,
    domesticVenues,
    tickerSources: [],
    fxProvider: null,
    rowStatusSummary: summarizeRowStatuses(entries),
    resolvedSymbols: [],
    droppedSymbols: entries.map((entry) => ({
      symbol: entry.symbol,
      venue: primaryVenue,
      reason,
    })),
    partialFailures: entries.map((entry) => toKimchiPartialFailure({
      symbol: entry.symbol,
      exchange: primaryVenue,
      code: 'EXCHANGE_TEMPORARILY_UNAVAILABLE',
      message: reason,
      source: 'fallback',
      stage: 'chunk_merge',
      retryable: true,
    })),
    status: 'failure',
    source: 'fallback',
    asOf: null,
    freshnessMs: null,
    stale: true,
    supportedPairs: [],
  };
}

function mergeKimchiSnapshotLoads(
  orderedSymbols: string[],
  loads: KimchiSnapshotLoad[],
  domesticVenues: DomesticExchangeId[],
): KimchiSnapshotLoad {
  const entryBySymbol = new Map<string, KimchiPremiumEntry>();
  const partialFailures: SnapshotPartialFailure[] = [];
  const partialFailureKeys = new Set<string>();

  for (const load of loads) {
    for (const entry of load.entries) {
      if (!entryBySymbol.has(entry.symbol)) {
        entryBySymbol.set(entry.symbol, entry);
      }
    }

    for (const failure of load.partialFailures) {
      const key = `${failure.symbol ?? 'unknown'}:${failure.code}:${failure.stage ?? 'none'}`;
      if (partialFailureKeys.has(key)) {
        continue;
      }
      partialFailureKeys.add(key);
      partialFailures.push(failure);
    }
  }

  const entries = orderedSymbols
    .map((symbol) => entryBySymbol.get(toCanonicalSymbol(symbol)))
    .filter((entry): entry is KimchiPremiumEntry => Boolean(entry));
  const freshnessValues = entries
    .map((entry) => entry.freshnessMs)
    .filter((value): value is number => value !== null && value !== undefined);
  const asOfValues = entries
    .map((entry) => entry.asOf)
    .filter((value): value is number => value !== null && value !== undefined);

  return {
    entries,
    domesticVenues,
    tickerSources: loads.flatMap((load) => load.tickerSources),
    fxProvider: loads.find((load) => load.fxProvider)?.fxProvider ?? null,
    rowStatusSummary: summarizeRowStatuses(entries),
    resolvedSymbols: Array.from(new Set(
      entries
        .filter((entry) => entry.status === 'loaded' || entry.status === 'stale')
        .map((entry) => entry.symbol),
    )).sort((left, right) => left.localeCompare(right)),
    droppedSymbols: loads.flatMap((load) => load.droppedSymbols),
    partialFailures,
    status: summarizeKimchiSnapshotStatus(entries),
    source: summarizeKimchiSnapshotSource(entries),
    asOf: asOfValues.length > 0 ? Math.max(...asOfValues) : null,
    freshnessMs: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
    stale: entries.some((entry) => entry.stale),
    supportedPairs: Array.from(new Set(loads.flatMap((load) => load.supportedPairs))).sort((left, right) => left.localeCompare(right)),
  };
}

function resolveKimchiDataMode(params: {
  referenceLoad: TickerSnapshotLoad;
  primaryDomesticLoad: TickerSnapshotLoad | null;
}): MarketDataMode {
  const modes = [
    params.referenceLoad.ticker ? resolveTickerDataMode(params.referenceLoad.source) : null,
    params.primaryDomesticLoad?.ticker ? resolveTickerDataMode(params.primaryDomesticLoad.source) : null,
  ].filter((mode): mode is MarketDataMode => mode !== null);

  if (modes.includes('cached_snapshot')) {
    return 'cached_snapshot';
  }
  if (modes.length > 0 && modes.every((mode) => mode === 'streaming')) {
    return 'streaming';
  }

  return 'snapshot';
}

function determineDroppedReason(params: {
  referenceLoad: TickerSnapshotLoad;
  primaryDomesticLoad: TickerSnapshotLoad | null;
  hasReference: boolean;
  hasFx: boolean;
  hasDomestic: boolean;
  hasPremium: boolean;
  isStale: boolean;
  fxError: unknown;
}) {
  if (!params.hasReference) {
    return params.referenceLoad.reason ?? 'missing_reference_snapshot';
  }
  if (!params.hasFx) {
    return params.fxError ? 'fx_rate_unavailable' : 'missing_fx_rate';
  }
  if (!params.hasDomestic) {
    return params.primaryDomesticLoad?.reason ?? 'missing_domestic_snapshot';
  }
  if (!params.hasPremium) {
    return 'missing_premium_fields';
  }
  if (params.isStale) {
    return 'stale_snapshot';
  }

  return 'unclassified';
}

function determineStatusReason(params: {
  hasReference: boolean;
  hasFx: boolean;
  hasDomestic: boolean;
  hasPremium: boolean;
  isStale: boolean;
  primaryDomesticLoad: TickerSnapshotLoad | null;
  referenceLoad: TickerSnapshotLoad;
}): KimchiPremiumStatusReason {
  if (!params.hasReference) {
    return 'BINANCE_REFERENCE_MISSING';
  }
  if (!params.hasFx) {
    return 'FX_RATE_UNAVAILABLE';
  }
  if (!params.hasDomestic) {
    if (params.primaryDomesticLoad?.reason?.includes('market')) {
      return 'DOMESTIC_MARKET_MISSING';
    }
    return 'DOMESTIC_TICKER_MISSING';
  }
  if (!params.hasPremium) {
    return 'PREMIUM_DATA_INCOMPLETE';
  }
  if (params.isStale) {
    return 'STALE_SNAPSHOT';
  }

  return 'READY';
}

function determineKimchiSnapshotErrorCode(params: {
  symbol: string;
  globalSupported: boolean;
  domesticSupported: boolean;
  hasReference: boolean;
  hasDomestic: boolean;
  hasFx: boolean;
  usesFallbackFx: boolean;
  isStale: boolean;
  hasAnyProviderError: boolean;
  registryMapped: boolean;
}): SnapshotErrorCode | null {
  if (!params.globalSupported && !params.domesticSupported) {
    return params.registryMapped ? 'UNSUPPORTED_SYMBOL' : 'SYMBOL_MAPPING_NOT_FOUND';
  }
  if (!params.globalSupported || !params.domesticSupported) {
    return 'UNSUPPORTED_SYMBOL';
  }
  if (!params.hasReference || !params.hasDomestic) {
    return params.hasAnyProviderError ? 'EXCHANGE_TEMPORARILY_UNAVAILABLE' : 'PARTIAL_DATA';
  }
  if (!params.hasFx || params.usesFallbackFx) {
    return 'FX_RATE_UNAVAILABLE';
  }
  if (params.isStale) {
    return 'SNAPSHOT_STALE';
  }

  return null;
}

function determineKimchiSnapshotErrorMessage(params: {
  symbol: string;
  code: SnapshotErrorCode | null;
  primaryVenue: DomesticExchangeId;
  globalSupported: boolean;
  domesticSupported: boolean;
  fxReason: unknown;
}) {
  switch (params.code) {
    case 'SYMBOL_MAPPING_NOT_FOUND':
      return `canonical mapping for ${params.symbol} is missing`;
    case 'UNSUPPORTED_SYMBOL':
      if (!params.globalSupported && params.domesticSupported) {
        return `${params.symbol} is not supported on binance`;
      }
      if (params.globalSupported && !params.domesticSupported) {
        return `${params.symbol} is not supported on ${params.primaryVenue}`;
      }
      return `${params.symbol} is not supported on the requested kimchi pair`;
    case 'FX_RATE_UNAVAILABLE':
      return params.fxReason ? `USD/KRW rate is unavailable: ${serializeReason(params.fxReason)}` : 'USD/KRW rate is unavailable';
    case 'EXCHANGE_TEMPORARILY_UNAVAILABLE':
      return `${params.symbol} ticker snapshot is temporarily unavailable`;
    case 'SNAPSHOT_STALE':
      return `${params.symbol} kimchi premium snapshot is stale`;
    case 'PARTIAL_DATA':
      return `${params.symbol} kimchi premium snapshot is incomplete`;
    default:
      return null;
  }
}

function buildKimchiSparkline(params: {
  exchange: DomesticExchangeId;
  symbol: string;
  premiumPercent: number | null;
  computedAt: number;
}) {
  kimchiPremiumSparklineStore.record({
    exchange: params.exchange,
    symbol: params.symbol,
    premiumPercent: params.premiumPercent,
    timestamp: params.computedAt,
  });

  const points = kimchiPremiumSparklineStore.getPoints(params.exchange, params.symbol, KIMCHI_SPARKLINE_POINT_LIMIT);
  if (points.length === 0) {
    return {
      points,
      source: 'unavailable' as const,
      status: 'empty' as KimchiPremiumSparklineStatus,
      pointCount: 0,
      rangeMin: null,
      rangeMax: null,
      lastUpdatedAt: null,
    };
  }

  const values = points.map((point) => point.premiumPercent);
  return {
    points,
    source: points.length >= 2 ? 'history' as const : 'current_sample' as const,
    status: points.length >= KIMCHI_SPARKLINE_MIN_POINTS ? 'ok' as const : 'insufficientData' as const,
    pointCount: points.length,
    rangeMin: Math.min(...values),
    rangeMax: Math.max(...values),
    lastUpdatedAt: points[points.length - 1]?.timestamp ?? null,
  };
}

function toKimchiViewportRow(params: {
  exchange: DomesticExchangeId;
  entry: KimchiPremiumEntry;
  representativeSymbols: Set<string>;
  includeSparkline: boolean;
  debug: boolean;
}): KimchiPremiumViewportRow {
  const displayStatus = params.entry.status === 'loaded'
    ? params.entry.stale
      ? 'delayed'
      : 'fresh'
    : params.entry.status === 'stale'
      ? 'delayed'
      : params.entry.status === 'partial'
        ? 'partial'
        : 'unavailable';
  const sparkline = params.includeSparkline && params.entry.sparklinePointCount >= 2 ? params.entry.sparkline : null;
  const debugReasons = [
    params.entry.freshnessReason,
    params.entry.statusReason === 'FX_RATE_UNAVAILABLE' ? 'fx_rate_delayed' : null,
    params.entry.timestampSkewMs !== null && params.entry.timestampSkewMs > env.FX_TIMESTAMP_SKEW_THRESHOLD_MS
      ? 'timestamp_skew_detected'
      : null,
    params.entry.source === 'fallback' ? 'fallback_source' : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    selectedExchange: params.exchange,
    sourceExchange: params.entry.sourceExchange,
    symbol: params.entry.symbol,
    displayName: params.entry.nameKo ?? params.entry.nameEn ?? params.entry.symbol,
    canonicalAssetKey: params.entry.symbol,
    assetImageUrl: null,
    representative: params.representativeSymbols.has(params.entry.symbol),
    updatedAt: params.entry.updatedAt ?? params.entry.domesticPriceTimestamp ?? params.entry.computedAt,
    displayStatus,
    stableStatus: params.entry.stableStatus ?? params.entry.displayMeta?.status,
    delayBucket: params.entry.delayBucket ?? params.entry.displayMeta?.delayBucket,
    displayHint: params.entry.displayHint ?? params.entry.displayMeta?.displayHint,
    hasUsableDomesticPrice: params.entry.hasUsableDomesticPrice ?? params.entry.displayMeta?.hasUsableDomesticPrice,
    hasUsableReferencePrice: params.entry.hasUsableReferencePrice ?? params.entry.displayMeta?.hasUsableReferencePrice,
    hasUsableFxRate: params.entry.hasUsableFxRate ?? params.entry.displayMeta?.hasUsableFxRate,
    lastSuccessfulDomesticAt: params.entry.lastSuccessfulDomesticAt ?? params.entry.displayMeta?.lastSuccessfulDomesticAt,
    lastSuccessfulReferenceAt: params.entry.lastSuccessfulReferenceAt ?? params.entry.displayMeta?.lastSuccessfulReferenceAt,
    lastSuccessfulFxAt: params.entry.lastSuccessfulFxAt ?? params.entry.displayMeta?.lastSuccessfulFxAt,
    partial: displayStatus === 'partial',
    binanceKrwPrice: params.entry.binanceKrwPrice,
    domesticPrice: params.entry.domesticPrice,
    premiumPercent: params.entry.premiumPercent,
    sparkline,
    sparklinePointCount: params.includeSparkline ? params.entry.sparklinePointCount : null,
    debugReasons: params.debug ? debugReasons : undefined,
  };
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

function logAssetImageProjectionBatch(
  route: string,
  rows: Array<{ symbol: string; canonicalAssetKey?: string | null; assetImageUrl?: string | null }>,
) {
  for (const row of rows) {
    logAssetImageProjection({
      route,
      symbol: row.symbol,
      canonicalAssetKey: row.canonicalAssetKey,
      assetImageUrl: row.assetImageUrl,
    });
  }
}

async function decorateKimchiViewportRows(rows: KimchiPremiumViewportRow[]) {
  if (rows.length === 0) {
    return rows;
  }

  const views = await assetMetadataService.getAssetViews(rows.map((row) => ({
    exchange: row.selectedExchange,
    symbol: row.symbol,
    displayName: row.displayName,
    canonicalAssetKey: row.canonicalAssetKey,
  })));

  return rows.map((row) => {
    const view = views.get(row.canonicalAssetKey ?? row.symbol);
    return {
      ...row,
      canonicalAssetKey: view?.canonicalAssetKey ?? row.canonicalAssetKey ?? row.symbol,
      assetImageUrl: view?.assetImageUrl ?? row.assetImageUrl ?? null,
    };
  });
}

function buildKimchiViewportResponse(params: {
  exchange: DomesticExchangeId;
  requestKind: 'representatives' | 'list' | 'sparkline';
  rows: KimchiPremiumViewportRow[];
  page?: KimchiCursorPage;
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbols: KimchiViewportDebugSymbol[];
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  debug: boolean;
  staleReused: boolean;
}): KimchiPremiumRepresentativesResponse | KimchiPremiumListResponse | KimchiPremiumSparklineResponse {
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
        websocketMergeLagMs: computeViewportLagMs(params.rows),
        staleReused: params.staleReused,
        skippedSymbols: params.skippedSymbols,
      } satisfies KimchiViewportDebugMeta
    : undefined;

  if (params.requestKind === 'sparkline') {
    return {
      ...responseBase,
      items: params.rows.map((row) => ({
        selectedExchange: row.selectedExchange,
        sourceExchange: row.sourceExchange,
        symbol: row.symbol,
        displayName: row.displayName,
        canonicalAssetKey: row.canonicalAssetKey,
        assetImageUrl: row.assetImageUrl,
        representative: row.representative,
        updatedAt: row.updatedAt,
        displayStatus: row.displayStatus,
        stableStatus: row.stableStatus,
        delayBucket: row.delayBucket,
        displayHint: row.displayHint,
        hasUsableDomesticPrice: row.hasUsableDomesticPrice,
        hasUsableReferencePrice: row.hasUsableReferencePrice,
        hasUsableFxRate: row.hasUsableFxRate,
        lastSuccessfulDomesticAt: row.lastSuccessfulDomesticAt,
        lastSuccessfulReferenceAt: row.lastSuccessfulReferenceAt,
        lastSuccessfulFxAt: row.lastSuccessfulFxAt,
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

function logKimchiViewportResponse(params: {
  exchange: DomesticExchangeId;
  requestKind: 'representatives' | 'list' | 'sparkline';
  requestedSymbolCount: number;
  mappedSymbolCount: number;
  skippedSymbols: KimchiViewportDebugSymbol[];
  firstPaintElapsedMs: number;
  hydrationElapsedMs: number;
  providerLatencyMs: number | null;
  staleReused: boolean;
  response: KimchiPremiumRepresentativesResponse | KimchiPremiumListResponse | KimchiPremiumSparklineResponse;
}) {
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      requestKind: params.requestKind,
      requestedSymbolCount: params.requestedSymbolCount,
      mappedSymbolCount: params.mappedSymbolCount,
      skippedSymbolCount: params.skippedSymbols.length,
      firstPaintElapsedMs: params.firstPaintElapsedMs,
      hydrationElapsedMs: params.hydrationElapsedMs,
      providerLatencyMs: params.providerLatencyMs,
      websocketMergeLagMs: computeViewportLagMs(params.response.items),
      staleReused: params.staleReused,
      returnedCount: params.response.items.length,
      displayStatus: params.response.displayStatus,
      skippedSymbols: params.skippedSymbols,
    },
    '[KimchiPremium] viewport_response',
  );
}

function measureKimchiPayload(response: unknown) {
  const serializeStartedAt = Date.now();
  const payload = JSON.stringify(response);
  return {
    serializeMs: Date.now() - serializeStartedAt,
    payloadBytes: Buffer.byteLength(payload),
  };
}

function logKimchiPayloadMetrics(params: {
  exchange: DomesticExchangeId;
  computeMs: number;
  payloadMode: 'slim' | 'full';
  response: unknown;
}) {
  const metrics = measureKimchiPayload(params.response);
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      computeMs: params.computeMs,
      serializeMs: metrics.serializeMs,
      payloadBytes: metrics.payloadBytes,
      payloadMode: params.payloadMode,
    },
    `[KimchiPerf] exchange=${params.exchange} computeMs=${params.computeMs} serializeMs=${metrics.serializeMs} payloadBytes=${metrics.payloadBytes}`,
  );
}

async function loadKimchiPremiumSnapshot(
  symbols: string[],
  domesticVenues: DomesticExchangeId[],
): Promise<KimchiSnapshotLoad> {
  let fxRate: FxRate | null = null;
  let fxError: unknown = null;
  try {
    fxRate = await timedKimchiStage({
      stage: 'fx_rate',
      exchange: 'fx',
      timeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS,
      run: () => exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate(),
    });
  } catch (error) {
    fxError = error;
    logger.warn({ domain: 'kimchi-premium', operation: 'kimchi-premium', stage: 'fx_rate', err: error }, 'Kimchi premium FX rate fetch failed');
  }
  fxRate = applyLastKnownGoodFx(fxRate, fxError);

  const [binanceMarkets, ...domesticMarkets] = await Promise.all([
    timedKimchiStage({
      stage: 'global_markets',
      exchange: 'binance',
      timeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS,
      run: () => exchangeProviderRegistry.getMarketDataProvider('binance').listMarkets(),
    }).catch((error) => {
      logger.warn({ domain: 'kimchi-premium', operation: 'kimchi-premium', stage: 'binance_markets', err: error }, 'Kimchi premium Binance market universe fetch failed');
      return [];
    }),
    ...domesticVenues.map((exchange) =>
      timedKimchiStage({
        stage: 'domestic_markets',
        exchange,
        timeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS,
        run: () => exchangeProviderRegistry.getMarketDataProvider(exchange).listMarkets(),
      }).catch((error) => {
        logger.warn({ domain: 'kimchi-premium', operation: 'kimchi-premium', stage: 'domestic_markets', exchange, err: error }, 'Kimchi premium domestic market universe fetch failed');
        return [];
      })),
  ]);
  const globalSupportedSymbols = new Set(binanceMarkets.map((market) => market.symbol));
  const domesticSupportedByVenue = new Map(
    domesticVenues.map((exchange, index) => [exchange, new Set(domesticMarkets[index].map((market) => market.symbol))]),
  );
  const domesticUniverseEmptyByVenue = new Map(
    domesticVenues.map((exchange, index) => [exchange, domesticMarkets[index].length === 0]),
  );
  const representativeSymbols = getRepresentativeSymbolsForExchange(symbols);

  const [referenceTickers, ...domesticTickerMaps] = await Promise.all([
    timedKimchiStage({
      stage: 'global_tickers',
      exchange: 'binance',
      timeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS + 250,
      run: () => getExchangeTickerLoads('binance', symbols, {
        freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.kimchiDefault,
        prioritySymbols: representativeSymbols,
        priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.kimchiTop,
        providerTimeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS,
      }),
    }).catch((error) => {
      logger.warn(
        { domain: 'kimchi-premium', operation: 'kimchi-premium', stage: 'global_tickers', exchange: 'binance', err: error },
        'Kimchi premium global ticker load failed',
      );
      return buildFailedTickerLoadMap(symbols, serializeReason(error), error);
    }),
    ...domesticVenues.map((exchange) =>
      timedKimchiStage({
        stage: 'domestic_tickers',
        exchange,
        timeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS + 250,
        run: () => getExchangeTickerLoads(exchange, symbols, {
          freshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.kimchiDefault,
          prioritySymbols: representativeSymbols,
          priorityFreshnessTargetMs: PRIORITY_FRESHNESS_TARGET_MS.kimchiTop,
          providerTimeoutMs: KIMCHI_PROVIDER_TIMEOUT_MS,
        }),
      }).catch((error) => {
        logger.warn(
          { domain: 'kimchi-premium', operation: 'kimchi-premium', stage: 'domestic_tickers', exchange, err: error },
          'Kimchi premium domestic ticker load failed',
        );
        return buildFailedTickerLoadMap(symbols, serializeReason(error), error);
      })),
  ]);
  const domesticMapByExchange = new Map(
    domesticVenues.map((exchange, index) => [exchange, domesticTickerMaps[index]]),
  );

  const tickerSources: KimchiSnapshotLoad['tickerSources'] = [];
  const resolvedSymbols: string[] = [];
  const droppedSymbols: KimchiSnapshotLoad['droppedSymbols'] = [];
  const partialFailures: SnapshotPartialFailure[] = [];
  const supportedPairs: string[] = [];
  const primaryVenue = domesticVenues[0];
  const usesFallbackFx = fxRate?.provider === 'fallback';
  const usesLastGoodFx = isLastGoodFx(fxRate);
  const domesticFreshnessLogEntries: Array<{ symbol: string; venue: DomesticExchangeId; load: TickerSnapshotLoad }> = [];

  const entries = symbols.map((symbol) => {
    const canonicalSymbol = toCanonicalSymbol(symbol);
    const coin = COIN_MAP.get(canonicalSymbol);
    const referenceLoad = applyLastKnownGoodTicker({
      component: 'reference',
      exchange: 'binance',
      symbol: canonicalSymbol,
      load: referenceTickers.get(canonicalSymbol) ?? {
        ticker: null,
        source: 'provider_snapshot' as const,
        reason: 'missing_reference_snapshot',
      },
    });
    tickerSources.push({ exchange: 'binance', symbol: canonicalSymbol, source: referenceLoad.source });

    const convertedReferencePrice = referenceLoad.ticker && fxRate ? referenceLoad.ticker.price * fxRate.rate : null;
    const domesticLoads = domesticVenues.map((exchange) => ({
      exchange,
      load: applyLastKnownGoodTicker({
        component: 'domestic',
        exchange,
        symbol: canonicalSymbol,
        load: domesticMapByExchange.get(exchange)?.get(canonicalSymbol) ?? {
          ticker: null,
          source: 'provider_snapshot' as const,
          reason: 'missing_domestic_snapshot',
        },
      }),
    }));
    domesticLoads.forEach(({ exchange, load }) => {
      domesticFreshnessLogEntries.push({ symbol: canonicalSymbol, venue: exchange, load });
    });
    domesticLoads.forEach(({ exchange, load }) => {
      tickerSources.push({ exchange, symbol: canonicalSymbol, source: load.source });
    });

    const domesticQuotes = domesticLoads.flatMap(({ exchange, load }) =>
      load.ticker
        ? [buildQuote({ exchange, ticker: load.ticker, convertedReferencePrice, reason: load.reason ?? null })]
        : [],
    );
    const primaryDomesticLoad = domesticLoads.find(({ exchange }) => exchange === primaryVenue)?.load ?? null;
    const primaryDomestic = primaryDomesticLoad?.ticker
      ? buildQuote({
          exchange: primaryVenue,
          ticker: primaryDomesticLoad.ticker,
          convertedReferencePrice,
          reason: primaryDomesticLoad.reason ?? null,
        })
      : null;
    const globalSupported = globalSupportedSymbols.has(canonicalSymbol)
      || Boolean(referenceLoad.ticker)
      || (binanceMarkets.length === 0 && Boolean(coin));
    const domesticSupported = (domesticSupportedByVenue.get(primaryVenue)?.has(canonicalSymbol) ?? false)
      || Boolean(primaryDomesticLoad?.ticker)
      || (domesticUniverseEmptyByVenue.get(primaryVenue) === true && Boolean(coin));
    if (globalSupported && domesticSupported) {
      supportedPairs.push(canonicalSymbol);
    }

    const referenceTicker = referenceLoad.ticker;
    const retainedLastGood = isLastGoodTickerLoad(referenceLoad)
      || isLastGoodTickerLoad(primaryDomesticLoad)
      || usesLastGoodFx;
    const computedAt = Date.now();
    const referenceStaleAgeMs = calculateStaleAge(referenceTicker?.timestamp);
    const fxStaleAgeMs = calculateStaleAge(fxRate?.timestamp);
    const timestamps = [
      referenceTicker?.timestamp ?? null,
      primaryDomestic?.sourceTimestamp ?? null,
      fxRate?.timestamp ?? null,
    ].filter((timestamp): timestamp is number => timestamp !== null);
    const newestTimestamp = timestamps.length > 0 ? Math.max(...timestamps) : null;
    const oldestTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : null;
    const timestampSkewMs = newestTimestamp !== null && oldestTimestamp !== null ? newestTimestamp - oldestTimestamp : null;
    const baselineStale = timestamps.some((timestamp) => isMarketDataStale(timestamp))
      || (fxRate ? (calculateStaleAge(fxRate.timestamp) ?? 0) > env.FX_STALE_THRESHOLD_MS : false)
      || (timestampSkewMs !== null && timestampSkewMs > env.FX_TIMESTAMP_SKEW_THRESHOLD_MS)
      || retainedLastGood;
    const sourceStaleReasons = {
      global: determineSourceStaleReason({
        timestamp: referenceTicker?.timestamp ?? null,
        missing: !referenceTicker,
        staleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
        skewMs: timestampSkewMs,
      }),
      domestic: determineSourceStaleReason({
        timestamp: primaryDomestic?.sourceTimestamp ?? null,
        missing: !primaryDomestic,
        staleThresholdMs: env.MARKET_DATA_STALE_THRESHOLD_MS,
        skewMs: timestampSkewMs,
      }),
      fx: determineSourceStaleReason({
        timestamp: fxRate?.timestamp ?? null,
        missing: !fxRate,
        staleThresholdMs: env.FX_STALE_THRESHOLD_MS,
        skewMs: timestampSkewMs,
        usesFallback: usesFallbackFx,
      }),
    };

    const missingFields = collectMissingFields([
      referenceTicker ? null : 'referencePrice',
      convertedReferencePrice !== null ? null : 'convertedReferencePrice',
      fxRate ? null : 'usdKrwRate',
      primaryDomestic ? null : 'domesticPrice',
      primaryDomestic?.premiumPercent !== null && primaryDomestic?.premiumPercent !== undefined ? null : 'premiumPercent',
    ]);

    const hasReference = referenceTicker !== null;
    const hasFx = fxRate !== null;
    const hasDomestic = primaryDomestic !== null;
    const hasPremium = primaryDomestic?.premiumPercent !== null && primaryDomestic?.premiumPercent !== undefined;
    const hasAnyProviderError = Boolean(fxError || referenceLoad.error || primaryDomesticLoad?.error);
    let freshness = determineKimchiFreshness({
      hasReference,
      hasFx,
      hasDomestic,
      hasPremium,
      timestamps: {
        domestic: primaryDomestic?.sourceTimestamp ?? null,
        global: referenceTicker?.timestamp ?? null,
        fx: fxRate?.timestamp ?? null,
      },
      timestampSkewMs,
      usesFallbackFx,
      now: computedAt,
    });
    if (retainedLastGood && freshness.freshnessState === 'fresh') {
      freshness = {
        ...freshness,
        freshnessState: 'slightly_stale',
        freshnessReason: compactReason([freshness.freshnessReason, 'last_good_retained']),
      };
    }
    const stale = baselineStale || freshness.freshnessState === 'stale';
    const failureStage = determineFailureStage({
      missingFields,
      hasReference,
      hasFx,
      hasDomestic,
      hasPremium,
    });
    const status = determineRowStatus({
      missingFields,
      hasReference,
      hasFx,
      hasDomestic,
      hasPremium,
      hasAnyProviderError,
      isStale: stale,
    });
    let normalizedStatus = usesFallbackFx && status === 'loaded' ? 'partial' : status;
    if (normalizedStatus === 'loaded' && freshness.freshnessState === 'stale') {
      normalizedStatus = 'stale';
    }
    const dataMode = resolveKimchiDataMode({
      referenceLoad,
      primaryDomesticLoad,
    });
    const statusReason = determineStatusReason({
      hasReference,
      hasFx: hasFx && !usesFallbackFx,
      hasDomestic,
      hasPremium,
      isStale: stale,
      primaryDomesticLoad,
      referenceLoad,
    });
    const source = mapKimchiDataModeToSource(dataMode, fxRate);
    const freshnessMetadata = createFreshnessMetadata({
      dataMode,
      sourceTimestamp: newestTimestamp,
    });
    const premiumAmountKRW =
      primaryDomestic?.priceKrw !== null
      && primaryDomestic?.priceKrw !== undefined
      && convertedReferencePrice !== null
        ? primaryDomestic.priceKrw - convertedReferencePrice
        : null;
    const sparkline = buildKimchiSparkline({
      exchange: primaryVenue,
      symbol: canonicalSymbol,
      premiumPercent: primaryDomestic?.premiumPercent ?? null,
      computedAt,
    });
    if (primaryDomestic?.sourceTimestamp !== null && primaryDomestic?.sourceTimestamp !== undefined) {
      marketIngestHealth.noteDomesticKimchiPriceUsed(primaryVenue, {
        symbol: canonicalSymbol,
        asOf: primaryDomestic.sourceTimestamp,
      });
    }
    const terminalDropReason = determineDroppedReason({
      referenceLoad,
      primaryDomesticLoad,
      hasReference,
      hasFx,
      hasDomestic,
      hasPremium,
      isStale: stale,
      fxError,
    });
    const errorCode = determineKimchiSnapshotErrorCode({
      symbol: canonicalSymbol,
      globalSupported,
      domesticSupported,
      hasReference,
      hasDomestic,
      hasFx,
      usesFallbackFx,
      isStale: stale,
      hasAnyProviderError,
      registryMapped: Boolean(coin),
    });
    const errorMessage = determineKimchiSnapshotErrorMessage({
      symbol: canonicalSymbol,
      code: errorCode,
      primaryVenue,
      globalSupported,
      domesticSupported,
      fxReason: fxError,
    });
    if (errorCode === 'SYMBOL_MAPPING_NOT_FOUND' || errorCode === 'UNSUPPORTED_SYMBOL') {
      normalizedStatus = 'unavailable';
    }

    const displayMeta = buildKimchiDisplayMeta({
      hasDomestic,
      hasReference,
      hasFx,
      lastDomesticAt: primaryDomestic?.sourceTimestamp ?? null,
      lastReferenceAt: referenceTicker?.timestamp ?? null,
      lastFxAt: fxRate?.timestamp ?? null,
      retainedLastGood,
      rowStatus: normalizedStatus,
      freshnessState: freshness.freshnessState,
    });
    const logStateComputed = displayMeta.status === 'ready'
      ? logger.debug.bind(logger)
      : logger.info.bind(logger);
    logStateComputed(
      {
        domain: 'kimchi-premium',
        symbol: canonicalSymbol,
        status: displayMeta.status,
        delayBucket: displayMeta.delayBucket,
        displayHint: displayMeta.displayHint,
        hasUsableDomesticPrice: displayMeta.hasUsableDomesticPrice,
        hasUsableReferencePrice: displayMeta.hasUsableReferencePrice,
        hasUsableFxRate: displayMeta.hasUsableFxRate,
      },
      `[KimchiSnapshotDebug] action=state_computed symbol=${canonicalSymbol} status=${displayMeta.status} delayBucket=${displayMeta.delayBucket}`,
    );

    if (errorCode) {
      partialFailures.push(toKimchiPartialFailure({
        symbol: canonicalSymbol,
        exchange:
          errorCode === 'FX_RATE_UNAVAILABLE'
            ? 'fx'
            : !globalSupported
              ? 'binance'
              : primaryVenue,
        code: errorCode,
        message: errorMessage ?? terminalDropReason,
        source,
        stage:
          errorCode === 'FX_RATE_UNAVAILABLE'
            ? 'fx_rate'
            : !globalSupported
              ? 'global_support'
              : !domesticSupported
                ? 'domestic_support'
                : failureStage ?? 'premium_compute',
        retryable: errorCode !== 'UNSUPPORTED_SYMBOL' && errorCode !== 'SYMBOL_MAPPING_NOT_FOUND',
      }));
    }

    if (normalizedStatus === 'loaded' || normalizedStatus === 'stale') {
      resolvedSymbols.push(canonicalSymbol);
    } else {
      droppedSymbols.push({
        symbol: canonicalSymbol,
        venue: primaryVenue,
        reason: terminalDropReason,
      });
      logger.warn(
        {
          domain: 'kimchi-premium',
          event: 'symbol_skipped',
          venue: primaryVenue,
          symbol: canonicalSymbol,
          reason: terminalDropReason,
        },
        '[KimchiPremium] symbol_skipped',
      );
    }

    if (normalizedStatus !== 'loaded') {
      logger.warn(
        {
          domain: 'kimchi-premium',
          operation: 'kimchi-premium',
          venue: primaryVenue,
          symbol: canonicalSymbol,
          status: normalizedStatus,
          missingFields,
          failureStage,
          fxAvailable: hasFx,
          referenceAvailable: hasReference,
          domesticAvailableExchanges: domesticQuotes.map((quote) => quote.exchange),
          missingDomesticExchanges: domesticLoads
            .filter(({ load }) => !load.ticker)
            .map(({ exchange, load }) => ({ exchange, reason: load.reason ?? 'missing_domestic_snapshot' })),
          referenceReason: referenceLoad.reason ?? null,
          fxReason: fxError ? serializeReason(fxError) : null,
          sourceTimestamps: {
            reference: referenceTicker?.timestamp ?? null,
            domestic: primaryDomestic?.sourceTimestamp ?? null,
            fx: fxRate?.timestamp ?? null,
          },
          sourceStaleReasons,
          freshnessState: freshness.freshnessState,
          freshnessReason: freshness.freshnessReason,
          freshnessMs: freshness.freshnessMs,
          sparklinePointCount: sparkline.pointCount,
          sparklineStatus: sparkline.status,
          dataMode,
          statusReason,
          errorCode,
        },
        '[KimchiPremium] symbol_settled',
      );
    } else {
      logger.debug(
        {
          domain: 'kimchi-premium',
          operation: 'kimchi-premium',
          venue: primaryVenue,
          exchange: primaryVenue,
          symbol: canonicalSymbol,
          computation: 'success',
          freshnessState: freshness.freshnessState,
          freshnessReason: freshness.freshnessReason,
          sourceTimestamps: {
            domestic: primaryDomestic?.sourceTimestamp ?? null,
            global: referenceTicker?.timestamp ?? null,
            fx: fxRate?.timestamp ?? null,
          },
          sparklinePointCount: sparkline.pointCount,
          sparklineStatus: sparkline.status,
        },
        '[KimchiPremium] computation_success',
      );
    }

    return {
      symbol: canonicalSymbol,
      nameKo: coin?.nameKo ?? canonicalSymbol,
      nameEn: coin?.nameEn ?? canonicalSymbol,
      quoteCurrency: 'KRW',
      status: normalizedStatus,
      statusReason,
      domesticVenue: primaryVenue,
      missingFields,
      failureStage,
      referenceExchange: referenceTicker?.exchange ?? null,
      referenceMarket: referenceTicker?.market ?? null,
      referenceTimestamp: referenceTicker?.timestamp ?? null,
      referenceStale: isMarketDataStale(referenceTicker?.timestamp),
      referenceStaleAgeMs,
      binancePrice: referenceTicker?.price ?? null,
      binanceUsdtPrice: referenceTicker?.price ?? null,
      usdKrwRate: fxRate?.rate ?? null,
      binanceKrwPrice: convertedReferencePrice,
      krwConvertedReference: convertedReferencePrice,
      domesticExchange: primaryVenue,
      domesticMarket: primaryDomestic?.market ?? null,
      domesticPrice: primaryDomestic?.priceKrw ?? null,
      domesticPriceKRW: primaryDomestic?.priceKrw ?? null,
      premiumPercent: primaryDomestic?.premiumPercent ?? null,
      premiumAmountKRW,
      selectedExchange: primaryVenue,
      sourceExchange: (primaryDomestic?.sourceExchange ?? null) as DomesticExchangeId | null,
      domesticPriceTimestamp: primaryDomestic?.sourceTimestamp ?? null,
      globalPriceTimestamp: referenceTicker?.timestamp ?? null,
      fxRateTimestamp: fxRate?.timestamp ?? null,
      computedAt,
      freshnessState: freshness.freshnessState,
      freshnessReason: freshness.freshnessReason,
      displayMeta,
      stableStatus: displayMeta.status,
      hasUsableDomesticPrice: displayMeta.hasUsableDomesticPrice,
      hasUsableReferencePrice: displayMeta.hasUsableReferencePrice,
      hasUsableFxRate: displayMeta.hasUsableFxRate,
      lastSuccessfulDomesticAt: displayMeta.lastSuccessfulDomesticAt,
      lastSuccessfulReferenceAt: displayMeta.lastSuccessfulReferenceAt,
      lastSuccessfulFxAt: displayMeta.lastSuccessfulFxAt,
      delayBucket: displayMeta.delayBucket,
      displayHint: displayMeta.displayHint,
      fxProvider: fxRate?.provider ?? null,
      fxTimestamp: fxRate?.timestamp ?? null,
      fxStale: fxRate ? (calculateStaleAge(fxRate.timestamp) ?? 0) > env.FX_STALE_THRESHOLD_MS : false,
      fxStaleAgeMs,
      globalPrice: referenceTicker?.price ?? null,
      fxRate: fxRate?.rate ?? null,
      convertedGlobalPriceKRW: convertedReferencePrice,
      domestic: domesticQuotes,
      sparkline: sparkline.points.map((point) => point.price),
      sparklinePoints: sparkline.points,
      sparklineSource: sparkline.source,
      sparklineValueType: 'premium_percent',
      sparklineStatus: sparkline.status,
      sparklinePointCount: sparkline.pointCount,
      pointCount: sparkline.pointCount,
      rangeMin: sparkline.rangeMin,
      rangeMax: sparkline.rangeMax,
      sparklineLastUpdatedAt: sparkline.lastUpdatedAt,
      sourceTimestamps: {
        reference: referenceTicker?.timestamp ?? null,
        domestic: primaryDomestic?.sourceTimestamp ?? null,
        fx: fxRate?.timestamp ?? null,
      },
      ...freshnessMetadata,
      asOf: freshnessMetadata.lastUpdatedAt,
      freshnessMs: freshness.freshnessMs,
      source,
      errorCode,
      errorMessage,
      isStale: stale,
      updatedAt: freshnessMetadata.lastUpdatedAt,
      stale,
      timestampSkewMs,
    } satisfies KimchiPremiumEntry;
  });

  const freshnessValues = entries
    .map((entry) => entry.freshnessMs)
    .filter((value): value is number => value !== null);
  const asOfValues = entries
    .map((entry) => entry.asOf)
    .filter((value): value is number => value !== null);
  const status = summarizeKimchiSnapshotStatus(entries);

  if (status === 'failure') {
    partialFailures.unshift({
      exchange: primaryVenue,
      code: 'ALL_PROVIDERS_FAILED',
      message: 'kimchi premium snapshot could not resolve any supported pair',
      source: 'derived',
      stage: 'snapshot',
      retryable: true,
    });
  }

  logger.info(
    {
      domain: 'kimchi-premium',
      operation: 'kimchi-premium',
      venue: primaryVenue,
      venues: domesticVenues,
      domesticVenueFreshness: summarizeDomesticVenueFreshness(domesticFreshnessLogEntries),
      representativeSymbols,
    },
    '[KimchiPremium] domestic_price_freshness',
  );

  return {
    entries,
    domesticVenues,
    tickerSources,
    fxProvider: fxRate?.provider ?? null,
    rowStatusSummary: summarizeRowStatuses(entries),
    resolvedSymbols: Array.from(new Set(resolvedSymbols)).sort((left, right) => left.localeCompare(right)),
    droppedSymbols,
    partialFailures,
    status,
    source: summarizeKimchiSnapshotSource(entries),
    asOf: asOfValues.length > 0 ? Math.max(...asOfValues) : null,
    freshnessMs: freshnessValues.length > 0 ? Math.max(...freshnessValues) : null,
    stale: entries.some((entry) => entry.stale),
    supportedPairs: Array.from(new Set(supportedPairs)).sort((left, right) => left.localeCompare(right)),
  };
}

async function loadKimchiPremiumSnapshotChunked(
  symbols: string[],
  domesticVenues: DomesticExchangeId[],
): Promise<KimchiSnapshotLoad> {
  const chunks = chunkKimchiSymbols(symbols, 40);
  if (chunks.length <= 1) {
    return loadKimchiPremiumSnapshot(symbols, domesticVenues);
  }

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: domesticVenues[0],
      phase: 'full_batch',
      requestedCount: symbols.length,
      internalChunks: chunks.length,
    },
    `[KimchiAPI] exchange=${domesticVenues[0]} phase=full_batch requestedCount=${symbols.length} internalChunks=${chunks.length}`,
  );

  const settled = await Promise.allSettled(chunks.map((chunk) => loadKimchiPremiumSnapshot(chunk, domesticVenues)));
  const mergedLoads = settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }

    const reason = serializeReason(result.reason);
    logger.warn(
      {
        domain: 'kimchi-premium',
        exchange: domesticVenues[0],
        phase: 'full_batch_chunk_failed',
        chunkIndex: index,
        chunkSize: chunks[index]?.length ?? 0,
        reason,
      },
      '[KimchiPremium] full_batch_chunk_failed',
    );
    return buildKimchiFailedChunkLoad(chunks[index] ?? [], domesticVenues, reason);
  });

  return mergeKimchiSnapshotLoads(symbols, mergedLoads, domesticVenues);
}

export async function getKimchiPremium(
  symbols: string[],
  options?: { venues?: DomesticExchangeId[]; quoteCurrency?: 'KRW'; requestKind?: KimchiSnapshotCacheKind },
): Promise<KimchiPremiumEntry[]> {
  const normalizedSymbols = Array.from(new Set(symbols.map((symbol) => toCanonicalSymbol(symbol)).filter(Boolean)));
  if (normalizedSymbols.length === 0) {
    throw new AppError(400, 'symbols query parameter is required', {
      code: 'INVALID_REQUEST',
      field: 'symbols',
      reason: 'REQUIRED',
      acceptedFormat: 'comma-separated canonical symbols',
      example: 'BTC,ETH,XRP',
    });
  }

  const domesticVenues = normalizeDomesticVenues(options?.venues);
  const requestKind = options?.requestKind ?? 'batch';
  const cacheBucket = getKimchiSnapshotCacheBucket(requestKind);
  const cachePolicy = getKimchiSnapshotCachePolicy(requestKind);
  const cacheKey = toCacheKey(normalizedSymbols, domesticVenues);
  const inFlightKey = kimchiInFlightKey(requestKind, cacheKey);
  const now = Date.now();
  const cached = cacheBucket.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    kimchiSnapshotLastOutcome.set(inFlightKey, 'cache_hit');
    logKimchiSnapshotOutcome('cache_hit', normalizedSymbols, cached.value);
    return cached.value.entries;
  }

  const inflight = kimchiSnapshotInFlight.get(inFlightKey);
  if (inflight) {
    const snapshot = await inflight;
    const latest = cacheBucket.get(cacheKey);
    if (latest) {
      kimchiSnapshotLastOutcome.set(inFlightKey, 'inflight_dedupe');
      logKimchiSnapshotOutcome('inflight_dedupe', normalizedSymbols, latest.value);
    }
    return snapshot.entries;
  }

  if (cached && cached.staleUntil > now) {
    const refreshPromise = loadKimchiPremiumSnapshotChunked(normalizedSymbols, domesticVenues)
      .then((value) => {
        const cachedAt = Date.now();
        cacheBucket.set(cacheKey, {
          value,
          expiresAt: cachedAt + cachePolicy.ttlMs,
          staleUntil: cachedAt + cachePolicy.staleTtlMs,
        });
        kimchiSnapshotLastOutcome.set(inFlightKey, 'external_fetch');
        logKimchiSnapshotOutcome('external_fetch', normalizedSymbols, value);
        return value;
      })
      .catch((error) => {
        logger.warn(
          {
            domain: 'kimchi-premium',
            exchange: domesticVenues[0],
            requestKind,
            err: error,
          },
          'Kimchi snapshot background refresh failed',
        );
        return cached.value;
      })
      .finally(() => {
        kimchiSnapshotInFlight.delete(inFlightKey);
      });
    kimchiSnapshotInFlight.set(inFlightKey, refreshPromise);
    kimchiSnapshotLastOutcome.set(inFlightKey, 'stale_cache');
    logKimchiSnapshotOutcome('stale_cache', normalizedSymbols, cached.value);
    return cached.value.entries;
  }

  const loadPromise = loadKimchiPremiumSnapshotChunked(normalizedSymbols, domesticVenues)
    .then((value) => {
      const cachedAt = Date.now();
      cacheBucket.set(cacheKey, {
        value,
        expiresAt: cachedAt + cachePolicy.ttlMs,
        staleUntil: cachedAt + cachePolicy.staleTtlMs,
      });
      kimchiSnapshotLastOutcome.set(inFlightKey, 'external_fetch');
      logKimchiSnapshotOutcome('external_fetch', normalizedSymbols, value);
      return value;
    })
    .catch((error) => {
      const staleCached = cacheBucket.get(cacheKey);
      if (staleCached && staleCached.staleUntil > Date.now()) {
        kimchiSnapshotLastOutcome.set(inFlightKey, 'stale_cache');
        logKimchiSnapshotOutcome('stale_cache', normalizedSymbols, staleCached.value);
        return staleCached.value;
      }
      throw error;
    })
    .finally(() => {
      kimchiSnapshotInFlight.delete(inFlightKey);
    });

  kimchiSnapshotInFlight.set(inFlightKey, loadPromise);
  return (await loadPromise).entries;
}

export async function getKimchiPremiumSnapshot(
  symbols: string[],
  options?: { venues?: DomesticExchangeId[]; quoteCurrency?: 'KRW'; requestKind?: KimchiSnapshotCacheKind },
): Promise<KimchiPremiumSnapshotResponse> {
  const entries = await getKimchiPremium(symbols, options);
  const normalizedSymbols = Array.from(new Set(symbols.map((symbol) => toCanonicalSymbol(symbol)).filter(Boolean)));
  const domesticVenues = normalizeDomesticVenues(options?.venues);
  const requestKind = options?.requestKind ?? 'batch';
  const cacheKey = toCacheKey(normalizedSymbols, domesticVenues);
  const cached = getKimchiSnapshotCacheBucket(requestKind).get(cacheKey);
  const snapshot = cached?.value;
  const cacheOutcome = kimchiSnapshotLastOutcome.get(kimchiInFlightKey(requestKind, cacheKey));

  return {
    domesticExchange: domesticVenues[0],
    globalExchange: 'binance',
    items: entries,
    partialFailures: snapshot?.partialFailures ?? [],
    supportedPairs: snapshot?.supportedPairs ?? [],
    status: snapshot?.status ?? summarizeKimchiSnapshotStatus(entries),
    source: snapshot?.source ?? summarizeKimchiSnapshotSource(entries),
    asOf: snapshot?.asOf ?? entries.map((entry) => entry.asOf).filter((value): value is number => value !== null && value !== undefined).sort((left, right) => right - left)[0] ?? null,
    freshnessMs: snapshot?.freshnessMs ?? entries.map((entry) => entry.freshnessMs).filter((value): value is number => value !== null && value !== undefined).sort((left, right) => right - left)[0] ?? null,
    stale: snapshot?.stale ?? entries.some((entry) => entry.stale),
    total: entries.length,
    cacheOutcome,
    requestKind,
  };
}

export function resetKimchiPremiumCachesForTest() {
  kimchiRepresentativeSnapshotCache.clear();
  kimchiVisibleSnapshotCache.clear();
  kimchiBatchSnapshotCache.clear();
  kimchiSnapshotInFlight.clear();
  kimchiSnapshotLastOutcome.clear();
  kimchiPremiumSparklineStore.clearForTest();
  kimchiLastKnownGoodStore.resetForTest();
}

function classifyKimchiBatchFailures(snapshot: KimchiPremiumSnapshotResponse) {
  const unsupportedSymbols: KimchiPremiumSymbolFailure[] = [];
  const unavailableSymbols: KimchiPremiumSymbolFailure[] = [];

  for (const failure of snapshot.partialFailures) {
    if (!failure.symbol) {
      unavailableSymbols.push({
        reason: failure.code,
        retryable: failure.retryable ?? true,
      });
      continue;
    }

    if (failure.code === 'UNSUPPORTED_SYMBOL' || failure.code === 'SYMBOL_MAPPING_NOT_FOUND') {
      unsupportedSymbols.push({
        symbol: failure.symbol,
        reason: failure.stage ?? failure.code,
        retryable: false,
      });
      continue;
    }

    unavailableSymbols.push({
      symbol: failure.symbol,
      reason: failure.stage ?? failure.code,
      retryable: failure.retryable ?? true,
    });
  }

  for (const item of snapshot.items) {
    if (!item.errorCode) {
      continue;
    }

    const target = item.errorCode === 'UNSUPPORTED_SYMBOL' || item.errorCode === 'SYMBOL_MAPPING_NOT_FOUND'
      ? unsupportedSymbols
      : unavailableSymbols;
    if (target.some((failure) => failure.symbol === item.symbol)) {
      continue;
    }

    target.push({
      symbol: item.symbol,
      reason: item.errorCode,
      retryable: item.errorCode !== 'UNSUPPORTED_SYMBOL' && item.errorCode !== 'SYMBOL_MAPPING_NOT_FOUND',
    });
  }

  return {
    unsupportedSymbols,
    unavailableSymbols,
  };
}

export async function getKimchiPremiumBatch(params: {
  symbols: string[];
  requestedSymbolCount?: number;
  rejectedSymbols?: KimchiPremiumSymbolFailure[];
  venues?: DomesticExchangeId[];
  quoteCurrency?: 'KRW';
}): Promise<KimchiPremiumBatchResponse> {
  const startedAt = Date.now();
  const primaryExchange = normalizeDomesticVenues(params.venues)[0];
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: primaryExchange,
      phase: params.symbols.length <= DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT ? 'visible_batch' : 'full_batch',
      requestedCount: params.requestedSymbolCount ?? params.symbols.length,
    },
    `[KimchiAPI] exchange=${primaryExchange} phase=${params.symbols.length <= DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT ? 'visible_batch' : 'full_batch'} requestedCount=${params.requestedSymbolCount ?? params.symbols.length}`,
  );
  const snapshot = await getKimchiPremiumSnapshot(params.symbols, {
    venues: params.venues,
    quoteCurrency: params.quoteCurrency,
    requestKind: params.symbols.length <= 20 ? 'visible' : 'batch',
  });
  const mergeElapsedMs = Date.now() - startedAt;
  logPipelineDebug('kimchi_merge', mergeElapsedMs, {
    exchange: snapshot.domesticExchange,
    requestedCount: params.requestedSymbolCount ?? params.symbols.length,
    normalizedCount: params.symbols.length,
  });

  const classified = classifyKimchiBatchFailures(snapshot);
  const rejectedSymbols = params.rejectedSymbols ?? [];
  const staleCount = snapshot.items.filter((item) => item.stale).length;
  const representativeSet = new Set(getRepresentativeSymbolsForExchange(params.symbols, snapshot.domesticExchange));
  const hydratedCount = snapshot.items.filter(isUsableRepresentativeEntry).length;
  const hydrationPhase = determineHydrationPhase({
    requestedCount: params.requestedSymbolCount ?? params.symbols.length,
    acceptedCount: snapshot.items.length,
    hydratedCount,
    unavailableCount: classified.unavailableSymbols.length,
  });
  const freshnessBucket = summarizeKimchiFreshnessBucket(snapshot.items);
  const representativeSource = mapKimchiSnapshotToRepresentativeSource({
    source: snapshot.source,
    stale: snapshot.stale,
    cacheOutcome: snapshot.cacheOutcome,
  });
  const effectiveRepresentativeSummary = preferRepresentativeSummary(
    summarizeRepresentativeStability({
      entries: snapshot.items,
      representativeSymbols: representativeSet,
      representativeSource,
    }),
    getRepresentativeCacheSummary(snapshot.domesticExchange),
  );
  const recommendedUiState = determineRecommendedUiState({
    representativeReady: effectiveRepresentativeSummary.representativeReady,
    freshness: effectiveRepresentativeSummary.representativeFreshness,
    hydrationPhase,
    unavailableCount: classified.unavailableSymbols.length,
  });
  const recommendedInitialBadge = determineRecommendedInitialBadge({
    hasUsableRepresentativeData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
    freshness: effectiveRepresentativeSummary.representativeFreshnessBucket,
  });
  const fullHydrationPending = hydratedCount < snapshot.items.length
    || classified.unavailableSymbols.length > 0
    || hydrationPhase === 'background_batch';
  const batchFreshnessBucket = freshnessBucket;
  const uiHint = determineFullHydrationUiHint({
    representativeReady: effectiveRepresentativeSummary.representativeReady,
    hydrationPhase,
    unavailableCount: classified.unavailableSymbols.length,
    fullHydrationPending,
  });
  const partial = rejectedSymbols.length > 0
    || classified.unsupportedSymbols.length > 0
    || classified.unavailableSymbols.length > 0
    || snapshot.status !== 'success'
    || snapshot.items.some((item) => item.status !== 'loaded');

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      requestedCount: params.requestedSymbolCount ?? params.symbols.length,
      normalizedCount: params.symbols.length,
      accepted: params.symbols.length,
      rejected: rejectedSymbols.length,
      unsupported: classified.unsupportedSymbols.length,
      unavailable: classified.unavailableSymbols.length,
      elapsedMs: mergeElapsedMs,
      partial,
      stale: staleCount,
      hydratedCount,
      hydrationPhase,
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      hasUsableRepresentativeData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
      recommendedUiState,
      recommendedInitialBadge,
    },
    `[KimchiAPI] exchange=${snapshot.domesticExchange} requestedCount=${params.requestedSymbolCount ?? params.symbols.length} normalizedCount=${params.symbols.length} accepted=${params.symbols.length} rejected=${rejectedSymbols.length} unsupported=${classified.unsupportedSymbols.length} elapsedMs=${mergeElapsedMs}`,
  );

  for (const failure of [...rejectedSymbols, ...classified.unsupportedSymbols, ...classified.unavailableSymbols]) {
    logger.warn(
      {
        domain: 'kimchi-premium',
        exchange: snapshot.domesticExchange,
        symbolFailure: failure.symbol ?? failure.input,
        reason: failure.reason,
        retryable: failure.retryable,
      },
      `[KimchiAPI] exchange=${snapshot.domesticExchange} symbolFailure=${failure.symbol ?? failure.input ?? 'unknown'} reason=${failure.reason}`,
    );
  }

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      partial,
      stale: staleCount,
      unavailable: classified.unavailableSymbols.length,
      hydratedCount,
      hydrationPhase,
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      recommendedUiState,
      recommendedInitialBadge,
      fullHydrationPending,
      uiHint,
    },
    `[KimchiAPI] exchange=${snapshot.domesticExchange} phase=response partial=${partial} stale=${staleCount} unavailable=${classified.unavailableSymbols.length}`,
  );

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      accepted: snapshot.items.length,
      hydrated: hydratedCount,
      stale: staleCount,
      unavailable: classified.unavailableSymbols.length,
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      uiState: recommendedUiState,
      recommendedInitialBadge,
      source: effectiveRepresentativeSummary.representativeSource,
      batchFreshness: batchFreshnessBucket,
      uiHint,
    },
    `[KimchiBatchAPI] exchange=${snapshot.domesticExchange} hydrated=${hydratedCount} unavailable=${classified.unavailableSymbols.length} representativeReady=${effectiveRepresentativeSummary.representativeReady} batchFreshness=${batchFreshnessBucket}`,
  );
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      hydrationPhase,
      batchFreshnessBucket,
      representativeFreshnessBucket: effectiveRepresentativeSummary.representativeFreshnessBucket,
      uiHint,
    },
    `[KimchiBatchAPI] exchange=${snapshot.domesticExchange} uiHint=${uiHint}`,
  );
  logger.info(
    {
      domain: 'response-meta',
      route: '/kimchi-premium/batch',
      exchange: snapshot.domesticExchange,
      staleCount,
      unavailableCount: classified.unavailableSymbols.length,
      partial,
      representativeReady: effectiveRepresentativeSummary.representativeReady,
    },
    `[ResponseMetaDebug] route=/kimchi-premium/batch staleCount=${staleCount} unavailableCount=${classified.unavailableSymbols.length}`,
  );

  const response: KimchiPremiumBatchResponse = {
    ...snapshot,
    requestedSymbols: params.symbols,
    acceptedSymbols: snapshot.items.map((item) => item.symbol),
    rejectedSymbols,
    unsupportedSymbols: classified.unsupportedSymbols,
    unavailableSymbols: classified.unavailableSymbols,
    partial,
    meta: {
      requestedCount: params.requestedSymbolCount ?? params.symbols.length,
      normalizedCount: params.symbols.length,
      acceptedCount: snapshot.items.length,
      hydratedCount,
      rejectedCount: rejectedSymbols.length,
      unsupportedCount: classified.unsupportedSymbols.length,
      unavailableCount: classified.unavailableSymbols.length,
      staleCount,
      pendingEstimate: Math.max(snapshot.items.length - hydratedCount, 0),
      hydrationPhase,
      representativeHint: params.symbols.length > 0 && params.symbols.every((symbol) => representativeSet.has(toCanonicalSymbol(symbol))),
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      hasUsableRepresentativeData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
      representativeCount: effectiveRepresentativeSummary.representativeCount,
      lastRepresentativeUpdateAt: effectiveRepresentativeSummary.lastRepresentativeUpdateAt,
      representativeFreshness: effectiveRepresentativeSummary.representativeFreshness,
      representativeFreshnessBucket: effectiveRepresentativeSummary.representativeFreshnessBucket,
      representativeSource: effectiveRepresentativeSummary.representativeSource,
      recommendedUiState,
      recommendedInitialBadge,
      fullHydrationPending,
      cacheSource: snapshot.source,
      freshness: snapshot.stale ? 'stale' : 'fresh',
      freshnessBucket,
      batchFreshnessBucket,
      uiHint,
      generatedAt: Date.now(),
      representative: {
        ready: effectiveRepresentativeSummary.representativeReady,
        hasUsableData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
        count: effectiveRepresentativeSummary.representativeCount,
        lastUpdateAt: effectiveRepresentativeSummary.lastRepresentativeUpdateAt,
        source: effectiveRepresentativeSummary.representativeSource,
        freshnessBucket: effectiveRepresentativeSummary.representativeFreshnessBucket,
        recommendedInitialBadge,
      },
      fullHydration: {
        pending: fullHydrationPending,
        phase: hydrationPhase,
        freshnessBucket: batchFreshnessBucket,
        hydratedCount,
        unavailableCount: classified.unavailableSymbols.length,
        uiHint,
      },
    },
  };

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      cacheHit: snapshot.cacheOutcome === 'cache_hit',
      cacheOutcome: snapshot.cacheOutcome,
      payloadMode: 'full',
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      fullHydrationDeferred: fullHydrationPending,
    },
    `[KimchiFastPath] exchange=${snapshot.domesticExchange} cacheHit=${snapshot.cacheOutcome === 'cache_hit'} payloadMode=full representativeReady=${effectiveRepresentativeSummary.representativeReady}`,
  );
  if (snapshot.cacheOutcome === 'inflight_dedupe') {
    logger.info(
      { domain: 'kimchi-premium', exchange: snapshot.domesticExchange, batchSkipped: true, reason: 'warm_inflight_request' },
      `[KimchiFastPath] exchange=${snapshot.domesticExchange} batchSkipped=true reason=warm_inflight_request`,
    );
  }
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: snapshot.domesticExchange,
      fullHydrationDeferred: fullHydrationPending,
    },
    `[KimchiFastPath] exchange=${snapshot.domesticExchange} fullHydrationDeferred=${fullHydrationPending}`,
  );
  logKimchiPayloadMetrics({
    exchange: snapshot.domesticExchange,
    computeMs: mergeElapsedMs,
    payloadMode: 'full',
    response,
  });

  return response;
}

export async function getKimchiPremiumRepresentatives(params: {
  exchange: DomesticExchangeId;
  limit?: number;
  debug?: boolean;
}): Promise<KimchiPremiumRepresentativesResponse> {
  const limit = params.limit ?? DEFAULT_KIMCHI_REPRESENTATIVE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const startedAt = Date.now();
  const comparablePage = await listComparableKimchiSymbols({
    exchange: params.exchange,
    limit,
  });
  const symbols = comparablePage.items.map((item) => item.symbol);
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      phase: 'representative_request',
      requestedCount: symbols.length,
    },
    `[KimchiAPI] exchange=${params.exchange} phase=representative_request requestedCount=${symbols.length}`,
  );
  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(symbols, params.exchange));
  const providerStartedAt = Date.now();
  const snapshot = symbols.length > 0
    ? await getKimchiPremiumSnapshot(symbols, { venues: [params.exchange], quoteCurrency: 'KRW', requestKind: 'representative' })
    : {
        domesticExchange: params.exchange,
        globalExchange: 'binance' as const,
        items: [],
        partialFailures: [],
        supportedPairs: [],
        status: 'failure' as const,
        source: 'derived' as const,
        asOf: null,
        freshnessMs: null,
        stale: false,
        total: 0,
      };
  const providerLatencyMs = symbols.length > 0 ? Date.now() - providerStartedAt : null;
  const representativeSource = mapKimchiSnapshotToRepresentativeSource({
    source: snapshot.source,
    stale: snapshot.stale,
    cacheOutcome: snapshot.cacheOutcome,
  });
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      phase: snapshot.cacheOutcome === 'cache_hit' || snapshot.cacheOutcome === 'stale_cache' ? 'representative_cache_hit' : 'representative_compute',
      count: snapshot.items.length,
    },
    `[KimchiAPI] exchange=${params.exchange} phase=${snapshot.cacheOutcome === 'cache_hit' || snapshot.cacheOutcome === 'stale_cache' ? 'representative_cache_hit' : 'representative_compute'} count=${snapshot.items.length}`,
  );
  const rows = snapshot.items.map((entry) => toKimchiViewportRow({
    exchange: params.exchange,
    entry,
    representativeSymbols,
    includeSparkline: false,
    debug: Boolean(params.debug),
  }));
  const decoratedRows = await decorateKimchiViewportRows(rows);
  logAssetImageProjectionBatch('/kimchi-premium/representatives', decoratedRows);
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'representatives',
    rows: decoratedRows,
    page: comparablePage.page ?? buildCursorPage(0, limit, comparablePage.total),
    requestedSymbolCount: symbols.length,
    mappedSymbolCount: symbols.length,
    skippedSymbols: [],
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused: snapshot.source === 'fallback',
  }) as KimchiPremiumRepresentativesResponse;
  const currentRepresentativeSummary = summarizeRepresentativeStability({
    entries: snapshot.items,
    representativeSymbols,
    representativeSource,
  });
  const effectiveRepresentativeSummary = preferRepresentativeSummary(
    currentRepresentativeSummary,
    getRepresentativeCacheSummary(params.exchange),
  );
  const representativeHydrationPhase: KimchiHydrationPhase = comparablePage.total > symbols.length ? 'background_batch' : 'hydrated';
  const recommendedInitialBadge = determineRecommendedInitialBadge({
    hasUsableRepresentativeData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
    freshness: effectiveRepresentativeSummary.representativeFreshnessBucket,
  });
  const fullHydrationPending = comparablePage.total > symbols.length;
  const uiHint = determineFullHydrationUiHint({
    representativeReady: effectiveRepresentativeSummary.representativeReady,
    hydrationPhase: representativeHydrationPhase,
    unavailableCount: snapshot.items.filter((item) => item.status === 'unavailable' || item.status === 'failed').length,
    fullHydrationPending,
  });
  const representativeMeta = {
    ...effectiveRepresentativeSummary,
    representativeFreshnessBucket: effectiveRepresentativeSummary.representativeFreshnessBucket,
    recommendedUiState: determineRecommendedUiState({
      representativeReady: effectiveRepresentativeSummary.representativeReady,
      freshness: effectiveRepresentativeSummary.representativeFreshness,
      hydrationPhase: representativeHydrationPhase,
      unavailableCount: snapshot.items.filter((item) => item.status === 'unavailable' || item.status === 'failed').length,
    }),
    recommendedInitialBadge,
    fullHydrationPending,
    generatedAt: Date.now(),
    representative: {
      ready: effectiveRepresentativeSummary.representativeReady,
      hasUsableData: effectiveRepresentativeSummary.hasUsableRepresentativeData,
      count: effectiveRepresentativeSummary.representativeCount,
      lastUpdateAt: effectiveRepresentativeSummary.lastRepresentativeUpdateAt,
      source: effectiveRepresentativeSummary.representativeSource,
      freshnessBucket: effectiveRepresentativeSummary.representativeFreshnessBucket,
      recommendedInitialBadge,
    },
    fullHydration: {
      pending: fullHydrationPending,
      phase: representativeHydrationPhase,
      freshnessBucket: summarizeKimchiFreshnessBucket(snapshot.items),
      uiHint,
    },
  } satisfies NonNullable<KimchiPremiumRepresentativesResponse['meta']>;
  response.meta = representativeMeta;

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      cacheHit: snapshot.cacheOutcome === 'cache_hit',
      representativeMs: providerLatencyMs,
      payloadMode: 'slim',
      representativeReady: representativeMeta.representativeReady,
      fullHydrationDeferred: fullHydrationPending,
    },
    `[KimchiFastPath] exchange=${params.exchange} cacheHit=${snapshot.cacheOutcome === 'cache_hit'} representativeMs=${providerLatencyMs ?? 0}`,
  );
  if (snapshot.cacheOutcome === 'inflight_dedupe') {
    logger.info(
      { domain: 'kimchi-premium', exchange: params.exchange, batchSkipped: true, reason: 'warm_inflight_request' },
      `[KimchiFastPath] exchange=${params.exchange} batchSkipped=true reason=warm_inflight_request`,
    );
  }
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      payloadMode: 'slim',
      representativeReady: representativeMeta.representativeReady,
    },
    `[KimchiFastPath] exchange=${params.exchange} payloadMode=slim representativeReady=${representativeMeta.representativeReady}`,
  );
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      fullHydrationDeferred: fullHydrationPending,
    },
    `[KimchiFastPath] exchange=${params.exchange} fullHydrationDeferred=${fullHydrationPending}`,
  );

  logKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'representatives',
    requestedSymbolCount: symbols.length,
    mappedSymbolCount: symbols.length,
    skippedSymbols: [],
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    staleReused: snapshot.source === 'fallback',
    response,
  });
  logKimchiPayloadMetrics({
    exchange: params.exchange,
    computeMs: firstPaintElapsedMs,
    payloadMode: 'slim',
    response,
  });

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      source: representativeMeta.representativeSource,
      representativeReady: representativeMeta.representativeReady,
      representativeCount: representativeMeta.representativeCount,
      freshness: representativeMeta.representativeFreshness,
      freshnessBucket: representativeMeta.representativeFreshnessBucket,
      recommendedUiState: representativeMeta.recommendedUiState,
      recommendedInitialBadge: representativeMeta.recommendedInitialBadge,
      fullHydrationPending: representativeMeta.fullHydrationPending,
      elapsedMs: firstPaintElapsedMs,
    },
    `[KimchiRepresentativeAPI] exchange=${params.exchange} representativeReady=${representativeMeta.representativeReady} source=${representativeMeta.representativeSource} recommendedInitialBadge=${representativeMeta.recommendedInitialBadge}`,
  );
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      source: representativeMeta.representativeSource,
      representativeCount: representativeMeta.representativeCount,
      representativeReady: representativeMeta.representativeReady,
      fullHydrationPending: representativeMeta.fullHydrationPending,
      uiHint,
      elapsedMs: firstPaintElapsedMs,
    },
    `[KimchiRepresentativeAPI] exchange=${params.exchange} representativeReady=${representativeMeta.representativeReady} fullHydrationPending=${representativeMeta.fullHydrationPending}`,
  );

  return response;
}

export async function getKimchiPremiumList(params: {
  exchange: DomesticExchangeId;
  cursor?: string;
  limit?: number;
  debug?: boolean;
}): Promise<KimchiPremiumListResponse> {
  const limit = params.limit ?? DEFAULT_KIMCHI_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const startedAt = Date.now();
  const comparablePage = await listComparableKimchiSymbols({
    exchange: params.exchange,
    cursor: params.cursor,
    limit,
  });
  const symbols = comparablePage.items.map((item) => item.symbol);
  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(symbols, params.exchange));
  const providerStartedAt = Date.now();
  const snapshot = symbols.length > 0
    ? await getKimchiPremiumSnapshot(symbols, { venues: [params.exchange], quoteCurrency: 'KRW', requestKind: 'visible' })
    : {
        domesticExchange: params.exchange,
        globalExchange: 'binance' as const,
        items: [],
        partialFailures: [],
        supportedPairs: [],
        status: 'failure' as const,
        source: 'derived' as const,
        asOf: null,
        freshnessMs: null,
        stale: false,
        total: 0,
      };
  const providerLatencyMs = symbols.length > 0 ? Date.now() - providerStartedAt : null;
  const rows = snapshot.items.map((entry) => toKimchiViewportRow({
    exchange: params.exchange,
    entry,
    representativeSymbols,
    includeSparkline: false,
    debug: Boolean(params.debug),
  }));
  const decoratedRows = await decorateKimchiViewportRows(rows);
  logAssetImageProjectionBatch('/kimchi-premium/list', decoratedRows);
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'list',
    rows: decoratedRows,
    page: comparablePage.page ?? buildCursorPage(parseCursorOffset(params.cursor), limit, comparablePage.total),
    requestedSymbolCount: symbols.length,
    mappedSymbolCount: symbols.length,
    skippedSymbols: [],
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused: snapshot.source === 'fallback',
  }) as KimchiPremiumListResponse;

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      cacheHit: snapshot.cacheOutcome === 'cache_hit',
      payloadMode: 'slim',
      representativeReady: decoratedRows.some((row) => row.displayStatus !== 'unavailable'),
    },
    `[KimchiFastPath] exchange=${params.exchange} cacheHit=${snapshot.cacheOutcome === 'cache_hit'} payloadMode=slim representativeReady=${decoratedRows.some((row) => row.displayStatus !== 'unavailable')}`,
  );
  if (snapshot.cacheOutcome === 'inflight_dedupe') {
    logger.info(
      { domain: 'kimchi-premium', exchange: params.exchange, batchSkipped: true, reason: 'warm_inflight_request' },
      `[KimchiFastPath] exchange=${params.exchange} batchSkipped=true reason=warm_inflight_request`,
    );
  }

  logKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'list',
    requestedSymbolCount: symbols.length,
    mappedSymbolCount: symbols.length,
    skippedSymbols: [],
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    staleReused: snapshot.source === 'fallback',
    response,
  });
  logKimchiPayloadMetrics({
    exchange: params.exchange,
    computeMs: firstPaintElapsedMs,
    payloadMode: 'slim',
    response,
  });

  return response;
}

export async function getKimchiPremiumSparkline(params: {
  exchange: DomesticExchangeId;
  symbols: string[];
  debug?: boolean;
}): Promise<KimchiPremiumSparklineResponse> {
  const normalizedSymbols = Array.from(new Set(params.symbols.map((symbol) => toCanonicalSymbol(symbol)).filter(Boolean)));
  const startedAt = Date.now();
  const comparableSet = await getComparableKimchiSymbolSet(params.exchange);
  const supportedSymbols: string[] = [];
  const skippedSymbols: KimchiViewportDebugSymbol[] = [];

  for (const symbol of normalizedSymbols) {
    if (!comparableSet.has(symbol)) {
      skippedSymbols.push({
        symbol,
        reason: COIN_MAP.has(symbol) ? 'not_comparable_on_selected_exchange' : 'symbol_mapping_not_found',
      });
      continue;
    }
    supportedSymbols.push(symbol);
  }

  const representativeSymbols = new Set(getRepresentativeSymbolsForExchange(supportedSymbols, params.exchange));
  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      phase: 'visible_batch',
      requestedCount: normalizedSymbols.length,
      accepted: supportedSymbols.length,
      unavailable: skippedSymbols.length,
    },
    `[KimchiAPI] exchange=${params.exchange} phase=visible_batch requestedCount=${normalizedSymbols.length} accepted=${supportedSymbols.length} unavailable=${skippedSymbols.length}`,
  );
  const providerStartedAt = Date.now();
  const snapshot = supportedSymbols.length > 0
    ? await getKimchiPremiumSnapshot(supportedSymbols, { venues: [params.exchange], quoteCurrency: 'KRW', requestKind: 'visible' })
    : {
        domesticExchange: params.exchange,
        globalExchange: 'binance' as const,
        items: [],
        partialFailures: [],
        supportedPairs: [],
        status: 'failure' as const,
        source: 'derived' as const,
        asOf: null,
        freshnessMs: null,
        stale: false,
        total: 0,
      };
  const providerLatencyMs = supportedSymbols.length > 0 ? Date.now() - providerStartedAt : null;
  const rows = snapshot.items.map((entry) => toKimchiViewportRow({
    exchange: params.exchange,
    entry,
    representativeSymbols,
    includeSparkline: true,
    debug: Boolean(params.debug),
  }));
  const decoratedRows = await decorateKimchiViewportRows(rows);
  logAssetImageProjectionBatch('/kimchi-premium/sparkline', decoratedRows);
  const firstPaintElapsedMs = Date.now() - startedAt;
  const response = buildKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'sparkline',
    rows: decoratedRows,
    requestedSymbolCount: normalizedSymbols.length,
    mappedSymbolCount: supportedSymbols.length,
    skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    debug: Boolean(params.debug),
    staleReused: snapshot.source === 'fallback',
  }) as KimchiPremiumSparklineResponse;

  logger.info(
    {
      domain: 'kimchi-premium',
      exchange: params.exchange,
      cacheHit: snapshot.cacheOutcome === 'cache_hit',
      payloadMode: 'slim',
      representativeReady: decoratedRows.some((row) => row.displayStatus !== 'unavailable'),
    },
    `[KimchiFastPath] exchange=${params.exchange} cacheHit=${snapshot.cacheOutcome === 'cache_hit'} payloadMode=slim representativeReady=${decoratedRows.some((row) => row.displayStatus !== 'unavailable')}`,
  );
  if (snapshot.cacheOutcome === 'inflight_dedupe') {
    logger.info(
      { domain: 'kimchi-premium', exchange: params.exchange, batchSkipped: true, reason: 'warm_inflight_request' },
      `[KimchiFastPath] exchange=${params.exchange} batchSkipped=true reason=warm_inflight_request`,
    );
  }

  logKimchiViewportResponse({
    exchange: params.exchange,
    requestKind: 'sparkline',
    requestedSymbolCount: normalizedSymbols.length,
    mappedSymbolCount: supportedSymbols.length,
    skippedSymbols,
    firstPaintElapsedMs,
    hydrationElapsedMs: providerLatencyMs ?? 0,
    providerLatencyMs,
    staleReused: snapshot.source === 'fallback',
    response,
  });
  logKimchiPayloadMetrics({
    exchange: params.exchange,
    computeMs: firstPaintElapsedMs,
    payloadMode: 'slim',
    response,
  });

  return response;
}

export function isSupportedKimchiVenue(venue: string): venue is DomesticExchangeId {
  return (SUPPORTED_DOMESTIC_VENUES as readonly string[]).includes(venue);
}
