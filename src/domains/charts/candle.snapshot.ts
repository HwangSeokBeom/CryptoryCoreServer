import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import {
  ExchangeMalformedPayloadError,
  ExchangeRateLimitError,
  ExchangeRequestError,
  ExchangeTemporaryUnavailableError,
  ExchangeUnsupportedSymbolError,
} from '../../core/exchange/errors';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
import { toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import type { CanonicalCandle, ExchangeId } from '../../core/exchange/exchange.types';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { isRepresentativeMarketSymbol } from '../market-data/market-priority';

const MAX_CANDLE_LIMIT = 500;
const CANDLE_CACHE_TTL_MS = 5_000;
const CANDLE_STALE_TTL_MS = 15 * 60_000;
const CANDLE_PERSISTENT_CACHE_TTL_MS = 30 * 60_000;
const CANDLE_USABLE_STALE_TTL_MS = CANDLE_PERSISTENT_CACHE_TTL_MS;
const CANDLE_NEGATIVE_COOLDOWN_BASE_MS = 3_000;
const CANDLE_NEGATIVE_COOLDOWN_MAX_MS = 30_000;
const CANDLE_REFRESH_CONCURRENCY = 4;
const CANDLE_REDIS_KEY_PREFIX = 'cryptory:candles:v2';

export type CandleRequestSupport = 'supported' | 'fallback' | 'unsupported';
export type CandleSnapshotStatus = 'loaded' | 'stale' | 'empty' | 'unavailable' | 'failed';
export type CandleSnapshotSource = 'provider' | 'fresh_cache' | 'stale_cache';
export type CandleFreshnessState = 'live' | 'stale' | 'unavailable';
export type CandleMetaSource = 'memory' | 'redis' | 'refreshed' | 'fallback';
export type CandleRefreshPriority = 'visible' | 'normal' | 'background';
export type CandleRecommendedClientBehavior = 'keep_existing' | 'first_paint_ok' | 'cold_placeholder_only';
export type CandleErrorType =
  | 'unsupported'
  | 'timeout'
  | 'rate_limit'
  | 'upstream_503'
  | 'transient'
  | 'malformed'
  | 'empty_response'
  | 'unknown';

export type CandleResponseMeta = {
  isRenderable: boolean;
  freshnessState: CandleFreshnessState;
  lastSuccessfulAt: number | null;
  source: CandleMetaSource;
  fallbackReason: string | null;
  pointCount: number;
  retryAfterMs?: number;
  renderPriority: 'live' | 'cached' | 'stale' | 'unavailable';
  refreshPriority: CandleRefreshPriority;
  recommendedClientBehavior: CandleRecommendedClientBehavior;
};

export type CandleSnapshotResult = {
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  interval: string | null;
  requestedLimit: number;
  limit: number;
  support: CandleRequestSupport;
  status: CandleSnapshotStatus;
  source: CandleSnapshotSource;
  fallbackApplied: boolean;
  staleCacheUsed: boolean;
  items: CanonicalCandle[];
  empty: boolean;
  asOf: number | null;
  freshnessMs: number | null;
  reason: string | null;
  meta: CandleResponseMeta;
};

type CachedCandleSnapshot = {
  items: CanonicalCandle[];
  capturedAt: number;
  expiresAt: number;
  staleUntil: number;
  usableUntil?: number;
};

type CandleFailureState = {
  failedAt: number;
  cooldownUntil: number;
  retryAfterMs: number;
  failureCount: number;
  errorType: CandleErrorType;
  reason: string;
};

type CandleRefreshOutcome = {
  status: Extract<CandleSnapshotStatus, 'loaded' | 'empty' | 'unavailable' | 'failed'>;
  entry: CachedCandleSnapshot | null;
  reason: string | null;
  errorType?: CandleErrorType;
  retryAfterMs?: number;
};

type CandleRefreshJob = {
  key: string;
  priority: CandleRefreshPriority;
  createdAt: number;
  task: () => Promise<CandleRefreshOutcome>;
  resolve: (value: CandleRefreshOutcome) => void;
  reject: (error: unknown) => void;
};

const candleSnapshotCache = new Map<string, CachedCandleSnapshot>();
const candleSnapshotInFlight = new Map<string, Promise<CandleRefreshOutcome>>();
const candleFailureCooldown = new Map<string, CandleFailureState>();

class CandleRefreshCoordinator {
  private activeCount = 0;
  private readonly queue: CandleRefreshJob[] = [];

  enqueue(
    key: string,
    priority: CandleRefreshPriority,
    task: () => Promise<CandleRefreshOutcome>,
  ): Promise<CandleRefreshOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        key,
        priority,
        createdAt: Date.now(),
        task,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  resetForTest() {
    this.queue.splice(0, this.queue.length);
    this.activeCount = 0;
  }

  private pump() {
    while (this.activeCount < CANDLE_REFRESH_CONCURRENCY && this.queue.length > 0) {
      this.queue.sort((left, right) => {
        const priorityDiff = candlePriorityRank(left.priority) - candlePriorityRank(right.priority);
        return priorityDiff === 0 ? left.createdAt - right.createdAt : priorityDiff;
      });
      const job = this.queue.shift();
      if (!job) {
        return;
      }

      this.activeCount += 1;
      job.task()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.activeCount = Math.max(this.activeCount - 1, 0);
          this.pump();
        });
    }
  }
}

