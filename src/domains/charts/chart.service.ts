import { env } from '../../config/env';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
import { buildResolvedMarketCapabilityFlags } from '../../core/exchange/market.contract';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { normalizeMarketResolveInput, resolveExchangeMarketInput } from '../../core/exchange/market-metadata';
import { toCanonicalMarket, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import type {
  CanonicalCandle,
  CanonicalMarketCapabilities,
  CanonicalMarketMetadata,
  ExchangeId,
  ExchangeMarketDescriptor,
  MarketCapabilitySnapshot,
  QuoteCurrency,
} from '../../core/exchange/exchange.types';
import { marketEventBus } from '../../modules/public-market/market.event-bus';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import type {
  NormalizedMarketCandle,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
} from '../../modules/public-market/market.types';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  resolveCandleSnapshot,
  type CandleResponseMeta,
  type CandleRequestSupport,
  type CandleSnapshotSource,
  type CandleSnapshotStatus,
} from './candle.snapshot';

type ChartLiveStatus = 'live' | 'stale' | 'pending';

export type ChartCandlesResponse = {
  exchange: ExchangeId;
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
  capabilities: CanonicalMarketCapabilities;
  candlesSupported: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
  symbol: string;
  requestedInterval: string;
  interval: string;
  support: CandleRequestSupport;
  status: CandleSnapshotStatus;
  source: CandleSnapshotSource;
  fallbackApplied: boolean;
  staleCacheUsed: boolean;
  reason: string | null;
  items: CanonicalCandle[];
  live: NormalizedMarketCandle | null;
  liveStatus: ChartLiveStatus;
  asOf: number | null;
  freshnessMs: number | null;
  total: number;
  meta: CandleResponseMeta;
};

type ChartLiveHealth = {
  trackedMarketCount: number;
  trackedIntervalCount: number;
  emittedEventCount: number;
  lastTradeEventAt: number | null;
  lastTickerEventAt: number | null;
  lastSeededAt: number | null;
};

const INTERVAL_MS_MAP: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

const trackedIntervalsByMarket = new Map<string, Set<string>>();
const liveCandles = new Map<string, NormalizedMarketCandle>();
const liveHealth: ChartLiveHealth = {
  trackedMarketCount: 0,
  trackedIntervalCount: 0,
  emittedEventCount: 0,
  lastTradeEventAt: null,
  lastTickerEventAt: null,
  lastSeededAt: null,
};

let chartLiveStarted = false;
let tradeListener: ((payload: NormalizedMarketTrade) => void) | null = null;
let tickerListener: ((payload: NormalizedMarketTicker) => void) | null = null;

type ChartMarketLookupRequest = {
  symbol?: string;
  marketId?: string;
};

function intervalToMilliseconds(interval: string) {
  return INTERVAL_MS_MAP[interval] ?? null;
}

function assertCanonicalSymbol(symbol: string) {
  const canonical = toCanonicalSymbol(symbol);
  if (!canonical) {
    throw new AppError(400, 'symbol is required');
  }

  return canonical;
}

function classifyCandleRejectReason(reason?: string | null) {
  const normalized = reason?.trim().toLowerCase() ?? '';
  if (
    normalized.includes('not listed')
    || normalized.includes('could not be resolved')
    || normalized.includes('marketid')
  ) {
    return 'unknownMarket';
  }
  if (
    normalized.includes('alias_normalized')
    || normalized.includes('normalize')
    || normalized.includes('symbol_required')
  ) {
    return 'normalizeMismatch';
  }
  if (
    normalized.includes('provider_empty_response')
    || normalized.includes('empty_response')
    || normalized.includes('no_usable_candles')
    || normalized.includes('no data')
  ) {
    return 'providerNoData';
  }
  if (
    normalized.includes('insufficient')
    || normalized.includes('point_count')
    || normalized.includes('too_few')
  ) {
    return 'insufficientCandles';
  }
  return 'providerUnavailable';
}

