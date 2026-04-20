import { z } from 'zod';
import { EXCHANGE_MAP } from '../../config/constants';
import type {
  NormalizedMarketCandle,
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
} from './market.types';

export const MARKET_WS_PROTOCOL_VERSION = '2026-04-15';

const exchangeIdSchema = z.enum(['upbit', 'bithumb', 'coinone', 'korbit', 'binance']);

export const marketLevelDtoSchema = z.object({
  price: z.number(),
  quantity: z.number(),
});

export const tickerDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  canonicalAssetKey: z.string().nullable().optional(),
  assetImageUrl: z.string().url().nullable().optional(),
  market: z.string(),
  baseCurrency: z.string(),
  quoteCurrency: z.string(),
  rawSymbol: z.string(),
  price: z.number(),
  change24h: z.number(),
  volume24h: z.number(),
  high24h: z.number(),
  low24h: z.number(),
  timestamp: z.number(),
});

export const orderbookDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  market: z.string(),
  baseCurrency: z.string(),
  quoteCurrency: z.string(),
  rawSymbol: z.string(),
  bestAsk: z.number(),
  bestBid: z.number(),
  spread: z.number(),
  asks: z.array(marketLevelDtoSchema),
  bids: z.array(marketLevelDtoSchema),
  timestamp: z.number(),
});

export const tradeDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  market: z.string(),
  baseCurrency: z.string(),
  quoteCurrency: z.string(),
  rawSymbol: z.string(),
  tradeId: z.string(),
  side: z.enum(['buy', 'sell']),
  price: z.number(),
  quantity: z.number(),
  notional: z.number(),
  timestamp: z.number().nullable(),
  executedAt: z.string().datetime().nullable(),
});

export const candleDtoSchema = z.object({
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const liveCandleDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  market: z.string(),
  baseCurrency: z.string(),
  quoteCurrency: z.string(),
  rawSymbol: z.string(),
  interval: z.string(),
  openTime: z.number(),
  closeTime: z.number(),
  asOf: z.number(),
  confirmed: z.boolean(),
  candleStatus: z.enum(['live', 'stale']),
  sourceEvent: z.enum(['seed', 'trade', 'ticker']),
  timestamp: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
});

export const tickersResponseDtoSchema = z.object({
  items: z.array(tickerDtoSchema),
  total: z.number().int().nonnegative(),
  snapshotAt: z.number(),
});

export const orderbookResponseDtoSchema = orderbookDtoSchema;

export const tradesResponseDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  market: z.string(),
  items: z.array(tradeDtoSchema),
  total: z.number().int().nonnegative(),
  snapshotAt: z.number(),
});

export const candlesResponseDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  symbol: z.string(),
  market: z.string(),
  interval: z.string(),
  items: z.array(candleDtoSchema),
  total: z.number().int().nonnegative(),
  meta: z.object({
    isRenderable: z.boolean(),
    freshnessState: z.enum(['live', 'stale', 'unavailable']),
    lastSuccessfulAt: z.number().nullable(),
    source: z.enum(['memory', 'redis', 'refreshed', 'fallback']),
    fallbackReason: z.string().nullable(),
    pointCount: z.number().int().nonnegative(),
    retryAfterMs: z.number().optional(),
    renderPriority: z.enum(['live', 'cached', 'stale', 'unavailable']),
    refreshPriority: z.enum(['visible', 'normal', 'background']),
    recommendedClientBehavior: z.enum(['keep_existing', 'first_paint_ok', 'cold_placeholder_only']),
  }).optional(),
});

export const kimchiPremiumItemDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  market: z.string(),
  priceKrw: z.number(),
  premiumPercent: z.number().nullable(),
  reason: z.string().nullable().optional(),
});