const candleRefreshCoordinator = new CandleRefreshCoordinator();

function candlePriorityRank(priority: CandleRefreshPriority) {
  switch (priority) {
    case 'visible':
      return 0;
    case 'normal':
      return 1;
    case 'background':
    default:
      return 2;
  }
}

function clampCandleLimit(limit?: number) {
  if (limit === undefined) {
    return 200;
  }

  return Math.max(1, Math.min(Math.trunc(limit), MAX_CANDLE_LIMIT));
}

function candleCacheKey(exchange: ExchangeId, symbol: string, interval: string) {
  return `${exchange}:${symbol}:${interval}`;
}

function candleRedisKey(cacheKey: string) {
  return `${CANDLE_REDIS_KEY_PREFIX}:${cacheKey}`;
}

function summarizeCandleReason(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function classifyCandleErrorType(error: unknown): CandleErrorType {
  const reason = summarizeCandleReason(error);
  if (error instanceof ExchangeUnsupportedSymbolError) {
    return 'unsupported';
  }
  if (error instanceof ExchangeRateLimitError) {
    return 'rate_limit';
  }
  if (error instanceof ExchangeMalformedPayloadError) {
    return 'malformed';
  }
  if (error instanceof ExchangeRequestError) {
    if (error.statusCode === 429) {
      return 'rate_limit';
    }
    if ([408, 425, 500, 502, 503, 504].includes(error.statusCode)) {
      return error.statusCode === 503 ? 'upstream_503' : 'transient';
    }
  }
  if (error instanceof ExchangeTemporaryUnavailableError) {
    return 'transient';
  }
  if (/timed out|timeout/i.test(reason)) {
    return 'timeout';
  }
  if (/rate limit|429/i.test(reason)) {
    return 'rate_limit';
  }
  if (/503|service unavailable/i.test(reason)) {
    return 'upstream_503';
  }
  if (/temporarily unavailable|50[0-9]|network|econnreset|socket/i.test(reason)) {
    return 'transient';
  }
  return 'unknown';
}

function classifyCandleFailure(error: unknown): {
  status: Extract<CandleSnapshotStatus, 'unavailable' | 'failed'>;
  reason: string;
  errorType: CandleErrorType;
} {
  const reason = summarizeCandleReason(error);
  const errorType = classifyCandleErrorType(error);
  if (error instanceof ExchangeMalformedPayloadError || errorType === 'malformed') {
    return {
      status: 'failed',
      reason,
      errorType,
    };
  }

  if (
    error instanceof ExchangeUnsupportedSymbolError
    || error instanceof ExchangeTemporaryUnavailableError
    || error instanceof ExchangeRateLimitError
    || error instanceof ExchangeRequestError
    || ['timeout', 'rate_limit', 'upstream_503', 'transient', 'unsupported'].includes(errorType)
  ) {
    return {
      status: 'unavailable',
      reason,
      errorType,
    };
  }

  return {
    status: 'failed',
    reason,
    errorType,
  };
}

function logCandlePhase(params: {
  exchange: ExchangeId;
  symbol: string;
  interval: string;
  phase: string;
  elapsedMs?: number;
  limit?: number;
  mappedInterval?: string | null;
  mappedSymbol?: string | null;
  candles?: number;
  reason?: string | null;
}) {
  logger.info(
    {
      domain: 'chart-candles',
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.interval,
      phase: params.phase,
      elapsedMs: params.elapsedMs,
      limit: params.limit,
      mappedInterval: params.mappedInterval,
      mappedSymbol: params.mappedSymbol,
      candles: params.candles,
      reason: params.reason,
    },
    `[CandleAPI] exchange=${params.exchange} symbol=${params.symbol} interval=${params.interval} phase=${params.phase}`,
  );
}

function logCandleCacheDebug(params: {
  action:
    | 'memory_hit'
    | 'redis_hit'
    | 'singleflight_join'
    | 'stale_fallback'
    | 'unavailable';
  exchange: ExchangeId;
  symbol: string;
  interval: string;
  freshness?: CandleFreshnessState;
  reason?: string | null;
  retryAfterMs?: number;
}) {
  logger.info(
    {
      domain: 'candle-cache',
      ...params,
    },
    `[CandleCacheDebug] action=${params.action} symbol=${params.symbol} freshness=${params.freshness ?? 'n/a'}`,
  );
}

function logCandleRefreshDebug(params: {
  action: 'refresh_start' | 'refresh_fail';
  exchange: ExchangeId;
  symbol: string;
  interval: string;
  priority?: CandleRefreshPriority;
  errorType?: CandleErrorType;
  reason?: string | null;
}) {
  logger.info(
    {
      domain: 'candle-refresh',
      ...params,
    },
    `[CandleRefreshDebug] action=${params.action} symbol=${params.symbol} priority=${params.priority ?? 'n/a'}`,
  );
}

function logCandleMetaDebug(params: {
  symbol: string;
  freshnessState: CandleFreshnessState;
  isRenderable: boolean;
  pointCount: number;
  recommendedClientBehavior: CandleRecommendedClientBehavior;
  fallbackReason?: string | null;
}) {
  logger.info(
    {
      domain: 'chart-candles',
      ...params,
    },
    `[CandleMetaDebug] symbol=${params.symbol} freshnessState=${params.freshnessState} isRenderable=${params.isRenderable} pointCount=${params.pointCount} recommendedClientBehavior=${params.recommendedClientBehavior}`,
  );

  if (params.freshnessState === 'stale') {
    logger.info(
      {
        domain: 'chart-candles',
        symbol: params.symbol,
        action: 'stale_200',
        reason: params.fallbackReason ?? 'stale_while_revalidate',
      },
      `[CandleMetaDebug] symbol=${params.symbol} action=stale_200 reason=${params.fallbackReason ?? 'stale_while_revalidate'}`,
    );
  }
}

function logCandleWarmupDebug(symbol: string, priority: CandleRefreshPriority) {
  logger.info(
    {
      domain: 'chart-candles',
      action: 'priority_refresh',
      symbol,
      priority,
    },
    `[WarmupDebug] action=priority_refresh symbol=${symbol} priority=${priority}`,
  );
}

function resolveCandleRefreshPriority(symbol: string, foreground: boolean): CandleRefreshPriority {
  if (isRepresentativeMarketSymbol(symbol)) {
    return 'visible';
  }
  return foreground ? 'normal' : 'background';
}

function registerCandleFailure(cacheKey: string, errorType: CandleErrorType, reason: string): CandleFailureState {
  const previous = candleFailureCooldown.get(cacheKey);
  const failureCount = (previous?.failureCount ?? 0) + 1;
  const retryAfterMs = Math.min(
    CANDLE_NEGATIVE_COOLDOWN_BASE_MS * 2 ** Math.max(failureCount - 1, 0),
    CANDLE_NEGATIVE_COOLDOWN_MAX_MS,
  );
  const failedAt = Date.now();
  const state = {
    failedAt,
    cooldownUntil: failedAt + retryAfterMs,
    retryAfterMs,
    failureCount,
    errorType,
    reason,
  };
  candleFailureCooldown.set(cacheKey, state);
  return state;
}

function clearCandleFailure(cacheKey: string) {
  candleFailureCooldown.delete(cacheKey);
}

function getActiveCandleFailure(cacheKey: string) {
  const state = candleFailureCooldown.get(cacheKey);
  if (!state) {
    return null;
  }
  const now = Date.now();
  if (state.cooldownUntil <= now) {
    candleFailureCooldown.delete(cacheKey);
    return null;
  }
  return {
    ...state,
    retryAfterMs: Math.max(state.cooldownUntil - now, 0),
  };
}

function mergeCandleItems(existing: CanonicalCandle[] | undefined, incoming: CanonicalCandle[]) {
  const merged = new Map<string, CanonicalCandle>();
  for (const item of [...(existing ?? []), ...incoming]) {
    merged.set(`${item.openTime}:${item.closeTime}`, item);
  }

  return Array.from(merged.values())
    .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime)
    .slice(-MAX_CANDLE_LIMIT);
}