function logCandleResolveDebug(params: {
  exchange: ExchangeId;
  inputSymbol?: string | null;
  inputMarketId?: string | null;
  resolvedMarketId: string;
  canonicalSymbol: string;
  providerSymbol: string;
  interval: string;
  baseAsset: string;
  quoteAsset: QuoteCurrency;
  matchSource?: string | null;
}) {
  logger.info(
    {
      domain: 'chart-live',
      ...params,
    },
    `[CandleResolveDebug] exchange=${params.exchange} inputSymbol=${params.inputSymbol ?? 'null'} resolvedMarketId=${params.resolvedMarketId} canonicalSymbol=${params.canonicalSymbol} providerSymbol=${params.providerSymbol} interval=${params.interval}`,
  );
}

function logCandleResponseDebug(params: {
  exchange: ExchangeId;
  requestKey: string;
  candleCount: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  source: string;
  marketId: string;
  canonicalSymbol: string;
}) {
  logger.info(
    {
      domain: 'chart-live',
      ...params,
    },
    `[CandleResponseDebug] exchange=${params.exchange} requestKey=${params.requestKey} candleCount=${params.candleCount} source=${params.source}`,
  );
}

function logCandleRejectDebug(params: {
  exchange: ExchangeId;
  inputSymbol?: string | null;
  inputMarketId?: string | null;
  marketId?: string | null;
  canonicalSymbol?: string | null;
  interval: string;
  rejectReason: string;
  reason?: string | null;
}) {
  logger.info(
    {
      domain: 'chart-live',
      ...params,
    },
    `[CandleRejectDebug] exchange=${params.exchange} rejectReason=${params.rejectReason} marketId=${params.marketId ?? 'null'} interval=${params.interval}`,
  );
}

function defaultCapabilitySnapshot(markets: ExchangeMarketDescriptor[]): MarketCapabilitySnapshot {
  const marketSymbols = Array.from(new Set(markets.map((market) => market.symbol)));
  return {
    websocketTickerSymbols: marketSymbols,
    capabilitySymbols: {
      tickers: marketSymbols,
      orderbook: marketSymbols,
      trades: marketSymbols,
      candles: marketSymbols,
    },
  };
}

function buildChartCapabilityMap(
  exchange: ExchangeId,
  snapshot: MarketCapabilitySnapshot,
  markets: ExchangeMarketDescriptor[],
) {
  return new Map(markets.map((market) => [
    market.symbol,
    buildResolvedMarketCapabilityFlags({
      exchange,
      market,
      capabilitySnapshot: snapshot,
    }),
  ]));
}

