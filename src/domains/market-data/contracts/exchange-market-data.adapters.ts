import { AppError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { getExchangeConfig } from '../../../config/exchange.config';
import { aggregateCandles } from './candle-aggregation';
import type {
  CandleSnapshotParams,
  ContractExchange,
  ContractQuoteCurrency,
  ContractTimeframe,
  CurrentPriceSnapshot,
  ExchangeMarketDataAdapter,
  MarketCandle,
  MarketDescriptor,
  MarketTickerItem,
  TickerSparklineSource,
  TickerListParams,
} from './market-data.types';

type V1MarketResponse = Array<{
  market: string;
  korean_name?: string | null;
  english_name?: string | null;
}>;

type V1TickerResponse = Array<{
  market: string;
  trade_price?: number | string | null;
  signed_change_rate?: number | string;
  signed_change_price?: number | string;
  acc_trade_price_24h?: number | string;
  acc_trade_volume_24h?: number | string;
  high_price?: number | string;
  low_price?: number | string;
  timestamp?: number | string;
  trade_timestamp?: number | string;
}>;

type V1CandleResponse = Array<{
  candle_date_time_utc?: string;
  candle_date_time_kst?: string;
  timestamp?: number | string;
  opening_price: number | string;
  high_price: number | string;
  low_price: number | string;
  trade_price: number | string;
  candle_acc_trade_volume?: number | string;
  candle_acc_trade_price?: number | string;
}>;

type CoinoneMarketResponse = {
  markets?: Array<{
    quote_currency?: string;
    target_currency?: string;
    trade_status?: number | string;
    maintenance_status?: number | string;
  }>;
};

type CoinoneTickerResponse = {
  tickers?: Array<{
    quote_currency?: string;
    target_currency?: string;
    timestamp?: number | string;
    high?: number | string;
    low?: number | string;
    first?: number | string;
    last?: number | string;
    quote_volume?: number | string;
    target_volume?: number | string;
    yesterday_last?: number | string;
  }>;
};

type KorbitMarketResponse = {
  data?: Array<{ symbol?: string; status?: string }>;
};

type KorbitTickerResponse = {
  data?: unknown;
};

type BinanceExchangeInfoResponse = {
  symbols?: Array<{
    symbol?: string;
    baseAsset?: string;
    quoteAsset?: string;
    status?: string;
  }>;
};

type BinanceTickerResponse = Array<{
  symbol?: string;
  lastPrice?: number | string;
  priceChangePercent?: number | string;
  quoteVolume?: number | string;
  volume?: number | string;
  highPrice?: number | string;
  lowPrice?: number | string;
  closeTime?: number | string;
}>;

const BASE_URLS: Record<ContractExchange, string> = {
  upbit: 'https://api.upbit.com',
  bithumb: 'https://api.bithumb.com',
  coinone: 'https://api.coinone.co.kr',
  korbit: 'https://api.korbit.co.kr',
  binance: getExchangeConfig('binance').publicRestBaseUrl,
};

const REQUEST_TIMEOUT_MS = 4_000;
const TICKER_CHUNK_SIZE = 80;

const DIRECT_MINUTE_UNITS: Partial<Record<ContractTimeframe, number>> = {
  '1M': 1,
  '5M': 5,
  '15M': 15,
  '1H': 60,
};

function safeNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '0'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeString(value: unknown) {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function finiteNumberOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveNumberOrNull(value: unknown) {
  const parsed = finiteNumberOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function normalizeSymbol(symbol: string) {
  return symbol.trim().toUpperCase();
}

function parseTimestamp(item: V1CandleResponse[number]) {
  if (item.candle_date_time_utc) {
    return new Date(`${item.candle_date_time_utc.replace(' ', 'T')}Z`).toISOString();
  }
  if (item.timestamp !== undefined) {
    return new Date(safeNumber(item.timestamp)).toISOString();
  }
  if (item.candle_date_time_kst) {
    return new Date(`${item.candle_date_time_kst.replace(' ', 'T')}+09:00`).toISOString();
  }
  return new Date().toISOString();
}

function toMarketCandle(item: V1CandleResponse[number]): MarketCandle {
  const quoteVolume = safeNumber(item.candle_acc_trade_price);
  return {
    timestamp: parseTimestamp(item),
    open: safeNumber(item.opening_price),
    high: safeNumber(item.high_price),
    low: safeNumber(item.low_price),
    close: safeNumber(item.trade_price),
    volume: safeNumber(item.candle_acc_trade_volume),
    quoteVolume,
    value: quoteVolume,
    tradePriceVolume: quoteVolume,
  };
}

function summarizeQueryForLog(query: Record<string, string>) {
  const summarized: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === 'markets' && value.includes(',')) {
      const markets = value.split(',').filter(Boolean);
      summarized.marketsCount = markets.length;
      summarized.marketsPreview = markets.slice(0, 5).join(',');
      continue;
    }
    summarized[key] = value;
  }
  return summarized;
}

async function fetchJson<T>(exchange: ContractExchange, path: string, query: Record<string, string>) {
  const url = new URL(path, BASE_URLS[exchange]);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    logger.debug(
      {
        domain: 'market-contract',
        exchange,
        method: 'GET',
        path,
        query: summarizeQueryForLog(query),
        url: `${url.origin}${url.pathname}`,
      },
      `[MarketAdapter] request exchange=${exchange} path=${path}`,
    );
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const body = await response.text();
      throw new AppError(503, `${exchange} market data request failed`, {
        exchange,
        statusCode: response.status,
        retryable: response.status === 429 || response.status >= 500,
        source: 'external_exchange',
        body: body.slice(0, 240),
      }, 'EXCHANGE_REQUEST_FAILED');
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.warn({ domain: 'market-contract', exchange, path, err: error }, 'Market data adapter request failed');
    throw new AppError(503, `${exchange} market data is temporarily unavailable`, { exchange }, 'EXCHANGE_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function tickerUpdatedAt(item: V1TickerResponse[number]) {
  const timestamp = safeNumber(item.trade_timestamp ?? item.timestamp);
  return timestamp > 0 ? new Date(timestamp).toISOString() : new Date().toISOString();
}

function tickerTimestamp(item: V1TickerResponse[number]) {
  const timestamp = safeNumber(item.trade_timestamp ?? item.timestamp);
  return timestamp > 0 ? timestamp : Date.now();
}

function exchangeDisplayName(exchange: ContractExchange) {
  switch (exchange) {
    case 'upbit':
      return '업비트';
    case 'bithumb':
      return '빗썸';
    case 'coinone':
      return '코인원';
    case 'korbit':
      return '코빗';
    case 'binance':
      return '바이낸스';
  }
}

function toDisplayPair(symbol: string, quoteCurrency: ContractQuoteCurrency) {
  return `${normalizeSymbol(symbol)}/${quoteCurrency}`;
}

function estimatePreviousPrice24h(currentPrice: number | null, changeRate24h: number | null) {
  if (currentPrice === null || changeRate24h === null) {
    return null;
  }
  const ratio = 1 + changeRate24h / 100;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  const previous = currentPrice / ratio;
  return Number.isFinite(previous) && previous > 0 ? previous : null;
}

function buildInterpolatedSparkline(previous: number, current: number, sourceTimestamp: number) {
  const pointCount = 6;
  const startTimestamp = sourceTimestamp - 24 * 60 * 60 * 1000;
  return Array.from({ length: pointCount }, (_, index) => {
    const progress = index / (pointCount - 1);
    return {
      price: previous + (current - previous) * progress,
      timestamp: Math.round(startTimestamp + (sourceTimestamp - startTimestamp) * progress),
    };
  });
}

function resolveSparklineQuality(source: TickerSparklineSource) {
  if (source === 'provider') return 'provider_mini' as const;
  if (source === 'cache') return 'prepared_cache' as const;
  if (source === 'derived_change24h') return 'derived_preview' as const;
  if (source === 'flat_current') return 'flat_current' as const;
  return 'placeholder' as const;
}

function buildTickerSparkline(params: {
  currentPrice: number | null;
  previousPrice24h: number | null;
  changeRate24h: number | null;
  sourceTimestamp: number;
  providerSparkline?: { price: number; timestamp: number }[] | null;
}) {
  if (params.providerSparkline && params.providerSparkline.length >= 2) {
    const sparklineSource = 'provider' as const;
    return {
      previousPrice24h: params.previousPrice24h ?? estimatePreviousPrice24h(params.currentPrice, params.changeRate24h),
      sparkline: params.providerSparkline.map((point) => point.price),
      sparklinePoints: params.providerSparkline,
      sparklineSource,
      sparklineQuality: resolveSparklineQuality(sparklineSource),
      sparklinePointCount: params.providerSparkline.length,
      sparklineIsDerived: false,
    };
  }

  if (params.currentPrice === null) {
    const sparklineSource = 'unavailable' as const;
    return {
      previousPrice24h: null,
      sparkline: [],
      sparklinePoints: [],
      sparklineSource,
      sparklineQuality: resolveSparklineQuality(sparklineSource),
      sparklinePointCount: 0,
      sparklineIsDerived: false,
    };
  }

  const previousPrice24h = params.previousPrice24h ?? estimatePreviousPrice24h(params.currentPrice, params.changeRate24h);
  if (previousPrice24h !== null) {
    const sparklinePoints = buildInterpolatedSparkline(previousPrice24h, params.currentPrice, params.sourceTimestamp);
    const sparklineSource = 'derived_change24h' as const;
    return {
      previousPrice24h,
      sparkline: sparklinePoints.map((point) => point.price),
      sparklinePoints,
      sparklineSource,
      sparklineQuality: resolveSparklineQuality(sparklineSource),
      sparklinePointCount: sparklinePoints.length,
      sparklineIsDerived: true,
    };
  }

  const sparklinePoints = buildInterpolatedSparkline(params.currentPrice, params.currentPrice, params.sourceTimestamp);
  const sparklineSource = 'flat_current' as const;
  return {
    previousPrice24h: null,
    sparkline: sparklinePoints.map((point) => point.price),
    sparklinePoints,
    sparklineSource,
    sparklineQuality: resolveSparklineQuality(sparklineSource),
    sparklinePointCount: sparklinePoints.length,
    sparklineIsDerived: false,
  };
}

function readProviderSparkline(item: V1TickerResponse[number], sourceTimestamp: number) {
  const record = item as Record<string, unknown>;
  const pointCandidates = [record.sparklinePoints, record.sparkline_points];
  for (const candidate of pointCandidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    const points = candidate
      .map((point) => {
        if (!point || typeof point !== 'object') {
          return null;
        }
        const price = finiteNumberOrNull((point as Record<string, unknown>).price);
        const timestamp = finiteNumberOrNull((point as Record<string, unknown>).timestamp);
        return price !== null && timestamp !== null ? { price, timestamp } : null;
      })
      .filter((point): point is { price: number; timestamp: number } => Boolean(point));
    if (points.length >= 2) {
      return points;
    }
  }

  if (Array.isArray(record.sparkline)) {
    const prices = record.sparkline
      .map((value) => finiteNumberOrNull(value))
      .filter((value): value is number => value !== null);
    if (prices.length >= 2) {
      const startTimestamp = sourceTimestamp - 24 * 60 * 60 * 1000;
      return prices.map((price, index) => ({
        price,
        timestamp: Math.round(startTimestamp + ((sourceTimestamp - startTimestamp) * index) / (prices.length - 1)),
      }));
    }
  }

  return null;
}

function toTickerItem(params: {
  exchange: ContractExchange;
  marketId: string;
  exchangeSymbol?: string;
  rawSymbol?: string;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
  koreanName?: string | null;
  englishName?: string | null;
  currentPrice: number | null;
  changeRate24h: number | null;
  signedChangePrice24h?: number;
  accTradePrice24h: number;
  accTradeVolume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
  updatedAt?: string;
  providerSparkline?: Array<{ price: number; timestamp: number }> | null;
}) {
  const symbol = normalizeSymbol(params.symbol);
  const displayPair = toDisplayPair(symbol, params.quoteCurrency);
  const changeRate24h = params.changeRate24h;
  const signedChangePrice24h = params.signedChangePrice24h ?? 0;
  const previousPrice24h = params.currentPrice !== null && signedChangePrice24h !== 0
    ? params.currentPrice - signedChangePrice24h
    : null;
  const sparkline = buildTickerSparkline({
    currentPrice: params.currentPrice,
    previousPrice24h: previousPrice24h !== null && previousPrice24h > 0 ? previousPrice24h : null,
    changeRate24h,
    sourceTimestamp: params.timestamp,
    providerSparkline: params.providerSparkline,
  });
  const displayName = params.koreanName ?? params.englishName ?? symbol;

  return {
    exchange: params.exchange,
    exchangeName: exchangeDisplayName(params.exchange),
    market: params.marketId,
    marketId: params.marketId,
    exchangeSymbol: params.exchangeSymbol ?? params.marketId,
    rawSymbol: params.rawSymbol ?? params.exchangeSymbol ?? params.marketId,
    symbol,
    baseCurrency: symbol,
    displaySymbol: displayPair,
    displayPair,
    displayName,
    quoteCurrency: params.quoteCurrency,
    koreanName: params.koreanName ?? symbol,
    englishName: params.englishName ?? symbol,
    currentPrice: params.currentPrice,
    current: params.currentPrice,
    price: params.currentPrice,
    tradePrice: params.currentPrice,
    changeRate24h,
    change24h: changeRate24h,
    percent: changeRate24h,
    changeRate: changeRate24h,
    signedChangeRate: changeRate24h,
    signedChangePrice24h,
    changePrice: signedChangePrice24h,
    signedChangePrice: signedChangePrice24h,
    accTradePrice24h: params.accTradePrice24h,
    value: params.accTradePrice24h,
    accTradeVolume24h: params.accTradeVolume24h,
    volume: params.accTradeVolume24h,
    volume24h: params.accTradeVolume24h,
    high24h: params.high24h,
    low24h: params.low24h,
    timestamp: params.timestamp,
    sourceTimestamp: params.timestamp,
    stale: false,
    updatedAt: params.updatedAt ?? new Date(params.timestamp).toISOString(),
    previousPrice24h: sparkline.previousPrice24h,
    sparkline: sparkline.sparkline,
    sparklinePoints: sparkline.sparklinePoints,
    sparklineSource: sparkline.sparklineSource,
    sparklineQuality: sparkline.sparklineQuality,
    sparklinePointCount: sparkline.sparklinePointCount,
    sparklineIsDerived: sparkline.sparklineIsDerived,
  } satisfies MarketTickerItem;
}

function sortAndLimitTickerItems(items: MarketTickerItem[], params: TickerListParams) {
  const sort = params.sort ?? 'volume';
  const order = params.order ?? 'desc';
  const direction = order === 'asc' ? 1 : -1;
  const sorted = [...items].sort((left, right) => {
    if (sort === 'name') {
      return direction * left.symbol.localeCompare(right.symbol);
    }
    const leftValue = sort === 'price'
      ? left.currentPrice ?? Number.NEGATIVE_INFINITY
      : sort === 'changeRate'
        ? left.changeRate24h ?? Number.NEGATIVE_INFINITY
        : left.accTradePrice24h;
    const rightValue = sort === 'price'
      ? right.currentPrice ?? Number.NEGATIVE_INFINITY
      : sort === 'changeRate'
        ? right.changeRate24h ?? Number.NEGATIVE_INFINITY
        : right.accTradePrice24h;
    return direction * (leftValue - rightValue);
  });
  return params.limit ? sorted.slice(0, params.limit) : sorted;
}

export class V1ExchangeMarketDataAdapter implements ExchangeMarketDataAdapter {
  constructor(readonly exchange: ContractExchange) {}

  normalizeMarket(symbol: string, quoteCurrency: ContractQuoteCurrency) {
    const base = normalizeSymbol(symbol);
    if (!base) {
      throw new AppError(400, 'symbol is required', { field: 'symbol' }, 'INVALID_SYMBOL');
    }
    if (base === quoteCurrency) {
      throw new AppError(400, 'symbol and quoteCurrency cannot be the same', { symbol: base, quoteCurrency }, 'INVALID_MARKET');
    }
    return `${quoteCurrency}-${base}`;
  }

  parseMarket(market: string) {
    const match = market.trim().toUpperCase().match(/^(KRW|BTC|USDT|ETH)-([A-Z0-9]+)$/);
    if (!match) {
      return null;
    }
    return {
      quoteCurrency: match[1] as ContractQuoteCurrency,
      symbol: match[2],
    };
  }

  async listMarkets(quoteCurrency: ContractQuoteCurrency) {
    const response = await fetchJson<V1MarketResponse>(this.exchange, '/v1/market/all', { isDetails: 'true' });
    return response
      .filter((item) => item.market.startsWith(`${quoteCurrency}-`))
      .map<MarketDescriptor>((item) => {
        const parsed = this.parseMarket(item.market);
        return {
          exchange: this.exchange,
          market: item.market,
          symbol: parsed?.symbol ?? item.market.replace(`${quoteCurrency}-`, ''),
          quoteCurrency,
          koreanName: item.korean_name ?? null,
          englishName: item.english_name ?? null,
        };
      });
  }

  async getCandles(params: CandleSnapshotParams) {
    const market = this.normalizeMarket(params.symbol, params.quoteCurrency);
    const candles = await this.fetchCandlesForTimeframe(market, params.timeframe, params.limit);
    return candles
      .sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp))
      .slice(-params.limit);
  }

  async getTickers(params: TickerListParams) {
    const markets = await this.listMarkets(params.quoteCurrency);
    const descriptorsByMarket = new Map(markets.map((market) => [market.market, market]));
    const tickers: MarketTickerItem[] = [];

    for (const marketChunk of chunk(markets.map((market) => market.market), TICKER_CHUNK_SIZE)) {
      if (marketChunk.length === 0) {
        continue;
      }
      const response = await fetchJson<V1TickerResponse>(this.exchange, '/v1/ticker', {
        markets: marketChunk.join(','),
      }).catch((error) => {
        logger.warn(
          {
            domain: 'market-contract',
            exchange: this.exchange,
            markets: marketChunk.slice(0, 5),
            marketCount: marketChunk.length,
            retryable: true,
            err: error,
          },
          'Ticker chunk request failed; continuing with partial ticker response',
        );
        return null;
      });
      if (!response) {
        continue;
      }
      for (const item of response) {
        const descriptor = descriptorsByMarket.get(item.market);
        const parsed = this.parseMarket(item.market);
        if (!descriptor || !parsed) {
          continue;
        }
        const tradePrice = positiveNumberOrNull(item.trade_price);
        const rawSignedChangeRate = finiteNumberOrNull(item.signed_change_rate);
        const signedChangeRate = rawSignedChangeRate !== null ? Math.round(rawSignedChangeRate * 10_000) / 100 : null;
        const signedChangePrice = safeNumber(item.signed_change_price);
        const accTradePrice24h = safeNumber(item.acc_trade_price_24h);
        const accTradeVolume24h = safeNumber(item.acc_trade_volume_24h);
        const changeRate24h = signedChangeRate;
        const sourceTimestamp = tickerTimestamp(item);
        tickers.push(toTickerItem({
          exchange: this.exchange,
          marketId: item.market,
          exchangeSymbol: item.market,
          rawSymbol: item.market,
          symbol: parsed.symbol,
          quoteCurrency: parsed.quoteCurrency,
          koreanName: descriptor.koreanName,
          englishName: descriptor.englishName,
          currentPrice: tradePrice,
          changeRate24h,
          signedChangePrice24h: signedChangePrice,
          accTradePrice24h,
          accTradeVolume24h,
          high24h: safeNumber(item.high_price),
          low24h: safeNumber(item.low_price),
          timestamp: sourceTimestamp,
          updatedAt: tickerUpdatedAt(item),
          providerSparkline: readProviderSparkline(item, sourceTimestamp),
        }));
      }
    }

    if (tickers.length === 0 && markets.length > 0) {
      throw new AppError(503, `${this.exchange} market tickers are temporarily unavailable`, {
        exchange: this.exchange,
        retryable: true,
        source: 'external_exchange',
      }, 'EXCHANGE_UNAVAILABLE');
    }

    return this.sortAndLimit(tickers, params);
  }

  async getCurrentPrices(markets: string[]) {
    const normalizedMarkets = Array.from(new Set(markets.map((market) => market.trim().toUpperCase()).filter(Boolean)));
    const snapshots: CurrentPriceSnapshot[] = [];
    for (const marketChunk of chunk(normalizedMarkets, TICKER_CHUNK_SIZE)) {
      if (marketChunk.length === 0) {
        continue;
      }
      const response = await fetchJson<V1TickerResponse>(this.exchange, '/v1/ticker', {
        markets: marketChunk.join(','),
      });
      for (const item of response) {
        const parsed = this.parseMarket(item.market);
        if (!parsed) {
          continue;
        }
        snapshots.push({
          exchange: this.exchange,
          market: item.market,
          symbol: parsed.symbol,
          quoteCurrency: parsed.quoteCurrency,
          currentPrice: safeNumber(item.trade_price),
          high24h: safeNumber(item.high_price),
          low24h: safeNumber(item.low_price),
          changeRate24h: Math.round(safeNumber(item.signed_change_rate) * 10_000) / 100,
          volume24h: safeNumber(item.acc_trade_price_24h),
        });
      }
    }
    return snapshots;
  }

  private sortAndLimit(items: MarketTickerItem[], params: TickerListParams) {
    return sortAndLimitTickerItems(items, params);
  }

  private async fetchCandlesForTimeframe(market: string, timeframe: ContractTimeframe, limit: number) {
    if (timeframe === '4H') {
      const source = await this.fetchRawCandles(market, 'minutes', '60', Math.min(limit * 4 + 4, 500));
      return aggregateCandles(source, '4H', limit);
    }
    if (timeframe === '1W') {
      const source = await this.fetchRawCandles(market, 'days', undefined, Math.min(limit * 7 + 7, 500));
      return aggregateCandles(source, '1W', limit);
    }
    if (timeframe === '1D') {
      return this.fetchRawCandles(market, 'days', undefined, limit);
    }
    const unit = DIRECT_MINUTE_UNITS[timeframe];
    if (!unit) {
      throw new AppError(400, 'unsupported timeframe', { timeframe }, 'INVALID_TIMEFRAME');
    }
    return this.fetchRawCandles(market, 'minutes', String(unit), limit);
  }

  private async fetchRawCandles(
    market: string,
    kind: 'minutes' | 'days',
    unit: string | undefined,
    count: number,
  ) {
    const path = kind === 'minutes'
      ? `/v1/candles/minutes/${unit}`
      : '/v1/candles/days';
    const response = await fetchJson<V1CandleResponse>(this.exchange, path, {
      market,
      count: String(Math.min(Math.max(count, 1), 500)),
    });
    return response.reverse().map(toMarketCandle);
  }
}