function sliceCandleItems(items: CanonicalCandle[], limit: number) {
  return items.slice(-limit);
}

function resolveCandleUsableUntil(entry: CachedCandleSnapshot) {
  return entry.usableUntil ?? entry.staleUntil;
}

function resolveRecommendedClientBehavior(params: {
  freshnessState: CandleFreshnessState;
  isRenderable: boolean;
  lastSuccessfulAt: number | null;
}) {
  if (params.isRenderable && params.freshnessState !== 'unavailable') {
    return 'first_paint_ok' as const;
  }

  if (params.lastSuccessfulAt !== null) {
    return 'keep_existing' as const;
  }

  return 'cold_placeholder_only' as const;
}

function buildCandleSnapshotResult(params: {
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  interval: string | null;
  requestedLimit: number;
  limit: number;
  support: CandleRequestSupport;
  status: CandleSnapshotStatus;
  source: CandleSnapshotSource;
  metaSource: CandleMetaSource;
  fallbackApplied: boolean;
  staleCacheUsed: boolean;
  items: CanonicalCandle[];
  capturedAt: number | null;
  reason?: string | null;
  fallbackReason?: string | null;
  retryAfterMs?: number;
  refreshPriority: CandleRefreshPriority;
  lastSuccessfulAt?: number | null;
}): CandleSnapshotResult {
  const freshnessState: CandleFreshnessState = params.items.length === 0
    ? 'unavailable'
    : params.status === 'loaded' && !params.staleCacheUsed
      ? 'live'
      : params.status === 'stale'
        ? 'stale'
        : 'unavailable';
  const lastSuccessfulAt = params.lastSuccessfulAt ?? params.capturedAt ?? null;
  const renderPriority = freshnessState === 'live'
    ? params.source === 'provider'
      ? 'live' as const
      : 'cached' as const
    : freshnessState === 'stale'
      ? 'stale' as const
      : 'unavailable' as const;
  const isRenderable = params.items.length > 0 && freshnessState !== 'unavailable';
  const recommendedClientBehavior = resolveRecommendedClientBehavior({
    freshnessState,
    isRenderable,
    lastSuccessfulAt,
  });
  const freshnessMsBaseTimestamp = params.capturedAt ?? lastSuccessfulAt;

  logCandleMetaDebug({
    symbol: params.symbol,
    freshnessState,
    isRenderable,
    pointCount: params.items.length,
    recommendedClientBehavior,
    fallbackReason: params.fallbackReason ?? params.reason ?? null,
  });

  return {
    exchange: params.exchange,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol,
    requestedInterval: params.requestedInterval,
    normalizedInterval: params.normalizedInterval,
    interval: params.interval,
    requestedLimit: params.requestedLimit,
    limit: params.limit,
    support: params.support,
    status: params.status,
    source: params.source,
    fallbackApplied: params.fallbackApplied,
    staleCacheUsed: params.staleCacheUsed,
    items: params.items,
    empty: params.items.length === 0,
    asOf: params.items[params.items.length - 1]?.closeTime ?? null,
    freshnessMs: freshnessMsBaseTimestamp !== null ? Math.max(Date.now() - freshnessMsBaseTimestamp, 0) : null,
    reason: params.reason ?? null,
    meta: {
      isRenderable,
      freshnessState,
      lastSuccessfulAt,
      source: params.metaSource,
      fallbackReason: params.fallbackReason ?? null,
      pointCount: params.items.length,
      retryAfterMs: params.retryAfterMs,
      renderPriority,
      refreshPriority: params.refreshPriority,
      recommendedClientBehavior,
    },
  };
}