async function resolveChartMarketMetadata(
  exchange: ExchangeId,
  request: ChartMarketLookupRequest,
): Promise<{
  market: Pick<ExchangeMarketDescriptor, 'symbol' | 'marketId' | 'exchangeSymbol' | 'rawSymbol'>;
  metadata: CanonicalMarketMetadata;
  matchSource: 'market_id' | 'market_alias' | 'symbol' | 'fallback';
}> {
  try {
    const normalizedRequest = normalizeMarketResolveInput(request);
    const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
    if (typeof provider.listMarkets !== 'function') {
      const metadata = toCanonicalMarket(exchange, assertCanonicalSymbol(normalizedRequest.symbol ?? normalizedRequest.marketId ?? ''));
      return {
        market: {
          symbol: metadata.canonicalSymbol,
          marketId: metadata.marketId,
          exchangeSymbol: metadata.rawSymbol,
          rawSymbol: metadata.rawSymbol,
        },
        metadata,
        matchSource: 'fallback',
      };
    }
    const markets = (await provider.listMarkets()).filter((market) => market.tradable !== false);
    const capabilitySnapshot = provider.getMarketCapabilitySnapshot
      ? await provider.getMarketCapabilitySnapshot(markets)
      : defaultCapabilitySnapshot(markets);
    const resolved = resolveExchangeMarketInput({
      exchange,
      markets,
      input: normalizedRequest,
      capabilitiesBySymbol: buildChartCapabilityMap(
        exchange,
        capabilitySnapshot,
        markets,
      ),
    });

    if (!resolved.ok) {
      const reason = resolved.reason === 'MARKET_ID_NOT_FOUND'
        ? `marketId ${resolved.input} is not listed on ${exchange}`
        : resolved.reason === 'SYMBOL_NOT_FOUND'
          ? `symbol ${resolved.input} could not be resolved to a listed ${exchange} market`
          : 'marketId or symbol is required';
      logCandleRejectDebug({
        exchange,
        inputSymbol: request.symbol ?? null,
        inputMarketId: request.marketId ?? null,
        interval: 'n/a',
        rejectReason: 'unknownMarket',
        reason,
      });
      throw new AppError(400, reason);
    }

    logger.info(
      {
        domain: 'chart-live',
        exchange,
        rawInput: request.marketId ?? request.symbol ?? null,
        marketId: resolved.metadata.marketId,
        canonicalMarketId: resolved.metadata.canonicalMarketId,
        canonicalSymbol: resolved.metadata.canonicalSymbol,
        matchSource: resolved.matchSource,
      },
      `[MarketIdentity] market_identity_normalized exchange=${exchange} raw=${request.marketId ?? request.symbol ?? 'null'} canonical=${resolved.metadata.marketId}`,
    );

    if (resolved.identitySpecialCase) {
      logger.info(
        {
          domain: 'chart-live',
          exchange,
          marketId: resolved.metadata.marketId,
          canonicalMarketId: resolved.metadata.canonicalMarketId,
          reason: resolved.identitySpecialCase,
        },
        `[MarketIdentity] candle_identity_special_case exchange=${exchange} marketId=${resolved.metadata.marketId} reason=${resolved.identitySpecialCase}`,
      );
    }

    return {
      market: resolved.market,
      metadata: resolved.metadata,
      matchSource: resolved.matchSource,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError(503, `${exchange} chart market metadata is temporarily unavailable`);
  }
}

function buildChartResponseBase(metadata: CanonicalMarketMetadata) {
  return {
    exchange: metadata.exchange,
    marketId: metadata.marketId,
    canonicalMarketId: metadata.canonicalMarketId,
    rawSymbol: metadata.rawSymbol,
    canonicalSymbol: metadata.canonicalSymbol,
    baseAsset: metadata.baseAsset,
    quoteAsset: metadata.quoteAsset,
    displaySymbol: metadata.displaySymbol,
    koreanName: metadata.koreanName,
    englishName: metadata.englishName,
    iconUrl: metadata.iconUrl,
    isActive: metadata.isActive,
    capabilities: metadata.capabilities,
    candlesSupported: metadata.candlesSupported,
    graphSupported: metadata.graphSupported,
    supportedIntervals: [...metadata.supportedIntervals],
    unsupportedReason: metadata.unsupportedReason,
    symbol: metadata.canonicalSymbol,
  };
}

function applyChartMetadataToCandle<T extends {
  exchange: string;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: string;
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

function marketKey(exchange: ExchangeId, symbol: string) {
  return `${exchange}:${symbol}`;
}

function candleKey(exchange: ExchangeId, symbol: string, interval: string) {
  return `${exchange}:${symbol}:${interval}`;
}

function bucketStart(timestamp: number, intervalMs: number) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}

function isLiveCandleStale(asOf: number) {
  return Math.max(Date.now() - asOf, 0) > env.MARKET_DATA_STALE_THRESHOLD_MS;
}

function withLiveStatus(candle: NormalizedMarketCandle | null) {
  if (!candle) {
    return {
      candle: null,
      liveStatus: 'pending' as ChartLiveStatus,
      freshnessMs: null,
    };
  }

  const freshnessMs = Math.max(Date.now() - candle.asOf, 0);
  const stale = isLiveCandleStale(candle.asOf);
  return {
    candle: {
      ...candle,
      candleStatus: stale ? ('stale' as const) : ('live' as const),
      timestamp: candle.asOf,
    },
    liveStatus: stale ? 'stale' as ChartLiveStatus : 'live' as ChartLiveStatus,
    freshnessMs,
  };
}

function toTrackedIntervalSet(exchange: ExchangeId, symbol: string) {
  const key = marketKey(exchange, symbol);
  const existing = trackedIntervalsByMarket.get(key);
  if (existing) {
    return existing;
  }

  const created = new Set<string>();
  trackedIntervalsByMarket.set(key, created);
  liveHealth.trackedMarketCount = trackedIntervalsByMarket.size;
  return created;
}

function trackInterval(exchange: ExchangeId, symbol: string, interval: string) {
  const intervals = toTrackedIntervalSet(exchange, symbol);
  intervals.add(interval);
  liveHealth.trackedIntervalCount = Array.from(trackedIntervalsByMarket.values()).reduce((sum, entry) => sum + entry.size, 0);
}

function persistLiveCandle(candle: NormalizedMarketCandle, broadcast = true) {
  liveCandles.set(candleKey(candle.exchange as ExchangeId, candle.symbol, candle.interval), candle);
  publicMarketDataStore.upsertCandle(candle);
  if (broadcast) {
    marketEventBus.emitCandle(candle);
  }
  liveHealth.emittedEventCount += 1;
}

function createSeedCandle(params: {
  exchange: ExchangeId;
  symbol: string;
  interval: string;
  price: number;
  openTime: number;
  closeTime: number;
  asOf: number;
  sourceEvent: NormalizedMarketCandle['sourceEvent'];
  volume?: number;
}) {
  const market = toCanonicalMarket(params.exchange, params.symbol);
  return {
    channel: 'candles' as const,
    ...market,
    interval: params.interval,
    openTime: params.openTime,
    closeTime: params.closeTime,
    open: params.price,
    high: params.price,
    low: params.price,
    close: params.price,
    volume: params.volume ?? 0,
    asOf: params.asOf,
    timestamp: params.asOf,
    confirmed: false,
    candleStatus: isLiveCandleStale(params.asOf) ? ('stale' as const) : ('live' as const),
    sourceEvent: params.sourceEvent,
  };
}

function splitHistoricalCandles(candles: CanonicalCandle[], interval: string) {
  const intervalMs = intervalToMilliseconds(interval) ?? 60_000;
  const sorted = [...candles].sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime);
  const latest = sorted[sorted.length - 1] ?? null;
  const currentBucketStart = bucketStart(Date.now(), intervalMs);

  if (!latest) {
    return {
      historical: sorted,
      liveSeed: null as CanonicalCandle | null,
    };
  }

  if (latest.openTime >= currentBucketStart || latest.closeTime > Date.now()) {
    return {
      historical: sorted.slice(0, -1),
      liveSeed: latest,
    };
  }

  return {
    historical: sorted,
    liveSeed: null,
  };
}

