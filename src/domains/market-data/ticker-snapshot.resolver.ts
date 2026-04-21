import { env } from '../../config/env';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { toCanonicalMarket } from '../../core/exchange/symbol.mapper';
import type {
  CanonicalTickerSnapshot,
  ExchangeId,
  FreshnessMetadata,
  MarketDataMode,
} from '../../core/exchange/exchange.types';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import { logger } from '../../utils/logger';

const PUBLIC_STORE_STALE_GRACE_MS = 10_000;

export type TickerSnapshotSource =
  | 'public_store_cache'
  | 'public_store_stale'
  | 'public_store_expired'
  | 'provider_snapshot';

export type TickerSnapshotLoad = {
  ticker: CanonicalTickerSnapshot | null;
  source: TickerSnapshotSource;
  reason?: string | null;
  error?: unknown;
};

export type TickerSnapshotLoadOptions = {
  freshnessTargetMs?: number;
  prioritySymbols?: Iterable<string>;
  priorityFreshnessTargetMs?: number;
  providerTimeoutMs?: number;
};

function fromCachedTicker(item: NonNullable<ReturnType<typeof publicMarketDataStore.getTicker>>): CanonicalTickerSnapshot {
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

export function calculateDataAge(timestamp: number | null | undefined) {
  if (!timestamp) {
    return null;
  }

  return Math.max(Date.now() - timestamp, 0);
}

export function isMarketDataStale(timestamp: number | null | undefined) {
  const age = calculateDataAge(timestamp);
  return age !== null ? age > env.MARKET_DATA_STALE_THRESHOLD_MS : false;
}

export function resolveTickerDataMode(source: TickerSnapshotSource): MarketDataMode {
  switch (source) {
    case 'public_store_cache':
      return 'streaming';
    case 'public_store_stale':
    case 'public_store_expired':
      return 'cached_snapshot';
    case 'provider_snapshot':
    default:
      return 'snapshot';
  }
}

export function createFreshnessMetadata(params: {
  dataMode: MarketDataMode;
  sourceTimestamp: number | null;
  staleThresholdMs?: number;
}): FreshnessMetadata & { stale: boolean; staleAgeMs: number | null } {
  const sourceTimestamp = params.sourceTimestamp ?? null;
  const cacheAgeMs = calculateDataAge(sourceTimestamp);
  const staleThresholdMs = params.staleThresholdMs ?? env.MARKET_DATA_STALE_THRESHOLD_MS;
  const stale = cacheAgeMs !== null ? cacheAgeMs > staleThresholdMs : false;

  return {
    dataMode: params.dataMode,
    isStale: stale,
    lastUpdatedAt: sourceTimestamp,
    sourceTimestamp,
    cacheAgeMs,
    stale,
    staleAgeMs: cacheAgeMs,
  };
}

function timeoutProviderSnapshot(exchange: ExchangeId, timeoutMs: number): Promise<CanonicalTickerSnapshot[]> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`${exchange} ticker snapshot timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

function chunkSymbols(symbols: string[], size: number) {
  if (size <= 0 || symbols.length <= size) {
    return [symbols];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < symbols.length; index += size) {
    chunks.push(symbols.slice(index, index + size));
  }
  return chunks;
}

function getProviderTickerChunkSize(exchange: ExchangeId) {
  switch (exchange) {
    case 'upbit':
    case 'korbit':
    case 'binance':
      return 40;
    case 'bithumb':
    case 'coinone':
    default:
      return 0;
  }
}

export async function getExchangeTickerLoads(
  exchange: ExchangeId,
  symbols: string[],
  options?: TickerSnapshotLoadOptions,
): Promise<Map<string, TickerSnapshotLoad>> {
  const results = new Map<string, TickerSnapshotLoad>();
  const providerSymbols: string[] = [];
  const expiredFallbacks = new Map<string, CanonicalTickerSnapshot>();
  const freshnessFallbacks = new Map<string, CanonicalTickerSnapshot>();
  const now = Date.now();
  const prioritySymbolSet = new Set(options?.prioritySymbols ?? []);

  const resolveFreshnessTargetMs = (symbol: string) => {
    if (prioritySymbolSet.has(symbol) && options?.priorityFreshnessTargetMs !== undefined) {
      return options.priorityFreshnessTargetMs;
    }

    return options?.freshnessTargetMs;
  };

  for (const symbol of symbols) {
    const cached = publicMarketDataStore.getTicker(exchange, symbol);
    if (!cached) {
      providerSymbols.push(symbol);
      logger.debug(
        { domain: 'ticker-snapshot', exchange, symbol, cacheOutcome: 'miss' },
        'Ticker snapshot cache miss',
      );
      continue;
    }

    const normalized = fromCachedTicker(cached);
    const ageMs = Math.max(now - cached.timestamp, 0);
    const freshnessTargetMs = resolveFreshnessTargetMs(symbol);
    const exceedsFreshnessTarget = freshnessTargetMs !== undefined && ageMs > freshnessTargetMs;
    if (exceedsFreshnessTarget) {
      freshnessFallbacks.set(symbol, normalized);
      providerSymbols.push(symbol);
      logger.debug(
        { domain: 'ticker-snapshot', exchange, symbol, cacheOutcome: 'stale', ageMs, freshnessTargetMs },
        'Ticker snapshot cache stale against freshness target',
      );
      continue;
    }

    if (ageMs <= env.MARKET_DATA_STALE_THRESHOLD_MS) {
      results.set(symbol, { ticker: normalized, source: 'public_store_cache' });
      logger.debug(
        { domain: 'ticker-snapshot', exchange, symbol, cacheOutcome: 'hit', ageMs },
        'Ticker snapshot cache hit',
      );
      continue;
    }

    if (ageMs <= env.MARKET_DATA_STALE_THRESHOLD_MS + PUBLIC_STORE_STALE_GRACE_MS) {
      results.set(symbol, { ticker: normalized, source: 'public_store_stale' });
      logger.debug(
        { domain: 'ticker-snapshot', exchange, symbol, cacheOutcome: 'stale', ageMs },
        'Ticker snapshot stale cache used',
      );
      continue;
    }

    expiredFallbacks.set(symbol, normalized);
    providerSymbols.push(symbol);
    logger.debug(
      { domain: 'ticker-snapshot', exchange, symbol, cacheOutcome: 'expired', ageMs },
      'Ticker snapshot cache expired',
    );
  }

  if (providerSymbols.length === 0) {
    return results;
  }

  try {
    const startedAt = Date.now();
    const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
    const chunkSize = getProviderTickerChunkSize(exchange);
    const symbolChunks = chunkSize > 0 ? chunkSymbols(providerSymbols, chunkSize) : [providerSymbols];
    logger.debug(
      {
        domain: 'ticker-snapshot',
        exchange,
        requestedSymbols: providerSymbols,
        requestedSymbolCount: providerSymbols.length,
        chunkCount: symbolChunks.length,
        chunkSize: chunkSize > 0 ? chunkSize : null,
        event: 'fetch_start',
      },
      'Ticker snapshot provider fetch start',
    );
    const snapshotChunks = await Promise.all(symbolChunks.map(async (symbolChunk) => {
      const providerRequest = provider.getTickerSnapshot(symbolChunk);
      return options?.providerTimeoutMs
        ? Promise.race([
            providerRequest,
            timeoutProviderSnapshot(exchange, options.providerTimeoutMs),
          ])
        : providerRequest;
    }));
    const snapshots = snapshotChunks.flat();
    logger.debug(
      {
        domain: 'ticker-snapshot',
        exchange,
        requestedSymbols: providerSymbols,
        requestedSymbolCount: providerSymbols.length,
        chunkCount: symbolChunks.length,
        responseItemCount: snapshots.length,
        latencyMs: Date.now() - startedAt,
        event: 'fetch_end',
      },
      'Ticker snapshot provider fetch end',
    );
    const snapshotMap = new Map(snapshots.map((ticker) => [ticker.symbol, ticker]));

    for (const symbol of providerSymbols) {
      const snapshot = snapshotMap.get(symbol);
      if (snapshot) {
        results.set(symbol, { ticker: snapshot, source: 'provider_snapshot' });
        continue;
      }

      if (freshnessFallbacks.has(symbol)) {
        results.set(symbol, {
          ticker: freshnessFallbacks.get(symbol) ?? null,
          source: 'public_store_stale',
          reason: 'freshness_target_exceeded_using_cached_projection',
        });
        continue;
      }

      if (expiredFallbacks.has(symbol)) {
        results.set(symbol, {
          ticker: expiredFallbacks.get(symbol) ?? null,
          source: 'public_store_expired',
          reason: 'missing_from_provider_snapshot_using_expired_cache',
        });
        continue;
      }

      results.set(symbol, {
        ticker: null,
        source: 'provider_snapshot',
        reason: 'missing_from_provider_snapshot',
      });
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(
      {
        domain: 'ticker-snapshot',
        exchange,
        requestedSymbols: providerSymbols,
        reason,
        err: error,
      },
      'Ticker snapshot provider fetch failed; resolving degraded loads',
    );
    for (const symbol of providerSymbols) {
      if (freshnessFallbacks.has(symbol)) {
        results.set(symbol, {
          ticker: freshnessFallbacks.get(symbol) ?? null,
          source: 'public_store_stale',
          reason: `freshness_target_exceeded_using_cached_projection: ${reason}`,
          error,
        });
        continue;
      }

      if (expiredFallbacks.has(symbol)) {
        results.set(symbol, {
          ticker: expiredFallbacks.get(symbol) ?? null,
          source: 'public_store_expired',
          reason: `provider_error_using_expired_cache: ${reason}`,
          error,
        });
        continue;
      }

      results.set(symbol, {
        ticker: null,
        source: 'provider_snapshot',
        reason,
        error,
      });
    }
  }

  return results;
}