abstract class QuoteFirstMarketDataAdapter implements ExchangeMarketDataAdapter {
  constructor(readonly exchange: ContractExchange) {}

  abstract listMarkets(quoteCurrency: ContractQuoteCurrency): Promise<MarketDescriptor[]>;
  abstract getTickers(params: TickerListParams): Promise<MarketTickerItem[]>;

  normalizeMarket(symbol: string, quoteCurrency: ContractQuoteCurrency) {
    const base = normalizeSymbol(symbol);
    if (!base) {
      throw new AppError(400, 'symbol is required', { field: 'symbol' }, 'INVALID_SYMBOL');
    }
    if (base === quoteCurrency) {
      throw new AppError(400, 'symbol and quoteCurrency cannot be the same', { symbol: base, quoteCurrency }, 'INVALID_MARKET');
    }
    return `${quoteCurrency}-${base}`;
  }

  parseMarket(market: string) {
    const normalized = market.trim().toUpperCase();
    const hyphen = normalized.match(/^(KRW|BTC|USDT|ETH)-([A-Z0-9]+)$/);
    if (hyphen) {
      return {
        quoteCurrency: hyphen[1] as ContractQuoteCurrency,
        symbol: hyphen[2],
      };
    }
    const slash = normalized.match(/^([A-Z0-9]+)\/(KRW|BTC|USDT|ETH)$/);
    if (slash) {
      return {
        quoteCurrency: slash[2] as ContractQuoteCurrency,
        symbol: slash[1],
      };
    }
    return null;
  }