function buildSyntheticCurrentCandle(
  exchange: ExchangeId,
  symbol: string,
  interval: string,
  anchorCandle: CanonicalCandle | null,
) {
  if (!anchorCandle) {
    return null;
  }

  const intervalMs = intervalToMilliseconds(interval) ?? 60_000;
  const openTime = bucketStart(Date.now(), intervalMs);
  return createSeedCandle({
    exchange,
    symbol,
    interval,
    price: anchorCandle.close,
    openTime,
    closeTime: openTime + intervalMs,
    asOf: anchorCandle.closeTime,
    sourceEvent: 'seed',
  });
}

function upsertSeedIfNewer(candle: NormalizedMarketCandle) {
  const key = candleKey(candle.exchange as ExchangeId, candle.symbol, candle.interval);
  const existing = liveCandles.get(key);
  if (!existing || existing.openTime < candle.openTime || existing.asOf <= candle.asOf) {
    persistLiveCandle(candle, false);
    liveHealth.lastSeededAt = Date.now();
    return candle;
  }

  return existing;
}

async function seedLiveCandleIfNeeded(exchange: ExchangeId, symbol: string, interval: string) {
  const key = candleKey(exchange, symbol, interval);
  const existing = liveCandles.get(key);
  if (existing) {
    return withLiveStatus(existing).candle;
  }

  const snapshot = await resolveCandleSnapshot({
    exchange,
    symbol,
    interval,
    limit: 3,
  });
  if (snapshot.items.length === 0 || !snapshot.interval) {
    return null;
  }

  const split = splitHistoricalCandles(snapshot.items, snapshot.interval);
  const liveSeed = split.liveSeed
    ? {
        channel: 'candles' as const,
        ...toCanonicalMarket(exchange, symbol),
        interval: snapshot.interval,
        openTime: split.liveSeed.openTime,
        closeTime: split.liveSeed.closeTime,
        open: split.liveSeed.open,
        high: split.liveSeed.high,
        low: split.liveSeed.low,
        close: split.liveSeed.close,
        volume: split.liveSeed.volume,
        asOf: Math.min(split.liveSeed.closeTime, Date.now()),
        timestamp: Math.min(split.liveSeed.closeTime, Date.now()),
        confirmed: false,
        candleStatus: 'live' as const,
        sourceEvent: 'seed' as const,
      }
    : buildSyntheticCurrentCandle(exchange, symbol, snapshot.interval, split.historical[split.historical.length - 1] ?? null);

  return liveSeed ? upsertSeedIfNewer(liveSeed) : null;
}