function buildResultFromCache(params: {
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  resolvedInterval: string;
  requestedLimit: number;
  fallbackApplied: boolean;
  entry: CachedCandleSnapshot;
  stale: boolean;
  metaSource: Extract<CandleMetaSource, 'memory' | 'redis' | 'fallback'>;
  fallbackReason?: string | null;
  retryAfterMs?: number;
  refreshPriority: CandleRefreshPriority;
}) {
  return buildCandleSnapshotResult({
    exchange: params.exchange,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol,
    requestedInterval: params.requestedInterval,
    normalizedInterval: params.normalizedInterval,
    interval: params.resolvedInterval,
    requestedLimit: params.requestedLimit,
    limit: params.requestedLimit,
    support: params.fallbackApplied ? 'fallback' : 'supported',
    status: params.stale ? 'stale' : 'loaded',
    source: params.stale ? 'stale_cache' : 'fresh_cache',
    metaSource: params.metaSource,
    fallbackApplied: params.fallbackApplied,
    staleCacheUsed: params.stale,
    items: sliceCandleItems(params.entry.items, params.requestedLimit),
    capturedAt: params.entry.capturedAt,
    fallbackReason: params.fallbackReason ?? (params.stale ? 'stale_while_revalidate' : null),
    retryAfterMs: params.retryAfterMs,
    refreshPriority: params.refreshPriority,
  });
}