  async getCandles(_params: CandleSnapshotParams): Promise<MarketCandle[]> {
    throw new AppError(400, `${this.exchange} candles are not supported by the market contract adapter`, {
      exchange: this.exchange,
    }, 'CANDLES_UNSUPPORTED');
  }

  async getCurrentPrices(markets: string[]) {
    const parsed = markets
      .map((market) => this.parseMarket(market))
      .filter((item): item is { symbol: string; quoteCurrency: ContractQuoteCurrency } => Boolean(item));
    const byQuote = new Map<ContractQuoteCurrency, string[]>();
    for (const item of parsed) {
      byQuote.set(item.quoteCurrency, [...(byQuote.get(item.quoteCurrency) ?? []), item.symbol]);
    }

    const snapshots: CurrentPriceSnapshot[] = [];
    for (const [quoteCurrency, symbols] of byQuote.entries()) {
      const tickers = await this.getTickers({ exchange: this.exchange, quoteCurrency });
      const requested = new Set(symbols);
      snapshots.push(...tickers
        .filter((ticker) => requested.has(ticker.symbol) && ticker.currentPrice !== null)
        .map((ticker) => ({
          exchange: this.exchange,
          market: ticker.marketId,
          symbol: ticker.symbol,
          quoteCurrency,
          currentPrice: ticker.currentPrice ?? 0,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          changeRate24h: ticker.changeRate24h ?? 0,
          volume24h: ticker.accTradePrice24h,
        })));
    }
    return snapshots;
  }
}

