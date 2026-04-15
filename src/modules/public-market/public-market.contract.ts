import { z } from 'zod';
import { EXCHANGE_MAP } from '../../config/constants';
import type {
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
  timestamp: z.number(),
});

export const candleDtoSchema = z.object({
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
});

export const kimchiPremiumItemDtoSchema = z.object({
  exchange: exchangeIdSchema,
  exchangeName: z.string(),
  market: z.string(),
  priceKrw: z.number(),
  premiumPercent: z.number(),
});

export const kimchiPremiumResponseDtoSchema = z.object({
  baseExchange: z.literal('binance'),
  items: z.array(
    z.object({
      symbol: z.string(),
      nameKo: z.string(),
      nameEn: z.string(),
      binanceKrwPrice: z.number(),
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
]);

export const wsMarketWelcomeSchema = z.object({
  type: z.literal('welcome'),
  protocolVersion: z.literal(MARKET_WS_PROTOCOL_VERSION),
  path: z.literal('/ws/market'),
  authRequired: z.literal(false),
  channels: z.array(z.enum(['tickers', 'orderbook', 'trades'])),
  timestamp: z.number(),
});

export const wsMarketAckSchema = z.object({
  type: z.literal('ack'),
  requestId: z.string().optional(),
  action: z.enum(['subscribe', 'unsubscribe']),
  channel: z.enum(['tickers', 'orderbook', 'trades']),
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

function exchangeName(exchange: string) {
  return EXCHANGE_MAP.get(exchange)?.name ?? exchange;
}

export function serializeTickerDto(ticker: NormalizedMarketTicker) {
  return tickerDtoSchema.parse({
    exchange: ticker.exchange,
    exchangeName: exchangeName(ticker.exchange),
    symbol: ticker.symbol,
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
  });
}

export function serializeKimchiPremiumResponse(items: Array<{
  symbol: string;
  nameKo: string;
  nameEn: string;
  binanceKrwPrice: number;
  premiums: Array<{
    exchange: string;
    exchangeName: string;
    domesticPrice: number;
    premiumPercent: number;
  }>;
}>) {
  return kimchiPremiumResponseDtoSchema.parse({
    baseExchange: 'binance',
    items: items.map((item) => ({
      symbol: item.symbol,
      nameKo: item.nameKo,
      nameEn: item.nameEn,
      binanceKrwPrice: item.binanceKrwPrice,
      domestic: item.premiums.map((premium) => ({
        exchange: premium.exchange as z.infer<typeof exchangeIdSchema>,
        exchangeName: premium.exchangeName,
        market: `${item.symbol}/KRW`,
        priceKrw: premium.domesticPrice,
        premiumPercent: premium.premiumPercent,
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
    channels: ['tickers', 'orderbook', 'trades'],
    timestamp: Date.now(),
  });
}

export function serializeWsAckPayload(params: {
  requestId?: string;
  action: 'subscribe' | 'unsubscribe';
  channel: 'tickers' | 'orderbook' | 'trades';
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