function buildResultFromRefreshOutcome(params: {
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  resolvedInterval: string;
  requestedLimit: number;
  fallbackApplied: boolean;
  outcome: CandleRefreshOutcome;
  refreshPriority: CandleRefreshPriority;
  lastSuccessfulAt?: number | null;
}) {
  if (params.outcome.entry) {
    return buildCandleSnapshotResult({
      exchange: params.exchange,
      symbol: params.symbol,
      rawSymbol: params.rawSymbol,
      requestedInterval: params.requestedInterval,
      normalizedInterval: params.normalizedInterval,
      interval: params.resolvedInterval,
      requestedLimit: params.requestedLimit,
      limit: params.requestedLimit,
      support: params.fallbackApplied ? 'fallback' : 'supported',
      status: 'loaded',
      source: 'provider',
      metaSource: 'refreshed',
      fallbackApplied: params.fallbackApplied,
      staleCacheUsed: false,
      items: sliceCandleItems(params.outcome.entry.items, params.requestedLimit),
      capturedAt: params.outcome.entry.capturedAt,
      reason: params.outcome.reason,
      refreshPriority: params.refreshPriority,
    });
  }

  return buildCandleSnapshotResult({
    exchange: params.exchange,
    symbol: params.symbol,
    rawSymbol: params.rawSymbol,
    requestedInterval: params.requestedInterval,
    normalizedInterval: params.normalizedInterval,
    interval: params.resolvedInterval,
    requestedLimit: params.requestedLimit,
    limit: params.requestedLimit,
    support: params.fallbackApplied ? 'fallback' : 'supported',
    status: params.outcome.status,
    source: 'provider',
    metaSource: 'fallback',
    fallbackApplied: params.fallbackApplied,
    staleCacheUsed: false,
    items: [],
    capturedAt: null,
    reason: params.outcome.reason,
    fallbackReason: params.outcome.reason,
    retryAfterMs: params.outcome.retryAfterMs,
    refreshPriority: params.refreshPriority,
    lastSuccessfulAt: params.lastSuccessfulAt ?? null,
  });
}

function isCachedCandleSnapshot(value: unknown): value is CachedCandleSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<CachedCandleSnapshot>;
  return Array.isArray(candidate.items)
    && typeof candidate.capturedAt === 'number'
    && typeof candidate.expiresAt === 'number'
    && typeof candidate.staleUntil === 'number'
    && (candidate.usableUntil === undefined || typeof candidate.usableUntil === 'number');
}

async function readRedisCandleSnapshot(cacheKey: string) {
  if (process.env.VITEST === 'true') {
    return null;
  }

  try {
    const { redis } = await import('../../config/redis');
    const raw = await redis.get(candleRedisKey(cacheKey));
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCachedCandleSnapshot(parsed) || resolveCandleUsableUntil(parsed) <= Date.now()) {
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warn({ domain: 'candle-cache', cacheKey, err: error }, 'Failed to read candle Redis snapshot');
    return null;
  }
}

async function writeRedisCandleSnapshot(cacheKey: string, entry: CachedCandleSnapshot) {
  if (process.env.VITEST === 'true') {
    return;
  }

  try {
    const { redis } = await import('../../config/redis');
    await redis.set(
      candleRedisKey(cacheKey),
      JSON.stringify(entry),
      'PX',
      CANDLE_PERSISTENT_CACHE_TTL_MS,
    );
  } catch (error) {
    logger.warn({ domain: 'candle-cache', cacheKey, err: error }, 'Failed to write candle Redis snapshot');
  }
}