export class CoinoneMarketDataAdapter extends QuoteFirstMarketDataAdapter {
  constructor() {
    super('coinone');
  }

  async listMarkets(quoteCurrency: ContractQuoteCurrency) {
    const response = await fetchJson<CoinoneMarketResponse>(this.exchange, `/public/v2/markets/${quoteCurrency}`, {});
    return (response.markets ?? [])
      .filter((item) => safeString(item.quote_currency).toUpperCase() === quoteCurrency)
      .filter((item) => safeNumber(item.trade_status) === 1 && safeNumber(item.maintenance_status) === 0)
      .map<MarketDescriptor | null>((item) => {
        const symbol = normalizeSymbol(String(item.target_currency ?? ''));
        if (!symbol) {
          return null;
        }
        return {
          exchange: this.exchange,
          market: this.normalizeMarket(symbol, quoteCurrency),
          symbol,
          quoteCurrency,
          koreanName: null,
          englishName: symbol,
        };
      })
      .filter((item): item is MarketDescriptor => item !== null);
  }

  async getTickers(params: TickerListParams) {
    const markets = await this.listMarkets(params.quoteCurrency);
    const response = await fetchJson<CoinoneTickerResponse>(this.exchange, `/public/v2/ticker_new/${params.quoteCurrency}`, {
      additional_data: 'true',
    });
    const listed = new Map(markets.map((market) => [market.symbol, market]));
    const tickers = (response.tickers ?? [])
      .filter((item) => safeString(item.quote_currency).toUpperCase() === params.quoteCurrency)
      .map<MarketTickerItem | null>((item) => {
        const symbol = normalizeSymbol(String(item.target_currency ?? ''));
        const descriptor = listed.get(symbol);
        if (!descriptor) {
          return null;
        }
        const currentPrice = positiveNumberOrNull(item.last);
        const yesterdayLast = positiveNumberOrNull(item.yesterday_last) ?? positiveNumberOrNull(item.first);
        const changeRate24h = currentPrice !== null && yesterdayLast !== null && yesterdayLast > 0
          ? Math.round(((currentPrice - yesterdayLast) / yesterdayLast) * 10_000) / 100
          : null;
        const timestamp = finiteNumberOrNull(item.timestamp) ?? Date.now();
        return toTickerItem({
          exchange: this.exchange,
          marketId: descriptor.market,
          exchangeSymbol: symbol,
          rawSymbol: symbol,
          symbol,
          quoteCurrency: params.quoteCurrency,
          englishName: descriptor.englishName,
          currentPrice,
          changeRate24h,
          signedChangePrice24h: currentPrice !== null && yesterdayLast !== null ? currentPrice - yesterdayLast : 0,
          accTradePrice24h: safeNumber(item.quote_volume),
          accTradeVolume24h: safeNumber(item.target_volume),
          high24h: safeNumber(item.high),
          low24h: safeNumber(item.low),
          timestamp,
        });
      })
      .filter((item): item is MarketTickerItem => item !== null);

    if (tickers.length === 0 && markets.length > 0) {
      throw new AppError(503, 'Coinone ticker provider unavailable', {
        exchange: this.exchange,
        source: 'external_exchange',
      }, 'EXCHANGE_UNAVAILABLE');
    }
    return sortAndLimitTickerItems(tickers, params);
  }
}

