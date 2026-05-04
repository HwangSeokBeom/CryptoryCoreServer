import { env } from '../../../config/env';
import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import {
  BinanceMarketDataAdapter,
  CoinoneMarketDataAdapter,
  KorbitMarketDataAdapter,
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

type ContractSparklineItem = {
  exchange: ContractExchange;
  symbol: string;
  marketId: string;
  baseCurrency: string;
  quoteCurrency: ContractQuoteCurrency;
  displayPair: string;
  points: Array<{ price: number; timestamp: number }>;
  sparkline: number[];
  sparklinePoints: Array<{ price: number; timestamp: number }>;
  source: TickerSparklineSource | 'prepared_cache' | 'last_known_good';
  sparklineSource: TickerSparklineSource | 'prepared_cache' | 'last_known_good';
  quality: SparklineQuality;
  sparklineQuality: SparklineQuality;
  sparklinePointCount: number;
  isRenderable: boolean;
  isDerived: boolean;
  sparklineIsDerived: boolean;
  pointCount: number;
  stale: boolean;
  updatedAt: number | null;
  interval: ContractTimeframe;
  from: number | null;
  to: number | null;
  generatedAt: string;
  sourceReason?: string;
};

type CacheLoad<T> = {
  cacheHit: boolean;
  inFlightDedupe: boolean;
  promise: Promise<T>;
};

const SPARKLINE_SYMBOL_CAP = 50;
const SPARKLINE_DEFAULT_INTERVAL: ContractTimeframe = '1H';
const SPARKLINE_DEFAULT_LIMIT = 24;
const SPARKLINE_LIMIT_MAX = 60;
const PREPARED_SPARKLINE_MAX_POINTS = 60;
const PREPARED_SPARKLINE_REFINED_MIN_POINTS = 20;
const PREPARED_SPARKLINE_STALE_MS = 90_000;
const PREPARED_SPARKLINE_USABLE_STALE_MS = 10 * 60_000;
const SPARKLINE_WILDCARDS = new Set(['all', '*', 'null', 'undefined']);

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
const lastKnownGoodSparklineCache = new Map<string, ContractSparklineItem>();
let activeContractSparklineRequests = 0;

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
}): MarketTickerDiagnostics {
  return {
    requestedExchange: params.exchange,
    requestedQuoteCurrency: params.quoteCurrency,
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
  };
}

function warnUnexpectedSparklineHeavyProviderCall(provider: 'candles' | 'trades' | 'orderbook') {
  if (activeContractSparklineRequests <= 0) {
    return;
  }
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
  if (source === 'provider') return 'provider_mini';
  if (source === 'cache') return pointCount >= PREPARED_SPARKLINE_REFINED_MIN_POINTS ? 'refined_mini' : 'derived_preview';
  if (source === 'derived_change24h') return 'derived_preview';
  if (source === 'flat_current') return 'flat_current';
  return 'placeholder';
}

function withTickerSparklineMetadata(item: MarketTickerItem): MarketTickerItem {
  const sparklinePointCount = item.sparklinePointCount ?? item.sparklinePoints.length ?? item.sparkline.length;
  return {
    ...item,
    sparklinePointCount,
    sparklineQuality: item.sparklineQuality ?? resolveSparklineQuality(item.sparklineSource, sparklinePointCount),
    sparklineIsDerived: item.sparklineIsDerived ?? item.sparklineSource === 'derived_change24h',
  };
}

function preparedSparklineKey(
  exchange: ContractExchange,
  quoteCurrency: ContractQuoteCurrency,
  marketId: string,
  interval: ContractTimeframe,
) {
  return `${exchange}:${quoteCurrency}:${marketId.toUpperCase()}:${interval}`;
}