async function fetchAndStoreCandleSnapshot(params: {
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  resolvedInterval: string;
  limit: number;
  cacheKey: string;
  priority: CandleRefreshPriority;
}): Promise<CandleRefreshOutcome> {
  const startedAt = Date.now();
  logCandleRefreshDebug({
    action: 'refresh_start',
    exchange: params.exchange,
    symbol: params.symbol,
    interval: params.requestedInterval,
    priority: params.priority,
  });

  try {
    const provider = exchangeProviderRegistry.getMarketDataProvider(params.exchange);
    const candles = await provider.getCandles(params.symbol, params.resolvedInterval, params.limit);
    const capturedAt = Date.now();

    if (candles.length > 0) {
      const previous = candleSnapshotCache.get(params.cacheKey);
      const entry = {
        items: mergeCandleItems(previous?.items, candles),
        capturedAt,
        expiresAt: capturedAt + CANDLE_CACHE_TTL_MS,
        staleUntil: capturedAt + CANDLE_STALE_TTL_MS,
        usableUntil: capturedAt + CANDLE_USABLE_STALE_TTL_MS,
      };
      candleSnapshotCache.set(params.cacheKey, entry);
      clearCandleFailure(params.cacheKey);
      void writeRedisCandleSnapshot(params.cacheKey, entry);
      logCandlePhase({
        exchange: params.exchange,
        symbol: params.symbol,
        interval: params.requestedInterval,
        phase: 'response_success',
        mappedInterval: params.resolvedInterval,
        mappedSymbol: params.rawSymbol,
        candles: candles.length,
        elapsedMs: Date.now() - startedAt,
      });
      return {
        status: 'loaded',
        entry,
        reason: null,
      };
    }

    const failure = registerCandleFailure(params.cacheKey, 'empty_response', 'provider_empty_response');
    logCandlePhase({
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.requestedInterval,
      phase: 'response_empty',
      mappedInterval: params.resolvedInterval,
      mappedSymbol: params.rawSymbol,
      elapsedMs: Date.now() - startedAt,
    });
    logCandleRefreshDebug({
      action: 'refresh_fail',
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.requestedInterval,
      errorType: 'empty_response',
      reason: 'provider_empty_response',
    });
    return {
      status: 'empty',
      entry: null,
      reason: 'provider_empty_response',
      errorType: 'empty_response',
      retryAfterMs: failure.retryAfterMs,
    };
  } catch (error) {
    const classified = classifyCandleFailure(error);
    const failure = registerCandleFailure(params.cacheKey, classified.errorType, classified.reason);
    logCandlePhase({
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.requestedInterval,
      phase: 'response_failure',
      mappedInterval: params.resolvedInterval,
      mappedSymbol: params.rawSymbol,
      reason: classified.reason,
    });
    logCandleRefreshDebug({
      action: 'refresh_fail',
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.requestedInterval,
      errorType: classified.errorType,
      reason: classified.reason,
    });
    return {
      status: classified.status,
      entry: null,
      reason: classified.reason,
      errorType: classified.errorType,
      retryAfterMs: failure.retryAfterMs,
    };
  }
}

function startCandleRefresh(params: {
  cacheKey: string;
  exchange: ExchangeId;
  symbol: string;
  rawSymbol: string;
  requestedInterval: string;
  normalizedInterval: string;
  resolvedInterval: string;
  limit: number;
  priority: CandleRefreshPriority;
}) {
  const existing = candleSnapshotInFlight.get(params.cacheKey);
  if (existing) {
    logCandleCacheDebug({
      action: 'singleflight_join',
      exchange: params.exchange,
      symbol: params.symbol,
      interval: params.requestedInterval,
    });
    return existing;
  }

  if (params.priority === 'visible') {
    logCandleWarmupDebug(params.symbol, params.priority);
  }

  const queued = candleRefreshCoordinator.enqueue(params.cacheKey, params.priority, () =>
    fetchAndStoreCandleSnapshot(params));
  const tracked = queued.finally(() => {
    if (candleSnapshotInFlight.get(params.cacheKey) === tracked) {
      candleSnapshotInFlight.delete(params.cacheKey);
    }
  });
  candleSnapshotInFlight.set(params.cacheKey, tracked);
  return tracked;
}