export class KorbitMarketDataAdapter extends QuoteFirstMarketDataAdapter {
  constructor() {
    super('korbit');
  }

  async listMarkets(quoteCurrency: ContractQuoteCurrency) {
    const response = await fetchJson<KorbitMarketResponse>(this.exchange, '/v2/currencyPairs', {});
    return (response.data ?? [])
      .map((item) => ({
        raw: String(item.symbol ?? '').toLowerCase(),
        status: String(item.status ?? '').toLowerCase(),
      }))
      .filter((item) => item.raw.endsWith(`_${quoteCurrency.toLowerCase()}`))
      .filter((item) => !item.status || item.status === 'launched')
      .map<MarketDescriptor>((item) => {
        const symbol = normalizeSymbol(item.raw.replace(new RegExp(`_${quoteCurrency}$`, 'i'), ''));
        return {
          exchange: this.exchange,
          market: this.normalizeMarket(symbol, quoteCurrency),
          symbol,
          quoteCurrency,
          koreanName: null,
          englishName: symbol,
        };
      });
  }

  async getTickers(params: TickerListParams) {
    const markets = await this.listMarkets(params.quoteCurrency);
    const symbols = markets.map((market) => `${market.symbol.toLowerCase()}_${params.quoteCurrency.toLowerCase()}`);
    if (symbols.length === 0) {
      return [];
    }
    const response = await fetchJson<KorbitTickerResponse>(this.exchange, '/v2/tickers', {
      symbol: symbols.join(','),
    });
    const rawData = response.data ?? response;
    const rows = Array.isArray(rawData)
      ? rawData
      : Object.entries(rawData as Record<string, unknown>).map(([symbol, value]) => ({
        ...(value && typeof value === 'object' ? value as Record<string, unknown> : {}),
        symbol,
      }));
    const listed = new Map(markets.map((market) => [market.symbol, market]));
    const tickers = rows
      .map<MarketTickerItem | null>((item: any) => {
        const rawSymbol = String(item.symbol ?? item.currencyPair ?? '').toLowerCase();
        const symbol = normalizeSymbol(rawSymbol.replace(new RegExp(`_${params.quoteCurrency}$`, 'i'), ''));
        const descriptor = listed.get(symbol);
        if (!descriptor) {
          return null;
        }
        const currentPrice = positiveNumberOrNull(item.close ?? item.last);
        const changeRate24h = finiteNumberOrNull(item.priceChangePercent ?? item.changePercent);
        return toTickerItem({
          exchange: this.exchange,
          marketId: descriptor.market,
          exchangeSymbol: rawSymbol,
          rawSymbol,
          symbol,
          quoteCurrency: params.quoteCurrency,
          englishName: descriptor.englishName,
          currentPrice,
          changeRate24h,
          accTradePrice24h: safeNumber(item.quoteVolume ?? item.quote_volume ?? item.volume),
          accTradeVolume24h: safeNumber(item.volume ?? item.baseVolume ?? item.base_volume),
          high24h: safeNumber(item.high),
          low24h: safeNumber(item.low),
          timestamp: Date.now(),
        });
      })
      .filter((item): item is MarketTickerItem => item !== null);

    if (tickers.length === 0 && markets.length > 0) {
      throw new AppError(503, 'Korbit ticker provider unavailable', {
        exchange: this.exchange,
        source: 'external_exchange',
      }, 'EXCHANGE_UNAVAILABLE');
    }
    return sortAndLimitTickerItems(tickers, params);
  }
}