export const kimchiPremiumResponseDtoSchema = z.object({
  baseExchange: z.literal('binance'),
  items: z.array(
    z.object({
      symbol: z.string(),
      canonicalAssetKey: z.string().nullable().optional(),
      assetImageUrl: z.string().url().nullable().optional(),
      nameKo: z.string(),
      nameEn: z.string(),
      status: z.enum(['loaded', 'stale', 'partial', 'unavailable', 'failed']),
      selectedExchange: exchangeIdSchema.optional(),
      sourceExchange: exchangeIdSchema.nullable().optional(),
      freshnessState: z.enum(['fresh', 'slightly_stale', 'stale', 'partial', 'unavailable']).optional(),
      freshnessReason: z.string().nullable().optional(),
      displayMeta: z.object({
        status: z.enum(['ready', 'stale', 'partial', 'unavailable']),
        hasUsableDomesticPrice: z.boolean(),
        hasUsableReferencePrice: z.boolean(),
        hasUsableFxRate: z.boolean(),
        lastSuccessfulDomesticAt: z.number().nullable(),
        lastSuccessfulReferenceAt: z.number().nullable(),
        lastSuccessfulFxAt: z.number().nullable(),
        delayBucket: z.enum(['none', 'slight', 'moderate', 'severe']),
        displayHint: z.enum(['keep_last_good', 'loading_initial', 'unavailable_cold']),
      }).optional(),
      stableStatus: z.enum(['ready', 'stale', 'partial', 'unavailable']).optional(),
      hasUsableDomesticPrice: z.boolean().optional(),
      hasUsableReferencePrice: z.boolean().optional(),
      hasUsableFxRate: z.boolean().optional(),
      lastSuccessfulDomesticAt: z.number().nullable().optional(),
      lastSuccessfulReferenceAt: z.number().nullable().optional(),
      lastSuccessfulFxAt: z.number().nullable().optional(),
      delayBucket: z.enum(['none', 'slight', 'moderate', 'severe']).optional(),
      displayHint: z.enum(['keep_last_good', 'loading_initial', 'unavailable_cold']).optional(),
      updatedAt: z.number().nullable().optional(),
      computedAt: z.number().optional(),
      domesticPriceTimestamp: z.number().nullable().optional(),
      globalPriceTimestamp: z.number().nullable().optional(),
      fxRateTimestamp: z.number().nullable().optional(),
      freshnessMs: z.number().nullable().optional(),
      missingFields: z.array(z.string()),
      failureStage: z.enum(['reference_ticker', 'domestic_ticker', 'fx_rate', 'premium_compute', 'settlement']).nullable(),
      binanceKrwPrice: z.number().nullable(),
      convertedReferencePrice: z.number().nullable(),
      domesticPrice: z.number().nullable(),
      premiumPercent: z.number().nullable(),
      sparkline: z.array(z.number()).optional(),
      sparklinePoints: z.array(z.object({
        price: z.number(),
        timestamp: z.number(),
        premiumPercent: z.number().optional(),
      })).optional(),
      sparklinePointCount: z.number().int().nonnegative().optional(),
      sparklineStatus: z.enum(['ok', 'insufficientData', 'empty']).optional(),
      pointCount: z.number().int().nonnegative().optional(),
      rangeMin: z.number().nullable().optional(),
      rangeMax: z.number().nullable().optional(),
      lastUpdatedAt: z.number().nullable().optional(),
      domestic: z.array(kimchiPremiumItemDtoSchema),
    }),
  ),
  snapshotAt: z.number(),
});

export const wsMarketRequestSchema = z.union([
  z.object({
    requestId: z.string().optional(),
    action: z.literal('ping'),
  }),
  z.object({
    requestId: z.string().optional(),
    action: z.enum(['subscribe', 'unsubscribe']),
    channel: z.literal('tickers'),
    exchanges: z.array(exchangeIdSchema).optional(),
    symbols: z.array(z.string()).optional(),
  }),
  z.object({
    requestId: z.string().optional(),
    action: z.enum(['subscribe', 'unsubscribe']),
    channel: z.enum(['orderbook', 'trades']),
    exchange: exchangeIdSchema,
    symbols: z.array(z.string()).min(1),
  }),
  z.object({
    requestId: z.string().optional(),
    action: z.enum(['subscribe', 'unsubscribe']),
    channel: z.literal('candles'),
    exchange: exchangeIdSchema,
    symbols: z.array(z.string()).min(1),
    interval: z.string().optional(),
  }),
]);