function appendPreparedSparklineSample(item: MarketTickerItem, interval: ContractTimeframe = SPARKLINE_DEFAULT_INTERVAL) {
  if (item.currentPrice === null || !Number.isFinite(item.currentPrice) || item.currentPrice <= 0) {
    return;
  }
  const key = preparedSparklineKey(item.exchange, item.quoteCurrency, item.marketId, interval);
  const existing = preparedSparklineCache.get(key) ?? [];
  const timestamp = Date.now();
  const next = [...existing, { price: item.currentPrice, timestamp }]
    .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-PREPARED_SPARKLINE_MAX_POINTS);
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
  const quality: SparklineQuality = params.source === 'last_known_good'
    ? 'prepared_cache'
    : points.length >= PREPARED_SPARKLINE_REFINED_MIN_POINTS
      ? 'refined_mini'
      : 'prepared_cache';
  return {
    exchange: params.item.exchange,
    symbol: params.item.symbol,
    marketId: params.item.marketId,
    baseCurrency: params.item.baseCurrency,
    quoteCurrency: params.item.quoteCurrency,
    displayPair: params.item.displayPair,
    points,
    sparkline: points.map((point) => point.price),
    sparklinePoints: points,
    source: params.source,
    sparklineSource: params.source,
    quality,
    sparklineQuality: quality,
    sparklinePointCount: points.length,
    isRenderable: points.length >= 2,
    isDerived: false,
    sparklineIsDerived: false,
    pointCount: points.length,
    stale,
    updatedAt,
    interval: params.interval,
    from: points[0]?.timestamp ?? null,
    to: updatedAt,
    generatedAt: new Date().toISOString(),
    sourceReason: params.sourceReason,
  };
}