export class BinanceMarketDataAdapter implements ExchangeMarketDataAdapter {
  readonly exchange = 'binance' as const;

  normalizeMarket(symbol: string, quoteCurrency: ContractQuoteCurrency) {
    const base = normalizeSymbol(symbol);
    if (!base || base === quoteCurrency) {
      throw new AppError(400, 'invalid Binance market', { symbol, quoteCurrency }, 'INVALID_MARKET');
    }
    return `${base}${quoteCurrency}`;
  }

  parseMarket(market: string) {
    const normalized = market.trim().toUpperCase().replace(/[-_/]/g, '');
    for (const quoteCurrency of ['USDT', 'BTC', 'ETH', 'KRW'] as ContractQuoteCurrency[]) {
      if (normalized.endsWith(quoteCurrency) && normalized.length > quoteCurrency.length) {
        return {
          symbol: normalized.slice(0, -quoteCurrency.length),
          quoteCurrency,
        };
      }
    }
    return null;
  }

  async listMarkets(quoteCurrency: ContractQuoteCurrency) {
    const response = await fetchJson<BinanceExchangeInfoResponse>(this.exchange, '/api/v3/exchangeInfo', {});
    return (response.symbols ?? [])
      .filter((item) => safeString(item.quoteAsset).toUpperCase() === quoteCurrency)
      .filter((item) => safeString(item.status).toUpperCase() === 'TRADING')
      .map<MarketDescriptor | null>((item) => {
        const symbol = normalizeSymbol(String(item.baseAsset ?? ''));
        const market = normalizeSymbol(String(item.symbol ?? ''));
        if (!symbol || !market) {
          return null;
        }
        return {
          exchange: this.exchange,
          market,
          symbol,
          quoteCurrency,
          koreanName: null,
          englishName: symbol,
        };
      })
      .filter((item): item is MarketDescriptor => item !== null);
  }

