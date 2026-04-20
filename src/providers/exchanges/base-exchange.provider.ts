import { getExchangeConfig } from '../../config/exchange.config';
import { ExchangeRequestError } from '../../core/exchange/errors';
import { ExchangeCapabilityError } from '../../core/exchange/errors';
import { EXCHANGE_METADATA } from '../../core/exchange/exchange.metadata';
import { RestClient } from '../../core/exchange/rest.client';
import type { ExchangeCapability, ExchangeId, ExchangeMetadata, MarketCapabilitySnapshot } from '../../core/exchange/exchange.types';
import { logger } from '../../utils/logger';

type CachedProviderResponse<T> = {
  value: T;
  cachedAt: number;
  expiresAt: number;
  staleUntil: number;
};

type RequestCacheOutcome =
  | 'cache_hit'
  | 'inflight_dedupe'
  | 'external_fetch'
  | 'stale_cache_fallback'
  | 'stale_cache_revalidate'
  | 'external_error';

type RequestSymbolDiff<T> = {
  requestedSymbols: string[];
  resolvedSymbols: (value: T) => string[];
  droppedReason?: (symbol: string, value?: T) => string;
};

type MarketUniverseSnapshot = {
  registrySymbols: string[];
  marketSymbols: string[];
} & Partial<MarketCapabilitySnapshot>;

function summarizeDroppedReasons(droppedSymbols: Array<{ symbol: string; reason: string }>) {
  return droppedSymbols.reduce<Record<string, number>>((summary, item) => {
    summary[item.reason] = (summary[item.reason] ?? 0) + 1;
    return summary;
  }, {});
}

function extractUpstreamStatus(error: unknown) {
  if (error instanceof ExchangeRequestError) {
    return error.statusCode;
  }

  if (error instanceof Error) {
    const match = error.message.match(/\bHTTP\s+(\d{3})\b/i);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }

  return undefined;
}

function isRateLimitError(error: unknown) {
  if (error instanceof ExchangeRequestError) {
    return error.statusCode === 429 || /too[_\s-]?many[_\s-]?requests|rate limit/i.test(error.responseBody ?? error.message);
  }

  if (error instanceof Error) {
    return /\b429\b|too[_\s-]?many[_\s-]?requests|rate limit/i.test(error.message);
  }

  return false;
}

export abstract class BaseExchangeProvider {
  readonly metadata: ExchangeMetadata;
  protected readonly restClient: RestClient;
  private readonly requestCache = new Map<string, CachedProviderResponse<unknown>>();
  private readonly inFlightRequests = new Map<string, Promise<unknown>>();

  constructor(readonly exchange: ExchangeId) {
    this.metadata = EXCHANGE_METADATA[exchange];
    this.restClient = new RestClient(exchange, getExchangeConfig(exchange).restBaseUrl);
  }

  supports(capability: ExchangeCapability) {
    return this.metadata.capabilities.includes(capability);
  }

  protected assertCapability(capability: ExchangeCapability) {
    if (!this.supports(capability)) {
      throw new ExchangeCapabilityError(this.exchange, capability);
    }
  }

  protected async withRequestCache<T>(params: {
    operation: string;
    key: string;
    ttlMs: number;
    staleTtlMs?: number;
    staleWhileRevalidate?: boolean;
    requestedMarketCount?: number;
    normalizedSymbolCount?: number;
    loader: () => Promise<T>;
    responseItemCount: (value: T) => number;
    symbolDiff?: RequestSymbolDiff<T>;
  }): Promise<T> {
    const cacheKey = `${params.operation}:${params.key}`;
    const now = Date.now();
    const cached = this.requestCache.get(cacheKey) as CachedProviderResponse<T> | undefined;

    if (cached && cached.expiresAt > now) {
      this.logRequestOutcome(params, 'cache_hit', cached.value);
      return cached.value;
    }

    const inFlight = this.inFlightRequests.get(cacheKey) as Promise<T> | undefined;
    const staleCached = cached && cached.staleUntil > now ? cached : null;
    if (staleCached && params.staleWhileRevalidate) {
      if (!inFlight) {
        const refreshPromise = params.loader()
          .then((value) => {
            const cachedAt = Date.now();
            this.requestCache.set(cacheKey, {
              value,
              cachedAt,
              expiresAt: cachedAt + params.ttlMs,
              staleUntil: cachedAt + Math.max(params.staleTtlMs ?? params.ttlMs, params.ttlMs),
            });
            this.logRequestOutcome(params, 'external_fetch', value);
            return value;
          })
          .catch((error) => {
            this.logRequestOutcome(params, 'stale_cache_fallback', staleCached.value, error);
            return staleCached.value;
          })
          .finally(() => {
            this.inFlightRequests.delete(cacheKey);
          });
        this.inFlightRequests.set(cacheKey, refreshPromise);
      }

      this.logRequestOutcome(params, 'stale_cache_revalidate', staleCached.value);
      return staleCached.value;
    }

    if (inFlight) {
      return inFlight.then((value) => {
        this.logRequestOutcome(params, 'inflight_dedupe', value);
        return value;
      });
    }

    const requestPromise = params.loader()
      .then((value) => {
        const cachedAt = Date.now();
        this.requestCache.set(cacheKey, {
          value,
          cachedAt,
          expiresAt: cachedAt + params.ttlMs,
          staleUntil: cachedAt + Math.max(params.staleTtlMs ?? params.ttlMs, params.ttlMs),
        });
        this.logRequestOutcome(params, 'external_fetch', value);
        return value;
      })
      .catch((error) => {
        const staleCached = cached && cached.staleUntil > Date.now() ? cached : null;
        if (staleCached) {
          this.logRequestOutcome(params, 'stale_cache_fallback', staleCached.value, error);
          return staleCached.value;
        }

        this.logRequestOutcome(params, 'external_error', undefined, error);
        throw error;
      })
      .finally(() => {
        this.inFlightRequests.delete(cacheKey);
      });

    this.inFlightRequests.set(cacheKey, requestPromise);
    return requestPromise;
  }