function updateTrackedCandlesFromPrice(params: {
  exchange: ExchangeId;
  symbol: string;
  price: number;
  timestamp: number;
  sourceEvent: NormalizedMarketCandle['sourceEvent'];
  quantity?: number;
}) {
  const intervals = trackedIntervalsByMarket.get(marketKey(params.exchange, params.symbol));
  if (!intervals || intervals.size === 0) {
    return;
  }

  for (const interval of intervals) {
    const intervalMs = intervalToMilliseconds(interval);
    if (!intervalMs) {
      continue;
    }

    const currentBucketOpenTime = bucketStart(params.timestamp, intervalMs);
    const key = candleKey(params.exchange, params.symbol, interval);
    const existing = liveCandles.get(key);
    if (!existing || existing.openTime !== currentBucketOpenTime) {
      const previousClose = existing?.close ?? params.price;
      const open = previousClose;
      persistLiveCandle({
        ...createSeedCandle({
          exchange: params.exchange,
          symbol: params.symbol,
          interval,
          price: open,
          openTime: currentBucketOpenTime,
          closeTime: currentBucketOpenTime + intervalMs,
          asOf: params.timestamp,
          sourceEvent: params.sourceEvent,
          volume: 0,
        }),
        high: Math.max(open, params.price),
        low: Math.min(open, params.price),
        close: params.price,
        volume: params.sourceEvent === 'trade' ? params.quantity ?? 0 : 0,
        asOf: params.timestamp,
        timestamp: params.timestamp,
      });
      continue;
    }

    persistLiveCandle({
      ...existing,
      high: Math.max(existing.high, params.price),
      low: Math.min(existing.low, params.price),
      close: params.price,
      volume: params.sourceEvent === 'trade' ? existing.volume + (params.quantity ?? 0) : existing.volume,
      asOf: params.timestamp,
      timestamp: params.timestamp,
      candleStatus: isLiveCandleStale(params.timestamp) ? ('stale' as const) : ('live' as const),
      sourceEvent: params.sourceEvent,
    });
  }
}