export const wsMarketWelcomeSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.literal(MARKET_WS_PROTOCOL_VERSION),
  path: z.literal('/ws/market'),
  authRequired: z.literal(false),
  channels: z.array(z.enum(['tickers', 'orderbook', 'trades', 'candles'])),
  timestamp: z.number(),
});

export const wsMarketAckSchema = z.object({
  type: z.literal('ack'),
  requestId: z.string().optional(),
  action: z.enum(['subscribe', 'unsubscribe']),
  channel: z.enum(['tickers', 'orderbook', 'trades', 'candles']),
  filters: z.record(z.unknown()),
  snapshotSent: z.boolean(),
  timestamp: z.number(),
});

export const wsMarketErrorSchema = z.object({
  type: z.literal('error'),
  requestId: z.string().optional(),
  code: z.string(),
  message: z.string(),
  timestamp: z.number(),
});

export const wsMarketPongSchema = z.object({
  type: z.literal('pong'),
  requestId: z.string().optional(),
  timestamp: z.number(),
});

export const wsMarketTickerEventSchema = z.object({
  type: z.literal('event'),
  channel: z.literal('tickers'),
  data: tickerDtoSchema,
  timestamp: z.number(),
});

export const wsMarketOrderbookEventSchema = z.object({
  type: z.literal('event'),
  channel: z.literal('orderbook'),
  data: orderbookDtoSchema,
  timestamp: z.number(),
});

export const wsMarketTradeEventSchema = z.object({
  type: z.literal('event'),
  channel: z.literal('trades'),
  data: tradeDtoSchema,
  timestamp: z.number(),
});

export const wsMarketCandleEventSchema = z.object({
  type: z.literal('event'),
  channel: z.literal('candles'),
  data: liveCandleDtoSchema,
  timestamp: z.number(),
});

export type TickerDto = z.infer<typeof tickerDtoSchema>;
export type OrderbookDto = z.infer<typeof orderbookDtoSchema>;
export type TradeDto = z.infer<typeof tradeDtoSchema>;
export type CandleDto = z.infer<typeof candleDtoSchema>;
export type TickersResponseDto = z.infer<typeof tickersResponseDtoSchema>;
export type OrderbookResponseDto = z.infer<typeof orderbookResponseDtoSchema>;
export type TradesResponseDto = z.infer<typeof tradesResponseDtoSchema>;
export type CandlesResponseDto = z.infer<typeof candlesResponseDtoSchema>;
export type KimchiPremiumResponseDto = z.infer<typeof kimchiPremiumResponseDtoSchema>;
export type WsMarketRequest = z.infer<typeof wsMarketRequestSchema>;
export type WsMarketWelcome = z.infer<typeof wsMarketWelcomeSchema>;
export type WsMarketAck = z.infer<typeof wsMarketAckSchema>;
export type WsMarketError = z.infer<typeof wsMarketErrorSchema>;
export type WsMarketPong = z.infer<typeof wsMarketPongSchema>;
export type WsMarketTickerEvent = z.infer<typeof wsMarketTickerEventSchema>;
export type WsMarketOrderbookEvent = z.infer<typeof wsMarketOrderbookEventSchema>;
export type WsMarketTradeEvent = z.infer<typeof wsMarketTradeEventSchema>;
export type WsMarketCandleEvent = z.infer<typeof wsMarketCandleEventSchema>;

function exchangeName(exchange: string) {
  return EXCHANGE_MAP.get(exchange)?.name ?? exchange;
}

export function serializeTickerDto(ticker: NormalizedMarketTicker) {
  return tickerDtoSchema.parse({
    exchange: ticker.exchange,
    exchangeName: exchangeName(ticker.exchange),
    symbol: ticker.symbol,
    canonicalAssetKey: ticker.canonicalAssetKey ?? ticker.symbol,
    assetImageUrl: ticker.assetImageUrl ?? null,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  });
}