  private logRequestOutcome<T>(
    params: {
      operation: string;
      requestedMarketCount?: number;
      normalizedSymbolCount?: number;
      responseItemCount: (value: T) => number;
      symbolDiff?: RequestSymbolDiff<T>;
    },
    outcome: RequestCacheOutcome,
    value?: T,
    error?: unknown,
  ) {
    const resolvedSymbols = value === undefined ? [] : params.symbolDiff?.resolvedSymbols(value) ?? [];
    const resolvedSymbolSet = new Set(resolvedSymbols);
    const droppedSymbols = (params.symbolDiff?.requestedSymbols ?? [])
      .filter((symbol) => !resolvedSymbolSet.has(symbol))
      .map((symbol) => ({
        symbol,
        reason: params.symbolDiff?.droppedReason?.(symbol, value) ?? 'missing_from_response',
      }));

    logger.info(
      {
        domain: 'market-provider',
        exchange: this.exchange,
        operation: params.operation,
        requestedMarketCount: params.requestedMarketCount ?? params.symbolDiff?.requestedSymbols.length ?? 0,
        providerMarketCount: value === undefined ? 0 : params.responseItemCount(value),
        normalizedSymbolCount: params.normalizedSymbolCount ?? resolvedSymbols.length,
        returnedCount: value === undefined ? 0 : params.responseItemCount(value),
        cacheOutcome: outcome,
        externalProviderCalled: outcome === 'external_fetch' || outcome === 'external_error' || outcome === 'stale_cache_revalidate',
        cacheHit: outcome === 'cache_hit' || outcome === 'stale_cache_fallback' || outcome === 'stale_cache_revalidate',
        inFlightDeduped: outcome === 'inflight_dedupe',
        upstreamStatus: extractUpstreamStatus(error),
        rateLimited: isRateLimitError(error),
        requestedSymbols: params.symbolDiff?.requestedSymbols,
        resolvedSymbols,
        droppedSymbols,
        droppedReasonsSummary: summarizeDroppedReasons(droppedSymbols),
        sourceOfTruth: 'provider_market_universe',
        totalAvailableCount: value === undefined ? 0 : params.responseItemCount(value),
      },
      'Resolved exchange market request',
    );
  }

  protected logResolvedMarketUniverse(params: {
    operation: string;
    requestedSymbols: string[];
    returnedSymbols: string[];
    universe: MarketUniverseSnapshot;
    droppedReason: (symbol: string) => string;
    source?: string;
    appliedLimit?: number | null;
    totalAvailableCount?: number;
  }) {
    const requestedSymbols = Array.from(new Set(params.requestedSymbols));
    const marketSymbolSet = new Set(params.universe.marketSymbols);
    const returnedSymbolSet = new Set(params.returnedSymbols);
    const resolvedSymbols = requestedSymbols.filter((symbol) => marketSymbolSet.has(symbol));
    const droppedSymbols = requestedSymbols
      .filter((symbol) => !returnedSymbolSet.has(symbol))
      .map((symbol) => ({
        symbol,
        reason: params.droppedReason(symbol),
      }));
    const registrySymbolSet = new Set(params.universe.registrySymbols);
    const providerMarketCount = params.universe.marketSymbols.length;
    const registryMappedCount = params.universe.marketSymbols.filter((symbol) => registrySymbolSet.has(symbol)).length;

    logger.info(
      {
        domain: 'market-provider',
        exchange: this.exchange,
        operation: params.operation,
        source: params.source ?? 'provider_or_cache',
        requestedMarketCount: requestedSymbols.length,
        providerMarketCount,
        normalizedSymbolCount: resolvedSymbols.length,
        requestedCount: requestedSymbols.length,
        resolvedCount: resolvedSymbols.length,
        returnedCount: params.returnedSymbols.length,
        registryMappedCount,
        registryUnmappedCount: Math.max(providerMarketCount - registryMappedCount, 0),
        requestedSymbols,
        resolvedSymbols,
        returnedSymbols: params.returnedSymbols,
        droppedSymbols,
        droppedReasonsSummary: summarizeDroppedReasons(droppedSymbols),
        sourceOfTruth: 'provider_market_universe',
        appliedLimit: params.appliedLimit ?? null,
        totalAvailableCount: params.totalAvailableCount ?? providerMarketCount,
        universe: {
          registrySymbols: params.universe.registrySymbols,
          marketSymbols: params.universe.marketSymbols,
          websocketTickerSymbols: params.universe.websocketTickerSymbols ?? params.universe.marketSymbols,
          capabilitySymbols: params.universe.capabilitySymbols,
          capabilityExcludedSymbols: params.universe.capabilityExcludedSymbols,
        },
      },
      'Resolved exchange market universe',
    );
  }
}