  async getCandles(_params: CandleSnapshotParams): Promise<MarketCandle[]> {
    throw new AppError(400, 'Binance candles are not supported by this market contract path', {
      exchange: this.exchange,
    }, 'CANDLES_UNSUPPORTED');
  }

  async getTickers(params: TickerListParams) {
    const markets = await this.listMarkets(params.quoteCurrency);
    const marketById = new Map(markets.map((market) => [market.market, market]));
    const tickers: MarketTickerItem[] = [];
    for (const marketChunk of chunk(markets.map((market) => market.market), TICKER_CHUNK_SIZE)) {
      if (marketChunk.length === 0) {
        continue;
      }
      const response = await fetchJson<BinanceTickerResponse>(this.exchange, '/api/v3/ticker/24hr', {
        symbols: JSON.stringify(marketChunk),
      });
      for (const item of response) {
        const marketId = normalizeSymbol(String(item.symbol ?? ''));
        const descriptor = marketById.get(marketId);
        if (!descriptor) {
          continue;
        }
        const currentPrice = positiveNumberOrNull(item.lastPrice);
        const timestamp = finiteNumberOrNull(item.closeTime) ?? Date.now();
        tickers.push(toTickerItem({
          exchange: this.exchange,
          marketId,
          exchangeSymbol: marketId,
          rawSymbol: marketId,
          symbol: descriptor.symbol,
          quoteCurrency: params.quoteCurrency,
          englishName: descriptor.englishName,
          currentPrice,
          changeRate24h: finiteNumberOrNull(item.priceChangePercent),
          accTradePrice24h: safeNumber(item.quoteVolume),
          accTradeVolume24h: safeNumber(item.volume),
          high24h: safeNumber(item.highPrice),
          low24h: safeNumber(item.lowPrice),
          timestamp,
        }));
      }
    }
    if (tickers.length === 0 && markets.length > 0) {
      throw new AppError(503, 'Binance ticker provider unavailable', {
        exchange: this.exchange,
        source: 'external_exchange',
      }, 'EXCHANGE_UNAVAILABLE');
    }
    return sortAndLimitTickerItems(tickers, params);
  }

  async getCurrentPrices(markets: string[]) {
    const parsed = markets
      .map((market) => this.parseMarket(market))
      .filter((item): item is { symbol: string; quoteCurrency: ContractQuoteCurrency } => Boolean(item));
    const byQuote = new Map<ContractQuoteCurrency, string[]>();
    for (const item of parsed) {
      byQuote.set(item.quoteCurrency, [...(byQuote.get(item.quoteCurrency) ?? []), item.symbol]);
    }
    const snapshots: CurrentPriceSnapshot[] = [];
    for (const [quoteCurrency, symbols] of byQuote.entries()) {
      const tickers = await this.getTickers({ exchange: this.exchange, quoteCurrency });
      const requested = new Set(symbols);
      snapshots.push(...tickers
        .filter((ticker) => requested.has(ticker.symbol) && ticker.currentPrice !== null)
        .map((ticker) => ({
          exchange: this.exchange,
          market: ticker.marketId,
          symbol: ticker.symbol,
          quoteCurrency,
          currentPrice: ticker.currentPrice ?? 0,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          changeRate24h: ticker.changeRate24h ?? 0,
          volume24h: ticker.accTradePrice24h,
        })));
    }
    return snapshots;
  }
}