export function serializeOrderbookDto(orderbook: NormalizedMarketOrderbook) {
  return orderbookDtoSchema.parse({
    exchange: orderbook.exchange,
    exchangeName: exchangeName(orderbook.exchange),
    symbol: orderbook.symbol,
    market: orderbook.market,
    baseCurrency: orderbook.baseCurrency,
    quoteCurrency: orderbook.quoteCurrency,
    rawSymbol: orderbook.rawSymbol,
    bestAsk: orderbook.bestAsk,
    bestBid: orderbook.bestBid,
    spread: Math.max(orderbook.bestAsk - orderbook.bestBid, 0),
    asks: orderbook.asks.map((level) => ({
      price: level.price,
      quantity: level.qty,
    })),
    bids: orderbook.bids.map((level) => ({
      price: level.price,
      quantity: level.qty,
    })),
    timestamp: orderbook.timestamp,
  });
}

export function serializeOrderbookResponse(orderbook: NormalizedMarketOrderbook) {
  return orderbookResponseDtoSchema.parse(serializeOrderbookDto(orderbook));
}

export function serializeTradeDto(trade: NormalizedMarketTrade) {
  return tradeDtoSchema.parse({
    exchange: trade.exchange,
    exchangeName: exchangeName(trade.exchange),
    symbol: trade.symbol,
    market: trade.market,
    baseCurrency: trade.baseCurrency,
    quoteCurrency: trade.quoteCurrency,
    rawSymbol: trade.rawSymbol,
    tradeId: trade.tradeId,
    side: trade.side,
    price: trade.price,
    quantity: trade.quantity,
    notional: trade.price * trade.quantity,
    timestamp: trade.timestamp,
    executedAt: trade.executedAt ?? (trade.timestamp ? new Date(trade.timestamp).toISOString() : null),
  });
}

export function serializeTickersResponse(items: NormalizedMarketTicker[]) {
  return tickersResponseDtoSchema.parse({
    items: items.map(serializeTickerDto),
    total: items.length,
    snapshotAt: Date.now(),
  });
}

export function serializeTradesResponse(
  exchange: string,
  symbol: string,
  market: string,
  items: NormalizedMarketTrade[],
) {
  return tradesResponseDtoSchema.parse({
    exchange,
    exchangeName: exchangeName(exchange),
    symbol,
    market,
    items: items.map(serializeTradeDto),
    total: items.length,
    snapshotAt: Date.now(),
  });
}

export function serializeCandlesResponse(params: {
  exchange: string;
  symbol: string;
  market: string;
  interval: string;
  items: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>;
  meta?: {
    isRenderable: boolean;
    freshnessState: 'live' | 'stale' | 'unavailable';
    lastSuccessfulAt: number | null;
    source: 'memory' | 'redis' | 'refreshed' | 'fallback';
    fallbackReason: string | null;
    pointCount: number;
    retryAfterMs?: number;
    renderPriority: 'live' | 'cached' | 'stale' | 'unavailable';
    refreshPriority: 'visible' | 'normal' | 'background';
    recommendedClientBehavior: 'keep_existing' | 'first_paint_ok' | 'cold_placeholder_only';
  };
}) {
  return candlesResponseDtoSchema.parse({
    exchange: params.exchange,
    exchangeName: exchangeName(params.exchange),
    symbol: params.symbol,
    market: params.market,
    interval: params.interval,
    items: params.items.map((item) => ({
      timestamp: item.time,
      open: item.open,
      high: item.high,
      low: item.low,
      close: item.close,
      volume: item.volume,
    })),
    total: params.items.length,
    meta: params.meta,
  });
}