export function startChartLiveService() {
  if (chartLiveStarted) {
    return;
  }

  chartLiveStarted = true;
  tradeListener = (payload) => {
    liveHealth.lastTradeEventAt = payload.timestamp;
    updateTrackedCandlesFromPrice({
      exchange: payload.exchange as ExchangeId,
      symbol: payload.symbol,
      price: payload.price,
      timestamp: payload.timestamp,
      sourceEvent: 'trade',
      quantity: payload.quantity,
    });
  };
  tickerListener = (payload) => {
    liveHealth.lastTickerEventAt = payload.timestamp;
    updateTrackedCandlesFromPrice({
      exchange: payload.exchange as ExchangeId,
      symbol: payload.symbol,
      price: payload.price,
      timestamp: payload.timestamp,
      sourceEvent: 'ticker',
    });
  };

  marketEventBus.onTrade(tradeListener);
  marketEventBus.onTicker(tickerListener);
  logger.info({ domain: 'chart-live' }, 'Chart live candle service started');
}

export function stopChartLiveService() {
  if (!chartLiveStarted) {
    return;
  }

  chartLiveStarted = false;
  if (tradeListener) {
    marketEventBus.offTyped('trade', tradeListener);
    tradeListener = null;
  }
  if (tickerListener) {
    marketEventBus.offTyped('ticker', tickerListener);
    tickerListener = null;
  }
  trackedIntervalsByMarket.clear();
  liveCandles.clear();
  liveHealth.trackedMarketCount = 0;
  liveHealth.trackedIntervalCount = 0;
  logger.info({ domain: 'chart-live' }, 'Chart live candle service stopped');
}

export function getChartLiveHealth() {
  return { ...liveHealth };
}

export async function ensureChartLiveCandle(params: {
  exchange: ExchangeId;
  symbol: string;
  interval: string;
}) {
  const canonical = assertCanonicalSymbol(params.symbol);
  const effectiveInterval = resolveExchangeInterval(params.exchange, params.interval)?.resolvedInterval ?? params.interval;
  trackInterval(params.exchange, canonical, effectiveInterval);
  const cached = publicMarketDataStore.getCandle(params.exchange, canonical, effectiveInterval) ?? liveCandles.get(
    candleKey(params.exchange, canonical, effectiveInterval),
  );
  if (cached) {
    return withLiveStatus(cached).candle;
  }

  return seedLiveCandleIfNeeded(params.exchange, canonical, effectiveInterval);
}