export async function resolveCandleSnapshot(params: {
  exchange: ExchangeId;
  symbol: string;
  interval: string;
  limit?: number;
  allowStale?: boolean;
}): Promise<CandleSnapshotResult> {
  const canonicalSymbol = toCanonicalSymbol(params.symbol);
  if (!canonicalSymbol) {
    throw new AppError(400, 'symbol is required');
  }

  const resolved = resolveExchangeInterval(params.exchange, params.interval);
  const normalizedInterval = resolved?.normalizedInterval ?? params.interval.trim().toLowerCase();
  const rawSymbol = toExchangeSymbol(params.exchange, canonicalSymbol);
  const requestedLimit = clampCandleLimit(params.limit);
  const foregroundPriority = resolveCandleRefreshPriority(canonicalSymbol, true);

  logCandlePhase({
    exchange: params.exchange,
    symbol: canonicalSymbol,
    interval: params.interval,
    phase: 'request_start',
    limit: requestedLimit,
  });

  if (!resolved) {
    logCandlePhase({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      phase: 'response_unsupported',
      reason: 'interval_mapping_not_found',
    });
    return buildCandleSnapshotResult({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      rawSymbol,
      requestedInterval: params.interval,
      normalizedInterval,
      interval: null,
      requestedLimit,
      limit: requestedLimit,
      support: 'unsupported',
      status: 'unavailable',
      source: 'provider',
      metaSource: 'fallback',
      fallbackApplied: false,
      staleCacheUsed: false,
      items: [],
      capturedAt: null,
      reason: 'interval_mapping_not_found',
      fallbackReason: 'interval_mapping_not_found',
      refreshPriority: foregroundPriority,
    });
  }

  logCandlePhase({
    exchange: params.exchange,
    symbol: canonicalSymbol,
    interval: params.interval,
    phase: 'normalized',
    mappedInterval: resolved.resolvedInterval,
    mappedSymbol: rawSymbol,
  });

  const cacheKey = candleCacheKey(params.exchange, canonicalSymbol, resolved.resolvedInterval);
  const now = Date.now();
  let cached = candleSnapshotCache.get(cacheKey) ?? null;
  let cachedSource: Extract<CandleMetaSource, 'memory' | 'redis'> = 'memory';

  if (cached && cached.expiresAt > now) {
    logCandleCacheDebug({
      action: 'memory_hit',
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      freshness: 'live',
    });
    return buildResultFromCache({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      rawSymbol,
      requestedInterval: params.interval,
      normalizedInterval: resolved.normalizedInterval,
      resolvedInterval: resolved.resolvedInterval,
      requestedLimit,
      fallbackApplied: resolved.fallbackApplied,
      entry: cached,
      stale: false,
      metaSource: 'memory',
      refreshPriority: foregroundPriority,
    });
  }

  if (!cached) {
    const redisCached = await readRedisCandleSnapshot(cacheKey);
    if (redisCached) {
      cached = redisCached;
      cachedSource = 'redis';
      candleSnapshotCache.set(cacheKey, redisCached);
      logCandleCacheDebug({
        action: 'redis_hit',
        exchange: params.exchange,
        symbol: canonicalSymbol,
        interval: params.interval,
        freshness: redisCached.expiresAt > now ? 'live' : 'stale',
      });
      if (redisCached.expiresAt > now) {
        return buildResultFromCache({
          exchange: params.exchange,
          symbol: canonicalSymbol,
          rawSymbol,
          requestedInterval: params.interval,
          normalizedInterval: resolved.normalizedInterval,
          resolvedInterval: resolved.resolvedInterval,
          requestedLimit,
          fallbackApplied: resolved.fallbackApplied,
          entry: redisCached,
          stale: false,
          metaSource: 'redis',
          refreshPriority: foregroundPriority,
        });
      }
    }
  }

  if (cached && resolveCandleUsableUntil(cached) > now && params.allowStale !== false) {
    const activeFailure = getActiveCandleFailure(cacheKey);
    const withinPreferredStaleWindow = cached.staleUntil > now;
    const fallbackReason = activeFailure
      ? activeFailure.errorType
      : withinPreferredStaleWindow
        ? 'stale_while_revalidate'
        : 'last_known_good';
    if (activeFailure) {
      logCandleCacheDebug({
        action: 'stale_fallback',
        exchange: params.exchange,
        symbol: canonicalSymbol,
        interval: params.interval,
        freshness: 'stale',
        reason: activeFailure.errorType,
        retryAfterMs: activeFailure.retryAfterMs,
      });
      return buildResultFromCache({
        exchange: params.exchange,
        symbol: canonicalSymbol,
        rawSymbol,
        requestedInterval: params.interval,
        normalizedInterval: resolved.normalizedInterval,
        resolvedInterval: resolved.resolvedInterval,
        requestedLimit,
        fallbackApplied: resolved.fallbackApplied,
        entry: cached,
        stale: true,
        metaSource: 'fallback',
        fallbackReason,
        retryAfterMs: activeFailure.retryAfterMs,
        refreshPriority: resolveCandleRefreshPriority(canonicalSymbol, false),
      });
    }

    const existing = candleSnapshotInFlight.get(cacheKey);
    if (existing) {
      logCandleCacheDebug({
        action: 'singleflight_join',
        exchange: params.exchange,
        symbol: canonicalSymbol,
        interval: params.interval,
        freshness: 'stale',
      });
    } else {
      void startCandleRefresh({
        cacheKey,
        exchange: params.exchange,
        symbol: canonicalSymbol,
        rawSymbol,
        requestedInterval: params.interval,
        normalizedInterval: resolved.normalizedInterval,
        resolvedInterval: resolved.resolvedInterval,
        limit: requestedLimit,
        priority: resolveCandleRefreshPriority(canonicalSymbol, false),
      });
    }

    logCandleCacheDebug({
      action: 'stale_fallback',
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      freshness: 'stale',
      reason: fallbackReason,
    });
    logCandlePhase({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      phase: 'response_stale_cache',
      mappedInterval: resolved.resolvedInterval,
      mappedSymbol: rawSymbol,
      candles: cached.items.length,
      reason: fallbackReason,
    });
    return buildResultFromCache({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      rawSymbol,
      requestedInterval: params.interval,
      normalizedInterval: resolved.normalizedInterval,
      resolvedInterval: resolved.resolvedInterval,
      requestedLimit,
      fallbackApplied: resolved.fallbackApplied,
      entry: cached,
      stale: true,
      metaSource: withinPreferredStaleWindow ? cachedSource : 'fallback',
      fallbackReason,
      refreshPriority: resolveCandleRefreshPriority(canonicalSymbol, false),
    });
  }

  const activeFailure = getActiveCandleFailure(cacheKey);
  if (activeFailure) {
    logCandleCacheDebug({
      action: 'unavailable',
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      freshness: 'unavailable',
      reason: 'negative_cooldown',
      retryAfterMs: activeFailure.retryAfterMs,
    });
    return buildCandleSnapshotResult({
      exchange: params.exchange,
      symbol: canonicalSymbol,
      rawSymbol,
      requestedInterval: params.interval,
      normalizedInterval: resolved.normalizedInterval,
      interval: resolved.resolvedInterval,
      requestedLimit,
      limit: requestedLimit,
      support: resolved.fallbackApplied ? 'fallback' : 'supported',
      status: 'unavailable',
      source: 'provider',
      metaSource: 'fallback',
      fallbackApplied: resolved.fallbackApplied,
      staleCacheUsed: false,
      items: [],
      capturedAt: null,
      reason: activeFailure.reason,
      fallbackReason: 'negative_cooldown',
      retryAfterMs: activeFailure.retryAfterMs,
      refreshPriority: foregroundPriority,
      lastSuccessfulAt: cached?.capturedAt ?? null,
    });
  }

  const inFlight = candleSnapshotInFlight.get(cacheKey);
  const outcome = inFlight
    ? await (() => {
        logCandleCacheDebug({
          action: 'singleflight_join',
          exchange: params.exchange,
          symbol: canonicalSymbol,
          interval: params.interval,
        });
        return inFlight;
      })()
    : await startCandleRefresh({
        cacheKey,
        exchange: params.exchange,
        symbol: canonicalSymbol,
        rawSymbol,
        requestedInterval: params.interval,
        normalizedInterval: resolved.normalizedInterval,
        resolvedInterval: resolved.resolvedInterval,
        limit: requestedLimit,
        priority: foregroundPriority,
      });

  if (!outcome.entry) {
    logCandleCacheDebug({
      action: 'unavailable',
      exchange: params.exchange,
      symbol: canonicalSymbol,
      interval: params.interval,
      freshness: 'unavailable',
      reason: outcome.reason ?? 'no_last_good',
      retryAfterMs: outcome.retryAfterMs,
    });
  }

  return buildResultFromRefreshOutcome({
    exchange: params.exchange,
    symbol: canonicalSymbol,
    rawSymbol,
    requestedInterval: params.interval,
    normalizedInterval: resolved.normalizedInterval,
    resolvedInterval: resolved.resolvedInterval,
    requestedLimit,
    fallbackApplied: resolved.fallbackApplied,
    outcome,
    refreshPriority: foregroundPriority,
    lastSuccessfulAt: cached?.capturedAt ?? null,
  });
}

export function resetCandleSnapshotCachesForTest() {
  candleSnapshotCache.clear();
  candleSnapshotInFlight.clear();
  candleFailureCooldown.clear();
  candleRefreshCoordinator.resetForTest();
}

export function getCandleRefreshPriorityForTest(symbol: string, foreground: boolean) {
  return resolveCandleRefreshPriority(toCanonicalSymbol(symbol), foreground);
}