export function serializeKimchiPremiumResponse(items: Array<{
  symbol: string;
  canonicalAssetKey?: string | null;
  assetImageUrl?: string | null;
  nameKo: string;
  nameEn: string;
  status?: 'loaded' | 'stale' | 'partial' | 'unavailable' | 'failed';
  selectedExchange?: string;
  sourceExchange?: string | null;
  freshnessState?: 'fresh' | 'slightly_stale' | 'stale' | 'partial' | 'unavailable';
  freshnessReason?: string | null;
  displayMeta?: {
    status: 'ready' | 'stale' | 'partial' | 'unavailable';
    hasUsableDomesticPrice: boolean;
    hasUsableReferencePrice: boolean;
    hasUsableFxRate: boolean;
    lastSuccessfulDomesticAt: number | null;
    lastSuccessfulReferenceAt: number | null;
    lastSuccessfulFxAt: number | null;
    delayBucket: 'none' | 'slight' | 'moderate' | 'severe';
    displayHint: 'keep_last_good' | 'loading_initial' | 'unavailable_cold';
  };
  stableStatus?: 'ready' | 'stale' | 'partial' | 'unavailable';
  hasUsableDomesticPrice?: boolean;
  hasUsableReferencePrice?: boolean;
  hasUsableFxRate?: boolean;
  lastSuccessfulDomesticAt?: number | null;
  lastSuccessfulReferenceAt?: number | null;
  lastSuccessfulFxAt?: number | null;
  delayBucket?: 'none' | 'slight' | 'moderate' | 'severe';
  displayHint?: 'keep_last_good' | 'loading_initial' | 'unavailable_cold';
  updatedAt?: number | null;
  computedAt?: number;
  domesticPriceTimestamp?: number | null;
  globalPriceTimestamp?: number | null;
  fxRateTimestamp?: number | null;
  freshnessMs?: number | null;
  missingFields?: string[];
  failureStage?: 'reference_ticker' | 'domestic_ticker' | 'fx_rate' | 'premium_compute' | 'settlement' | null;
  binanceKrwPrice: number | null;
  convertedReferencePrice?: number | null;
  domesticPrice?: number | null;
  premiumPercent?: number | null;
  sparkline?: number[];
  sparklinePoints?: Array<{ price: number; timestamp: number; premiumPercent?: number }>;
  sparklinePointCount?: number;
  sparklineStatus?: 'ok' | 'insufficientData' | 'empty';
  pointCount?: number;
  rangeMin?: number | null;
  rangeMax?: number | null;
  lastUpdatedAt?: number | null;
  premiums: Array<{
    exchange: string;
    exchangeName: string;
    domesticPrice: number;
    premiumPercent: number | null;
    reason?: string | null;
  }>;
}>) {
  return kimchiPremiumResponseDtoSchema.parse({
    baseExchange: 'binance',
    items: items.map((item) => ({
      symbol: item.symbol,
      canonicalAssetKey: item.canonicalAssetKey ?? item.symbol,
      assetImageUrl: item.assetImageUrl ?? null,
      nameKo: item.nameKo,
      nameEn: item.nameEn,
      status: item.status ?? 'loaded',
      selectedExchange: item.selectedExchange as z.infer<typeof exchangeIdSchema> | undefined,
      sourceExchange: item.sourceExchange as z.infer<typeof exchangeIdSchema> | null | undefined,
      freshnessState: item.freshnessState,
      freshnessReason: item.freshnessReason ?? null,
      displayMeta: item.displayMeta,
      stableStatus: item.stableStatus ?? item.displayMeta?.status,
      hasUsableDomesticPrice: item.hasUsableDomesticPrice ?? item.displayMeta?.hasUsableDomesticPrice,
      hasUsableReferencePrice: item.hasUsableReferencePrice ?? item.displayMeta?.hasUsableReferencePrice,
      hasUsableFxRate: item.hasUsableFxRate ?? item.displayMeta?.hasUsableFxRate,
      lastSuccessfulDomesticAt: item.lastSuccessfulDomesticAt ?? item.displayMeta?.lastSuccessfulDomesticAt,
      lastSuccessfulReferenceAt: item.lastSuccessfulReferenceAt ?? item.displayMeta?.lastSuccessfulReferenceAt,
      lastSuccessfulFxAt: item.lastSuccessfulFxAt ?? item.displayMeta?.lastSuccessfulFxAt,
      delayBucket: item.delayBucket ?? item.displayMeta?.delayBucket,
      displayHint: item.displayHint ?? item.displayMeta?.displayHint,
      updatedAt: item.updatedAt,
      computedAt: item.computedAt,
      domesticPriceTimestamp: item.domesticPriceTimestamp,
      globalPriceTimestamp: item.globalPriceTimestamp,
      fxRateTimestamp: item.fxRateTimestamp,
      freshnessMs: item.freshnessMs,
      missingFields: item.missingFields ?? [],
      failureStage: item.failureStage ?? null,
      binanceKrwPrice: item.binanceKrwPrice,
      convertedReferencePrice: item.convertedReferencePrice ?? item.binanceKrwPrice,
      domesticPrice: item.domesticPrice ?? item.premiums[0]?.domesticPrice ?? null,
      premiumPercent: item.premiumPercent ?? item.premiums[0]?.premiumPercent ?? null,
      sparkline: item.sparkline,
      sparklinePoints: item.sparklinePoints,
      sparklinePointCount: item.sparklinePointCount,
      sparklineStatus: item.sparklineStatus,
      pointCount: item.pointCount,
      rangeMin: item.rangeMin,
      rangeMax: item.rangeMax,
      lastUpdatedAt: item.lastUpdatedAt,
      domestic: item.premiums.map((premium) => ({
        exchange: premium.exchange as z.infer<typeof exchangeIdSchema>,
        exchangeName: premium.exchangeName,
        market: `${item.symbol}/KRW`,
        priceKrw: premium.domesticPrice,
        premiumPercent: premium.premiumPercent,
        reason: premium.reason ?? null,
      })),
    })),
    snapshotAt: Date.now(),
  });
}