export async function getChartCandles(params: {
  exchange: ExchangeId;
  symbol?: string;
  marketId?: string;
  interval: string;
  limit?: number;
}): Promise<ChartCandlesResponse> {
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) {
    throw new AppError(400, 'limit must be a positive integer');
  }

  const resolved = await resolveChartMarketMetadata(params.exchange, {
    symbol: params.symbol,
    marketId: params.marketId,
  });
  const metadata = resolved.metadata;
  const marketSymbol = resolved.market.symbol;
  const requestedLimit = params.limit ?? 200;
  const providerSymbol = resolved.market.rawSymbol ?? resolved.market.exchangeSymbol ?? metadata.rawSymbol;
  const requestKey = `${params.exchange}:${metadata.marketId}:${params.interval}`;

  logger.info(
    {
      domain: 'chart-live',
      exchange: params.exchange,
      marketId: metadata.marketId,
      canonicalMarketId: metadata.canonicalMarketId,
      candlesSupported: metadata.candlesSupported,
      graphSupported: metadata.graphSupported,
      supportedIntervals: metadata.supportedIntervals,
    },
    `[CandleAPI] candle_request_resolved exchange=${params.exchange} marketId=${metadata.marketId} canonicalMarketId=${metadata.canonicalMarketId}`,
  );
  logCandleResolveDebug({
    exchange: params.exchange,
    inputSymbol: params.symbol ?? null,
    inputMarketId: params.marketId ?? null,
    resolvedMarketId: metadata.marketId,
    canonicalSymbol: metadata.canonicalSymbol,
    providerSymbol,
    interval: params.interval,
    baseAsset: metadata.baseAsset,
    quoteAsset: metadata.quoteAsset,
    matchSource: resolved.matchSource,
  });

  if (!metadata.candlesSupported) {
    logger.info(
      {
        domain: 'chart-live',
        exchange: params.exchange,
        marketId: metadata.marketId,
        canonicalMarketId: metadata.canonicalMarketId,
        reason: metadata.unsupportedReason,
      },
      `[CandleAPI] candle_unsupported_classified exchange=${params.exchange} marketId=${metadata.marketId} reason=${metadata.unsupportedReason ?? 'provider_not_supported'}`,
    );
    logCandleRejectDebug({
      exchange: params.exchange,
      inputSymbol: params.symbol ?? null,
      inputMarketId: params.marketId ?? null,
      marketId: metadata.marketId,
      canonicalSymbol: metadata.canonicalSymbol,
      interval: params.interval,
      rejectReason: 'providerUnsupported',
      reason: metadata.unsupportedReason ?? 'provider_not_supported',
    });
    return {
      ...buildChartResponseBase(metadata),
      requestedInterval: params.interval,
      interval: params.interval,
      support: 'unsupported',
      status: 'unavailable',
      source: 'provider',
      fallbackApplied: false,
      staleCacheUsed: false,
      reason: metadata.unsupportedReason ?? 'provider_not_supported',
      items: [],
      live: null,
      liveStatus: 'pending',
      asOf: null,
      freshnessMs: null,
      total: 0,
      meta: {
        isRenderable: false,
        freshnessState: 'unavailable',
        lastSuccessfulAt: null,
        source: 'fallback',
        fallbackReason: metadata.unsupportedReason ?? 'provider_not_supported',
        pointCount: 0,
        renderPriority: 'unavailable',
        refreshPriority: 'visible',
        recommendedClientBehavior: 'cold_placeholder_only',
      },
    };
  }

  const snapshot = await resolveCandleSnapshot({
    exchange: params.exchange,
    symbol: marketSymbol,
    marketId: resolved.market.marketId ?? metadata.marketId,
    rawSymbol: resolved.market.rawSymbol ?? resolved.market.exchangeSymbol ?? metadata.rawSymbol,
    interval: params.interval,
    limit: requestedLimit + 1,
  });
  const effectiveInterval = snapshot.interval ?? snapshot.normalizedInterval;
  if (!effectiveInterval) {
    logCandleRejectDebug({
      exchange: params.exchange,
      inputSymbol: params.symbol ?? null,
      inputMarketId: params.marketId ?? null,
      marketId: metadata.marketId,
      canonicalSymbol: metadata.canonicalSymbol,
      interval: params.interval,
      rejectReason: classifyCandleRejectReason(snapshot.reason ?? 'interval_mapping_not_found'),
      reason: snapshot.reason ?? 'interval_mapping_not_found',
    });
    return {
      ...buildChartResponseBase(metadata),
      requestedInterval: params.interval,
      interval: params.interval,
      support: snapshot.support,
      status: snapshot.status,
      source: snapshot.source,
      fallbackApplied: snapshot.fallbackApplied,
      staleCacheUsed: snapshot.staleCacheUsed,
      reason: snapshot.reason,
      items: [],
      live: null,
      liveStatus: 'pending',
      asOf: null,
      freshnessMs: snapshot.freshnessMs,
      total: 0,
      meta: snapshot.meta,
    };
  }

  const split = splitHistoricalCandles(snapshot.items, effectiveInterval);
  const historical = split.historical
    .slice(-requestedLimit)
    .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime)
    .map((item) => applyChartMetadataToCandle(item, metadata));

  trackInterval(params.exchange, marketSymbol, effectiveInterval);
  const seededLive = split.liveSeed
    ? upsertSeedIfNewer({
        channel: 'candles',
        ...toCanonicalMarket(params.exchange, marketSymbol),
        interval: effectiveInterval,
        openTime: split.liveSeed.openTime,
        closeTime: split.liveSeed.closeTime,
        open: split.liveSeed.open,
        high: split.liveSeed.high,
        low: split.liveSeed.low,
        close: split.liveSeed.close,
        volume: split.liveSeed.volume,
        asOf: Math.min(split.liveSeed.closeTime, Date.now()),
        timestamp: Math.min(split.liveSeed.closeTime, Date.now()),
        confirmed: false,
        candleStatus: 'live' as const,
        sourceEvent: 'seed' as const,
      })
    : null;
  const live =
    seededLive
    ?? (await ensureChartLiveCandle({
      exchange: params.exchange,
      symbol: marketSymbol,
      interval: effectiveInterval,
    }))
    ?? buildSyntheticCurrentCandle(
      params.exchange,
      marketSymbol,
      effectiveInterval,
      historical[historical.length - 1] ?? null,
    );

  const liveState = withLiveStatus(live ? applyChartMetadataToCandle(live, metadata) : null);
  const asOf = liveState.candle?.asOf ?? historical[historical.length - 1]?.closeTime ?? null;

  logger.info(
    {
      domain: 'chart-live',
      exchange: params.exchange,
      marketId: metadata.marketId,
      symbol: marketSymbol,
      requestedInterval: params.interval,
      interval: effectiveInterval,
      candleStatus: snapshot.status,
      candleSource: snapshot.source,
      staleCacheUsed: snapshot.staleCacheUsed,
      historicalCount: historical.length,
      liveStatus: liveState.liveStatus,
      asOf,
      freshnessMs: liveState.freshnessMs,
      health: getChartLiveHealth(),
    },
    'Resolved chart candles response',
  );

  const pointCount = historical.length + (liveState.candle ? 1 : 0);
  const isRenderable = snapshot.meta.isRenderable || historical.length > 0 || Boolean(liveState.candle);
  const recommendedClientBehavior = isRenderable
    ? 'first_paint_ok' as const
    : snapshot.meta.lastSuccessfulAt !== null
      ? 'keep_existing' as const
      : 'cold_placeholder_only' as const;

  logger.info(
    {
      domain: 'chart-live',
      exchange: params.exchange,
      marketId: metadata.marketId,
      symbol: marketSymbol,
      freshnessState: snapshot.meta.freshnessState,
      isRenderable,
      pointCount,
      recommendedClientBehavior,
    },
    `[CandleMetaDebug] symbol=${marketSymbol} freshnessState=${snapshot.meta.freshnessState} isRenderable=${isRenderable} pointCount=${pointCount} recommendedClientBehavior=${recommendedClientBehavior}`,
  );
  if (!isRenderable) {
    logCandleRejectDebug({
      exchange: params.exchange,
      inputSymbol: params.symbol ?? null,
      inputMarketId: params.marketId ?? null,
      marketId: metadata.marketId,
      canonicalSymbol: metadata.canonicalSymbol,
      interval: effectiveInterval,
      rejectReason: historical.length === 0 && !liveState.candle ? 'insufficientCandles' : classifyCandleRejectReason(snapshot.reason),
      reason: snapshot.reason ?? (historical.length === 0 && !liveState.candle ? 'insufficient_chart_points' : null),
    });
  }
  logCandleResponseDebug({
    exchange: params.exchange,
    requestKey,
    candleCount: pointCount,
    firstTimestamp: historical[0]?.openTime ?? liveState.candle?.openTime ?? null,
    lastTimestamp: liveState.candle?.closeTime ?? historical[historical.length - 1]?.closeTime ?? null,
    source: liveState.candle ? `${snapshot.source}+live` : snapshot.source,
    marketId: metadata.marketId,
    canonicalSymbol: metadata.canonicalSymbol,
  });

  return {
    ...buildChartResponseBase(metadata),
    requestedInterval: params.interval,
    interval: effectiveInterval,
    support: snapshot.support,
    status: snapshot.status,
    source: snapshot.source,
    fallbackApplied: snapshot.fallbackApplied,
    staleCacheUsed: snapshot.staleCacheUsed,
    reason: snapshot.reason,
    items: historical,
    live: liveState.candle,
    liveStatus: liveState.liveStatus,
    asOf,
    freshnessMs: liveState.freshnessMs,
    total: historical.length,
    meta: {
      ...snapshot.meta,
      pointCount,
      isRenderable,
      recommendedClientBehavior,
    },
  };
}