function buildFallbackSparklineItem(item: MarketTickerItem, limit: number, interval: ContractTimeframe): ContractSparklineItem {
  const points = sampleSparklinePoints(item.sparklinePoints, limit);
  const pointCount = points.length;
  const quality = resolveSparklineQuality(item.sparklineSource, pointCount);
  const isDerived = item.sparklineSource === 'derived_change24h';
  return {
    exchange: item.exchange,
    symbol: item.symbol,
    marketId: item.marketId,
    baseCurrency: item.baseCurrency,
    quoteCurrency: item.quoteCurrency,
    displayPair: item.displayPair,
    points,
    sparkline: points.map((point) => point.price),
    sparklinePoints: points,
    source: item.sparklineSource,
    sparklineSource: item.sparklineSource,
    quality,
    sparklineQuality: quality,
    sparklinePointCount: pointCount,
    isRenderable: pointCount >= 2,
    isDerived,
    sparklineIsDerived: isDerived,
    pointCount,
    stale: item.stale,
    updatedAt: points[points.length - 1]?.timestamp ?? item.sourceTimestamp ?? null,
    interval,
    from: points[0]?.timestamp ?? null,
    to: points[points.length - 1]?.timestamp ?? item.sourceTimestamp ?? null,
    generatedAt: new Date().toISOString(),
    sourceReason: item.sparklineSource === 'derived_change24h'
      ? 'fallback_current_price_change_rate_24h'
      : item.sparklineSource === 'flat_current'
        ? 'fallback_current_price_only'
        : item.sparklineSource === 'unavailable'
          ? 'no_renderable_price'
          : 'provider_or_cache_ticker_sparkline',
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

export async function getMarketTickerList(params: TickerListParams) {
  const exchangeContract = getMarketExchangeContract(params.exchange);
  if (!isQuoteCurrencySupported(params.exchange, params.quoteCurrency)) {
    return {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      status: 'unsupported' as const,
      total: 0,
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
  const key = `tickers:${params.exchange}:${params.quoteCurrency}:${params.sort ?? 'volume'}:${params.order ?? 'desc'}:${params.limit ?? 'all'}`;
  const startedAt = Date.now();
  const { cacheHit, inFlightDedupe, promise } = ttlCache(key, env.TICKER_CACHE_TTL_SECONDS, () => getAdapter(params.exchange).getTickers(params));

  logger.info(
    { domain: 'market-contract', source: 'service', exchange: params.exchange, quoteCurrency: params.quoteCurrency, cacheHit, inFlightDedupe },
    `[MarketTickers] request source=service exchange=${params.exchange} quoteCurrency=${params.quoteCurrency}`,
  );

  const loadedItems = (await promise).map(withTickerSparklineMetadata);
  const zeroPriceCount = loadedItems.filter((item) => (item.currentPrice ?? 0) <= 0).length;
  const zeroVolumeCount = loadedItems.filter((item) => item.accTradePrice24h <= 0).length;
  const items = loadedItems.filter((item) => {
    if (item.exchange !== params.exchange || item.quoteCurrency !== params.quoteCurrency) {
      logger.warn(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          itemExchange: item.exchange,
          itemQuoteCurrency: item.quoteCurrency,
          marketId: item.marketId,
        },
        '[MarketTickers] dropping mismatched ticker row before response',
      );
      return false;
    }
    if (!item.displayPair.endsWith(`/${params.quoteCurrency}`)) {
      logger.warn(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          marketId: item.marketId,
          displayPair: item.displayPair,
        },
        '[MarketTickers] dropping ticker row with mismatched displayPair before response',
      );
      return false;
    }
    return true;
  });
  for (const item of items) {
    appendPreparedSparklineSample(item);
  }
  logger.info(
    { domain: 'market-contract', source: 'service', exchange: params.exchange, quoteCurrency: params.quoteCurrency, count: items.length, cacheHit, inFlightDedupe },
    `[MarketTickers] response count=${items.length} cacheHit=${cacheHit} inFlightDedupe=${inFlightDedupe}`,
  );

  return {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    supportedQuotes: exchangeContract.supportedQuotes,
    defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
    status: items.length > 0 ? 'success' : 'empty',
    total: items.length,
    items,
    diagnostics: createTickerDiagnostics({
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supported: true,
      providerStatus: items.length > 0 ? 'active' : 'degraded',
      providerLatencyMs: Date.now() - startedAt,
      rawCount: loadedItems.length,
      mappedCount: loadedItems.length,
      returnedCount: items.length,
      omittedCount: Math.max(loadedItems.length - items.length, 0),
      zeroPriceCount,
      zeroVolumeCount,
      staleCount: items.filter((item) => item.stale).length,
      reason: items.length > 0 ? null : 'empty_provider_response',
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
      if (item.sparklineSource === 'provider') {
        summary.provider += 1;
      } else if (item.sparklineSource === 'cache') {
        summary.cache += 1;
      } else if (item.sparklineSource === 'derived_change24h') {
        summary.derived += 1;
      } else if (item.sparklineSource === 'flat_current') {
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

export async function getMarketSparklineBatch(params: {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  symbols: string[];
  marketIds?: string[];
  interval?: ContractTimeframe;
  limit?: number;
}) {
  const interval = params.interval ?? SPARKLINE_DEFAULT_INTERVAL;
  const limit = Math.min(Math.max(params.limit ?? SPARKLINE_DEFAULT_LIMIT, 1), SPARKLINE_LIMIT_MAX);
  const exchangeContract = getMarketExchangeContract(params.exchange);
  const symbols = normalizeSparklineSymbols({
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    symbols: [...params.symbols, ...(params.marketIds ?? [])],
  });
  logger.info(
    {
      domain: 'market-contract',
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      symbols: params.symbols,
      marketIds: params.marketIds ?? [],
      limit,
    },
    `[SparklineRequest] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} symbols=${params.symbols.join(',')} marketIds=${(params.marketIds ?? []).join(',')} limit=${limit}`,
  );
  if (!isQuoteCurrencySupported(params.exchange, params.quoteCurrency)) {
    return {
      exchange: params.exchange,
      quoteCurrency: params.quoteCurrency,
      supportedQuotes: exchangeContract.supportedQuotes,
      defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
      interval,
      items: [],
      unsupportedSymbols: symbols,
      unavailableSymbols: [],
      diagnostics: {
        requestedExchange: params.exchange,
        requestedQuoteCurrency: params.quoteCurrency,
        unsupported: true,
        reason: 'quote_currency_not_supported',
        returnedCount: 0,
        pointCountMin: 0,
        pointCountMax: 0,
      },
    };
  }
  if (symbols.length === 0) {
    throw new AppError(400, 'symbols is required', { field: 'symbols' }, 'INVALID_SYMBOLS');
  }
  if (symbols.length > SPARKLINE_SYMBOL_CAP) {
    throw new AppError(400, `symbols must contain at most ${SPARKLINE_SYMBOL_CAP} items`, {
      field: 'symbols',
      max: SPARKLINE_SYMBOL_CAP,
      requested: symbols.length,
    }, 'SYMBOLS_LIMIT_EXCEEDED');
  }

  activeContractSparklineRequests += 1;
  const tickerResponse = await getMarketTickerList({
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
  }).finally(() => {
    activeContractSparklineRequests -= 1;
  });
  const requested = new Set(symbols);
  const rowsBySymbol = new Map(tickerResponse.items.map((item) => [item.symbol, item]));
  const unsupportedSymbols = symbols.filter((symbol) => !rowsBySymbol.has(symbol));
  const items = symbols
    .map((symbol) => rowsBySymbol.get(symbol))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map((item) => {
      const preparedKey = preparedSparklineKey(params.exchange, params.quoteCurrency, item.marketId, interval);
      const preparedPoints = preparedSparklineCache.get(preparedKey) ?? [];
      const prepared = buildPreparedSparklineItem({
        item,
        points: preparedPoints,
        limit,
        interval,
        source: 'prepared_cache',
        sourceReason: 'ticker_snapshot_ring_buffer',
      });
      if (prepared) {
        lastKnownGoodSparklineCache.set(preparedKey, prepared);
        logger.info(
          {
            domain: 'market-contract',
            exchange: params.exchange,
            quoteCurrency: params.quoteCurrency,
            marketId: item.marketId,
            bufferKey: preparedKey,
            bufferPointCount: preparedPoints.length,
            returnedPointCount: prepared.pointCount,
            quality: prepared.quality,
            isDerived: prepared.isDerived,
            reason: prepared.sourceReason,
          },
          `[SparklineItemBuild] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} bufferKey=${preparedKey} bufferPointCount=${preparedPoints.length} returnedPointCount=${prepared.pointCount} quality=${prepared.quality} isDerived=${prepared.isDerived} reason=${prepared.sourceReason}`,
        );
        return prepared;
      }

      const lastKnownGood = lastKnownGoodSparklineCache.get(preparedKey);
      if (
        lastKnownGood
        && lastKnownGood.updatedAt !== null
        && Date.now() - lastKnownGood.updatedAt <= PREPARED_SPARKLINE_USABLE_STALE_MS
      ) {
        return {
          ...lastKnownGood,
          source: 'last_known_good' as const,
          sparklineSource: 'last_known_good' as const,
          quality: 'prepared_cache' as const,
          sparklineQuality: 'prepared_cache' as const,
          stale: true,
          sourceReason: 'last_known_good_prepared_sparkline',
        };
      }

      const fallback = buildFallbackSparklineItem(item, limit, interval);
      logger.info(
        {
          domain: 'market-contract',
          exchange: params.exchange,
          quoteCurrency: params.quoteCurrency,
          marketId: item.marketId,
          bufferKey: preparedKey,
          reason: preparedPoints.length > 0 ? 'insufficient_buffer_points' : 'missing_buffer_points',
          fallbackPointCount: fallback.pointCount,
        },
        `[SparklineFallback] exchange=${params.exchange} quoteCurrency=${params.quoteCurrency} marketId=${item.marketId} reason=${preparedPoints.length > 0 ? 'insufficient_buffer_points' : 'missing_buffer_points'} fallbackPointCount=${fallback.pointCount}`,
      );
      return fallback;
    });
  const unavailableSymbols = items
    .filter((item) => !item.isRenderable)
    .map((item) => item.symbol)
    .filter((symbol) => requested.has(symbol));

  return {
    exchange: params.exchange,
    quoteCurrency: params.quoteCurrency,
    supportedQuotes: exchangeContract.supportedQuotes,
    defaultQuoteCurrency: exchangeContract.defaultQuoteCurrency,
    interval,
    items,
    unsupportedSymbols,
    unavailableSymbols,
    diagnostics: {
      requestedExchange: params.exchange,
      requestedQuoteCurrency: params.quoteCurrency,
      unsupported: false,
      reason: null,
      returnedCount: items.length,
      pointCountMin: items.length > 0 ? Math.min(...items.map((item) => item.pointCount)) : 0,
      pointCountMax: items.length > 0 ? Math.max(...items.map((item) => item.pointCount)) : 0,
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
  const normalized = value === 'volume_desc'
    ? 'volume'
    : value === 'change_desc'
      ? 'changeRate'
      : value === 'price_desc'
        ? 'price'
        : value === 'volume_asc'
          ? 'volume'
          : value === 'change_asc'
            ? 'changeRate'
            : value === 'price_asc'
              ? 'price'
              : value;
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