export function serializeWsWelcomePayload() {
  return wsMarketWelcomeSchema.parse({
    type: 'welcome',
    protocolVersion: MARKET_WS_PROTOCOL_VERSION,
    path: '/ws/market',
    authRequired: false,
    channels: ['tickers', 'orderbook', 'trades', 'candles'],
    timestamp: Date.now(),
  });
}

export function serializeWsAckPayload(params: {
  requestId?: string;
  action: 'subscribe' | 'unsubscribe';
  channel: 'tickers' | 'orderbook' | 'trades' | 'candles';
  filters: Record<string, unknown>;
  snapshotSent: boolean;
}) {
  return wsMarketAckSchema.parse({
    type: 'ack',
    requestId: params.requestId,
    action: params.action,
    channel: params.channel,
    filters: params.filters,
    snapshotSent: params.snapshotSent,
    timestamp: Date.now(),
  });
}

export function serializeWsErrorPayload(params: {
  requestId?: string;
  code: string;
  message: string;
}) {
  return wsMarketErrorSchema.parse({
    type: 'error',
    requestId: params.requestId,
    code: params.code,
    message: params.message,
    timestamp: Date.now(),
  });
}

export function serializeWsPongPayload(requestId?: string) {
  return wsMarketPongSchema.parse({
    type: 'pong',
    requestId,
    timestamp: Date.now(),
  });
}

export function serializeWsTickerEvent(ticker: NormalizedMarketTicker) {
  return wsMarketTickerEventSchema.parse({
    type: 'event',
    channel: 'tickers',
    data: serializeTickerDto(ticker),
    timestamp: Date.now(),
  });
}

export function serializeWsOrderbookEvent(orderbook: NormalizedMarketOrderbook) {
  return wsMarketOrderbookEventSchema.parse({
    type: 'event',
    channel: 'orderbook',
    data: serializeOrderbookDto(orderbook),
    timestamp: Date.now(),
  });
}

export function serializeWsTradeEvent(trade: NormalizedMarketTrade) {
  return wsMarketTradeEventSchema.parse({
    type: 'event',
    channel: 'trades',
    data: serializeTradeDto(trade),
    timestamp: Date.now(),
  });
}

export function serializeCandleDto(candle: NormalizedMarketCandle) {
  return liveCandleDtoSchema.parse({
    exchange: candle.exchange,
    exchangeName: exchangeName(candle.exchange),
    symbol: candle.symbol,
    market: candle.market,
    baseCurrency: candle.baseCurrency,
    quoteCurrency: candle.quoteCurrency,
    rawSymbol: candle.rawSymbol,
    interval: candle.interval,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    asOf: candle.asOf,
    confirmed: candle.confirmed,
    candleStatus: candle.candleStatus,
    sourceEvent: candle.sourceEvent,
    timestamp: candle.asOf,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  });
}

export function serializeWsCandleEvent(candle: NormalizedMarketCandle) {
  return wsMarketCandleEventSchema.parse({
    type: 'event',
    channel: 'candles',
    data: serializeCandleDto(candle),
    timestamp: Date.now(),
  });
}
