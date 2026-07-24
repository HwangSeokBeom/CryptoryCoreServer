import { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { EXCHANGE_IDS, type ExchangeId } from '../core/exchange/exchange.types';
import { ensureChartLiveCandle } from '../domains/charts/chart.service';
import { getPortfolioSnapshot } from '../domains/portfolio/portfolio.service';
import { getOpenOrders, getRecentFills } from '../domains/trading/trading.service';
import { floorTimestampToBucket } from '../domains/market-data/contracts/candle-aggregation';
import {
  getCurrentPriceSnapshots,
  normalizeContractMarket,
  normalizeContractSymbolInput,
  parseContractExchange,
  parseContractQuoteCurrency,
  parseContractTimeframe,
} from '../domains/market-data/contracts/market-data-contract.service';
import type {
  ContractExchange,
  ContractQuoteCurrency,
  ContractTimeframe,
  MarketCandle,
} from '../domains/market-data/contracts/market-data.types';
import { marketEventBus } from '../modules/public-market/market.event-bus';
import { publicMarketDataStore } from '../modules/public-market/market.data.store';
import { toUnifiedSymbol } from '../modules/public-market/market.normalization';
import {
  serializeWsAckPayload,
  serializeWsCandleEvent,
  serializeWsErrorPayload,
  serializeWsOrderbookEvent,
  serializeWsPongPayload,
  serializeWsTickerEvent,
  serializeWsTradeEvent,
  serializeWsWelcomePayload,
  wsMarketRequestSchema,
  type WsMarketRequest,
} from '../modules/public-market/public-market.contract';
import type {
  MarketChannel,
  NormalizedMarketCandle,
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
} from '../modules/public-market/market.types';
import { logger } from '../utils/logger';

interface ClientSubscriptionState {
  tickers: {
    keys: Set<string>;
  };
  orderbook: Set<string>;
  trades: Set<string>;
  candles: Set<string>;
  contractCandles: Set<string>;
}

interface ClientSocket extends WebSocket {
  isAlive?: boolean;
  messageWindowStartedAt?: number;
  messageCountInWindow?: number;
}

interface PrivateClientSocket extends ClientSocket {
  userId?: string;
  userEmail?: string;
}

type PrivateSubscriptionState = {
  userId: string;
  orders: Map<string, Set<string>>;
  fills: Map<string, Set<string>>;
  portfolio: Set<string>;
  pollTimer: NodeJS.Timeout | null;
  pollInFlight: boolean;
  orderDigests: Map<string, string>;
  portfolioDigests: Map<string, string>;
  sentFillIds: Set<string>;
};

type SetupWebSocketOptions = {
  privateStreamingEnabled?: boolean;
  verifyJwt?: (token: string) => Promise<unknown>;
};

type PrivateUpgradeRejection = {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

type PrivateUserContext = {
  userId: string;
  userEmail?: string;
};

type PrivateUpgradeVerification =
  | { rejection: PrivateUpgradeRejection; context?: never }
  | { context: PrivateUserContext; rejection?: never }
  | null;

let wss: WebSocketServer | null = null;
let privateWss: WebSocketServer | null = null;
let attachedServer: HttpServer | null = null;
let setupOptions: SetupWebSocketOptions = {};
let privateUpgradeListener:
  | ((request: IncomingMessage, socket: Duplex, head: Buffer) => void)
  | null = null;
const clientSubscriptions = new Map<ClientSocket, ClientSubscriptionState>();
const privateClientSubscriptions = new Map<PrivateClientSocket, PrivateSubscriptionState>();
let heartbeatInterval: NodeJS.Timeout | null = null;
let marketCandlePollInterval: NodeJS.Timeout | null = null;
let marketCandlePollInFlight = false;
const contractLiveCandles = new Map<string, MarketCandle>();
const MAX_CONTRACT_CANDLE_SUBSCRIPTIONS_PER_CLIENT = 8;
const MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT = 64;
const MAX_PRIVATE_SUBSCRIPTIONS_PER_CLIENT = 64;
const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const MAX_WS_MESSAGES_PER_WINDOW = 120;
const WS_MESSAGE_WINDOW_MS = 10_000;
const MAX_PRIVATE_DIGEST_ENTRIES = 2_048;

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    logger.warn(
      { domain: 'websocket', event: 'slow_consumer', bufferedAmount: ws.bufferedAmount },
      'Closing websocket slow consumer',
    );
    ws.close(1013, 'slow_consumer');
    setTimeout(() => ws.terminate(), 500).unref();
    return;
  }

  const serialized = JSON.stringify(payload);
  ws.send(serialized, (error) => {
    if (error) {
      logger.warn({ domain: 'websocket', event: 'send_failed', err: error }, 'Websocket send failed');
    }
  });
}

function consumeInboundBudget(ws: ClientSocket, raw: RawData) {
  if (Buffer.byteLength(raw.toString()) > MAX_WS_MESSAGE_BYTES) {
    ws.close(1009, 'message_too_large');
    return false;
  }

  const now = Date.now();
  if (!ws.messageWindowStartedAt || now - ws.messageWindowStartedAt >= WS_MESSAGE_WINDOW_MS) {
    ws.messageWindowStartedAt = now;
    ws.messageCountInWindow = 0;
  }
  ws.messageCountInWindow = (ws.messageCountInWindow ?? 0) + 1;
  if (ws.messageCountInWindow > MAX_WS_MESSAGES_PER_WINDOW) {
    logger.warn({ domain: 'websocket', event: 'message_rate_limited' }, 'Closing websocket message flood');
    ws.close(1008, 'message_rate_limited');
    return false;
  }
  return true;
}

function buildKey(exchange: string, symbol: string) {
  return `${exchange}:${toUnifiedSymbol(symbol)}`;
}

function buildCandleKey(exchange: string, symbol: string, interval: string) {
  return `${exchange}:${toUnifiedSymbol(symbol)}:${interval}`;
}

function normalizeTickerSubscriptionSymbol(symbol: string, quote?: string) {
  const normalized = symbol.trim().toUpperCase();
  const normalizedQuote = quote?.trim().toUpperCase() || null;

  if (normalized.includes('/')) {
    const [base, parsedQuote] = normalized.split('/');
    if (!normalizedQuote || parsedQuote === normalizedQuote) {
      return toUnifiedSymbol(base);
    }
  }

  if (normalized.includes('-')) {
    const [parsedQuote, base] = normalized.split('-');
    if (base && (!normalizedQuote || parsedQuote === normalizedQuote)) {
      return toUnifiedSymbol(base);
    }
  }

  if (normalized.includes('_')) {
    const [base, parsedQuote] = normalized.split('_');
    if (base && (!normalizedQuote || parsedQuote === normalizedQuote)) {
      return toUnifiedSymbol(base);
    }
  }

  return toUnifiedSymbol(normalized);
}

function buildContractCandleKey(
  exchange: ContractExchange,
  symbol: string,
  quoteCurrency: ContractQuoteCurrency,
  timeframe: ContractTimeframe,
) {
  return `${exchange}:${symbol.trim().toUpperCase()}:${quoteCurrency}:${timeframe}`;
}

function parseContractCandleKey(key: string) {
  const [exchange, symbol, quoteCurrency, timeframe] = key.split(':');
  if (!exchange || !symbol || !quoteCurrency || !timeframe) {
    return null;
  }
  return {
    exchange: exchange as ContractExchange,
    symbol,
    quoteCurrency: quoteCurrency as ContractQuoteCurrency,
    timeframe: timeframe as ContractTimeframe,
  };
}

function createSubscriptionState(): ClientSubscriptionState {
  return {
    tickers: {
      keys: new Set<string>(),
    },
    orderbook: new Set<string>(),
    trades: new Set<string>(),
    candles: new Set<string>(),
    contractCandles: new Set<string>(),
  };
}

function createPrivateSubscriptionState(userId: string): PrivateSubscriptionState {
  return {
    userId,
    orders: new Map<string, Set<string>>(),
    fills: new Map<string, Set<string>>(),
    portfolio: new Set<string>(),
    pollTimer: null,
    pollInFlight: false,
    orderDigests: new Map<string, string>(),
    portfolioDigests: new Map<string, string>(),
    sentFillIds: new Set<string>(),
  };
}

function matchesTicker(subscriptions: ClientSubscriptionState, ticker: NormalizedMarketTicker) {
  return subscriptions.tickers.keys.has(buildKey(ticker.exchange, ticker.symbol));
}

function matchesKeySubscription(subscriptions: Set<string>, exchange: string, symbol: string) {
  return subscriptions.has(buildKey(exchange, symbol));
}

function publishTicker(ticker: NormalizedMarketTicker) {
  for (const [ws, subscriptions] of clientSubscriptions.entries()) {
    if (matchesTicker(subscriptions, ticker)) {
      sendJson(ws, serializeWsTickerEvent(ticker));
    }
  }
}

function publishOrderbook(orderbook: NormalizedMarketOrderbook) {
  for (const [ws, subscriptions] of clientSubscriptions.entries()) {
    if (matchesKeySubscription(subscriptions.orderbook, orderbook.exchange, orderbook.symbol)) {
      sendJson(ws, serializeWsOrderbookEvent(orderbook));
    }
  }
}

function publishTrade(trade: NormalizedMarketTrade) {
  for (const [ws, subscriptions] of clientSubscriptions.entries()) {
    if (matchesKeySubscription(subscriptions.trades, trade.exchange, trade.symbol)) {
      sendJson(ws, serializeWsTradeEvent(trade));
    }
  }
}

function publishCandle(candle: NormalizedMarketCandle) {
  for (const [ws, subscriptions] of clientSubscriptions.entries()) {
    if (subscriptions.candles.has(buildCandleKey(candle.exchange, candle.symbol, candle.interval))) {
      sendJson(ws, serializeWsCandleEvent(candle));
    }
  }
}

function sendContractCandle(ws: WebSocket, key: string, candle: MarketCandle, isFinal: boolean) {
  const parsed = parseContractCandleKey(key);
  if (!parsed) {
    return;
  }
  sendJson(ws, {
    type: 'candle',
    exchange: parsed.exchange,
    symbol: parsed.symbol,
    quoteCurrency: parsed.quoteCurrency,
    market: normalizeContractMarket(parsed.exchange, parsed.symbol, parsed.quoteCurrency),
    timeframe: parsed.timeframe,
    candle,
    isFinal,
  });
}

function ensureMarketCandlePolling() {
  const activeCount = Array.from(clientSubscriptions.values())
    .reduce((total, state) => total + state.contractCandles.size, 0);
  if (activeCount === 0) {
    if (marketCandlePollInterval) {
      clearInterval(marketCandlePollInterval);
      marketCandlePollInterval = null;
    }
    return;
  }
  if (marketCandlePollInterval) {
    return;
  }

  logger.info({ domain: 'market-ws', event: 'external_connected', exchange: 'polling' }, '[MarketWS] external_connected exchange=polling');
  marketCandlePollInterval = setInterval(() => {
    void pollContractCandles();
  }, 5_000);
  marketCandlePollInterval.unref();
}

async function pollContractCandles() {
  if (marketCandlePollInFlight) {
    return;
  }

  const keys = Array.from(new Set(
    Array.from(clientSubscriptions.values()).flatMap((state) => Array.from(state.contractCandles)),
  ));
  if (keys.length === 0) {
    ensureMarketCandlePolling();
    return;
  }

  const requests = keys
    .map(parseContractCandleKey)
    .filter((value): value is {
      exchange: ContractExchange;
      symbol: string;
      quoteCurrency: ContractQuoteCurrency;
      timeframe: ContractTimeframe;
    } => Boolean(value));
  marketCandlePollInFlight = true;
  try {
    const prices = await getCurrentPriceSnapshots(requests);
    const priceByMarket = new Map(prices.map((price) => [
      `${price.exchange}:${price.symbol}:${price.quoteCurrency}`,
      price.currentPrice,
    ]));

    for (const key of keys) {
      const parsed = parseContractCandleKey(key);
      if (!parsed) {
        continue;
      }
      const currentPrice = priceByMarket.get(`${parsed.exchange}:${parsed.symbol}:${parsed.quoteCurrency}`);
      if (currentPrice === undefined) {
        continue;
      }
      const bucketStart = floorTimestampToBucket(Date.now(), parsed.timeframe);
      const existing = contractLiveCandles.get(key);
      const isNewBucket = !existing || Date.parse(existing.timestamp) !== bucketStart;
      const candle: MarketCandle = isNewBucket
        ? {
            timestamp: new Date(bucketStart).toISOString(),
            open: currentPrice,
            high: currentPrice,
            low: currentPrice,
            close: currentPrice,
            volume: 0,
            quoteVolume: 0,
          }
        : {
            ...existing,
            high: Math.max(existing.high, currentPrice),
            low: Math.min(existing.low, currentPrice),
            close: currentPrice,
          };
      contractLiveCandles.set(key, candle);
      for (const [ws, subscriptions] of clientSubscriptions.entries()) {
        if (subscriptions.contractCandles.has(key)) {
          sendContractCandle(ws, key, candle, false);
        }
      }
      logger.debug({ domain: 'market-ws', key }, '[MarketWS] candle_emit key=' + key);
    }
  } catch (error) {
    logger.warn({ domain: 'market-ws', err: error }, 'Contract market candle polling failed');
  } finally {
    marketCandlePollInFlight = false;
  }
}

function handleContractCandleSubscription(ws: ClientSocket, payload: Record<string, unknown>) {
  const type = typeof payload.type === 'string' ? payload.type : '';
  const parsedExchange = parseContractExchange(typeof payload.exchange === 'string' ? payload.exchange : undefined);
  const parsedQuote = parseContractQuoteCurrency(typeof payload.quoteCurrency === 'string' ? payload.quoteCurrency : undefined);
  const parsedTimeframe = parseContractTimeframe(typeof payload.timeframe === 'string' ? payload.timeframe : undefined);
  const requestedSymbol = typeof payload.symbol === 'string' ? payload.symbol.trim() : '';
  const subscriptions = clientSubscriptions.get(ws);

  if (
    !subscriptions
    || !parsedExchange
    || !parsedQuote
    || !parsedTimeframe
    || !requestedSymbol
    || requestedSymbol.length > 64
  ) {
    sendJson(ws, { type: 'error', code: 'INVALID_MARKET_CANDLE_SUBSCRIPTION', message: 'exchange, symbol, quoteCurrency, and timeframe are required.' });
    return true;
  }

  let symbol: string;
  try {
    symbol = normalizeContractSymbolInput(parsedExchange, requestedSymbol, parsedQuote);
  } catch (error) {
    sendJson(ws, {
      type: 'error',
      code: 'INVALID_MARKET_CANDLE_SUBSCRIPTION',
      message: error instanceof Error ? error.message : 'Invalid market candle subscription.',
    });
    return true;
  }
  const key = buildContractCandleKey(parsedExchange, symbol, parsedQuote, parsedTimeframe);
  if (type === 'unsubscribe') {
    subscriptions.contractCandles.delete(key);
    logger.info(
      { domain: 'market-ws', exchange: parsedExchange, symbol, quote: parsedQuote, timeframe: parsedTimeframe },
      `[MarketWS] unsubscribe exchange=${parsedExchange} symbol=${symbol} quote=${parsedQuote} timeframe=${parsedTimeframe}`,
    );
    ensureMarketCandlePolling();
    return true;
  }

  if (!subscriptions.contractCandles.has(key) && subscriptions.contractCandles.size >= MAX_CONTRACT_CANDLE_SUBSCRIPTIONS_PER_CLIENT) {
    logger.warn(
      {
        domain: 'market-ws',
        event: 'subscribe_limited',
        channel: 'market.candle',
        exchange: parsedExchange,
        symbol,
        quoteCurrency: parsedQuote,
        timeframe: parsedTimeframe,
        activeCount: subscriptions.contractCandles.size,
        max: MAX_CONTRACT_CANDLE_SUBSCRIPTIONS_PER_CLIENT,
      },
      '[MarketWS] subscribe_limited channel=market.candle reason=too_many_selected_symbols',
    );
    sendJson(ws, {
      type: 'error',
      code: 'MARKET_CANDLE_SUBSCRIPTION_LIMIT',
      message: 'Too many market.candle subscriptions for this client.',
      maxSubscriptions: MAX_CONTRACT_CANDLE_SUBSCRIPTIONS_PER_CLIENT,
    });
    return true;
  }

  subscriptions.contractCandles.add(key);
  logger.info(
    { domain: 'market-ws', exchange: parsedExchange, symbol, quote: parsedQuote, timeframe: parsedTimeframe },
    `[MarketWS] subscribe exchange=${parsedExchange} symbol=${symbol} quote=${parsedQuote} timeframe=${parsedTimeframe}`,
  );
  sendJson(ws, {
    type: 'ack',
    channel: 'market.candle',
    action: 'subscribe',
    exchange: parsedExchange,
    symbol,
    quoteCurrency: parsedQuote,
    timeframe: parsedTimeframe,
  });
  const live = contractLiveCandles.get(key);
  if (live) {
    sendContractCandle(ws, key, live, false);
  }
  ensureMarketCandlePolling();
  void pollContractCandles();
  return true;
}

function handleTickerSubscription(
  ws: ClientSocket,
  subscriptions: ClientSubscriptionState,
  message: Extract<WsMarketRequest, { channel: 'tickers' }>,
) {
  const exchanges = message.exchanges.map((exchange) => exchange.toLowerCase());
  const symbols = message.symbols.map((symbol) => normalizeTickerSubscriptionSymbol(symbol));
  const requestedKeys = new Set(
    exchanges.flatMap((exchange) => symbols.map((symbol) => buildKey(exchange, symbol))),
  );

  if (message.action === 'subscribe') {
    const nextKeys = new Set([...subscriptions.tickers.keys, ...requestedKeys]);
    if (nextKeys.size > MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT) {
      sendJson(
        ws,
        serializeWsErrorPayload({
          requestId: message.requestId,
          code: 'subscription_limit',
          message: `A client may subscribe to at most ${MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT} ticker markets.`,
        }),
      );
      return;
    }
    requestedKeys.forEach((key) => subscriptions.tickers.keys.add(key));
    logger.info(
      { domain: 'market-ws', event: 'subscribe', channel: 'ticker', exchanges, symbols },
      `[MarketWS] subscribe channel=ticker exchanges=${exchanges.join(',')} symbols=${symbols.join(',')}`,
    );
  } else {
    requestedKeys.forEach((key) => subscriptions.tickers.keys.delete(key));
    logger.info(
      { domain: 'market-ws', event: 'unsubscribe', channel: 'ticker', exchanges, symbols },
      `[MarketWS] unsubscribe channel=ticker exchanges=${exchanges.join(',')} symbols=${symbols.join(',')}`,
    );
  }

  sendJson(
    ws,
    serializeWsAckPayload({
      requestId: message.requestId,
      action: message.action,
      channel: 'tickers',
      filters: {
        active: subscriptions.tickers.keys.size > 0,
        exchanges,
        symbols,
        markets: Array.from(subscriptions.tickers.keys),
      },
      snapshotSent: message.action === 'subscribe',
    }),
  );

  if (message.action !== 'subscribe') return;

  const snapshots = publicMarketDataStore
    .getTickers()
    .filter((ticker) => requestedKeys.has(buildKey(ticker.exchange, ticker.symbol)));

  snapshots.forEach((ticker) => sendJson(ws, serializeWsTickerEvent(ticker)));
}

function handleKeyedSubscription(
  ws: ClientSocket,
  subscriptions: Set<string>,
  channel: Extract<MarketChannel, 'orderbook' | 'trades'>,
  message: Extract<WsMarketRequest, { channel: 'orderbook' | 'trades' }>,
) {
  const exchange = message.exchange.toLowerCase();
  const symbols = message.symbols.map((symbol) => toUnifiedSymbol(symbol));
  const keys = symbols.map((symbol) => buildKey(exchange, symbol));

  if (message.action === 'subscribe') {
    const nextKeys = new Set([...subscriptions, ...keys]);
    if (nextKeys.size > MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT) {
      sendJson(
        ws,
        serializeWsErrorPayload({
          requestId: message.requestId,
          code: 'subscription_limit',
          message: `A client may subscribe to at most ${MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT} ${channel} markets.`,
        }),
      );
      return;
    }
    keys.forEach((key) => subscriptions.add(key));
    logger.info(
      { domain: 'market-ws', event: 'subscribe', channel, exchange, symbols },
      `[MarketWS] subscribe channel=${channel} exchange=${exchange} symbols=${symbols.join(',')}`,
    );
  } else {
    keys.forEach((key) => subscriptions.delete(key));
    logger.info(
      { domain: 'market-ws', event: 'unsubscribe', channel, exchange, symbols },
      `[MarketWS] unsubscribe channel=${channel} exchange=${exchange} symbols=${symbols.join(',')}`,
    );
  }

  sendJson(
    ws,
    serializeWsAckPayload({
      requestId: message.requestId,
      action: message.action,
      channel,
      filters: {
        exchange,
        symbols,
      },
      snapshotSent: message.action === 'subscribe',
    }),
  );

  if (message.action !== 'subscribe') return;

  for (const symbol of symbols) {
    if (channel === 'orderbook') {
      const snapshot = publicMarketDataStore.getOrderbook(exchange, symbol);
      if (snapshot) {
        sendJson(ws, serializeWsOrderbookEvent(snapshot));
      }
      continue;
    }

    const trades = publicMarketDataStore.getTrades(exchange, symbol, 30);
    trades.reverse().forEach((trade) => sendJson(ws, serializeWsTradeEvent(trade)));
  }
}

async function handleCandleSubscription(
  ws: ClientSocket,
  subscriptions: Set<string>,
  message: Extract<WsMarketRequest, { channel: 'candles' }>,
) {
  const exchange = message.exchange.toLowerCase();
  const interval = message.interval ?? '1m';
  const symbols = message.symbols.map((symbol) => toUnifiedSymbol(symbol));
  const keys = symbols.map((symbol) => buildCandleKey(exchange, symbol, interval));

  if (message.action === 'subscribe') {
    const nextKeys = new Set([...subscriptions, ...keys]);
    if (nextKeys.size > MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT) {
      sendJson(
        ws,
        serializeWsErrorPayload({
          requestId: message.requestId,
          code: 'subscription_limit',
          message: `A client may subscribe to at most ${MAX_PUBLIC_SUBSCRIPTIONS_PER_CLIENT} candle markets.`,
        }),
      );
      return;
    }
    keys.forEach((key) => subscriptions.add(key));
    logger.info(
      { domain: 'market-ws', event: 'subscribe', channel: 'candles', exchange, symbols, interval },
      `[MarketWS] subscribe channel=candles exchange=${exchange} symbols=${symbols.join(',')} interval=${interval}`,
    );
  } else {
    keys.forEach((key) => subscriptions.delete(key));
    logger.info(
      { domain: 'market-ws', event: 'unsubscribe', channel: 'candles', exchange, symbols, interval },
      `[MarketWS] unsubscribe channel=candles exchange=${exchange} symbols=${symbols.join(',')} interval=${interval}`,
    );
  }

  sendJson(
    ws,
    serializeWsAckPayload({
      requestId: message.requestId,
      action: message.action,
      channel: 'candles',
      filters: {
        exchange,
        symbols,
        interval,
      },
      snapshotSent: message.action === 'subscribe',
    }),
  );

  if (message.action !== 'subscribe') return;

  for (const symbol of symbols) {
    try {
      const candle = await ensureChartLiveCandle({
        exchange: exchange as ExchangeId,
        symbol,
        interval,
      });
      if (candle) {
        sendJson(ws, serializeWsCandleEvent(candle));
      }
    } catch (error) {
      sendJson(
        ws,
        serializeWsErrorPayload({
          requestId: message.requestId,
          code: 'candle_snapshot_unavailable',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

function handleClientMessage(ws: ClientSocket, raw: RawData) {
  if (!consumeInboundBudget(ws, raw)) {
    return;
  }

  let payload: unknown;

  try {
    payload = JSON.parse(raw.toString());
  } catch {
    sendJson(
      ws,
      serializeWsErrorPayload({
        code: 'invalid_json',
        message: 'Invalid websocket JSON payload.',
      }),
    );
    return;
  }

  if (
    payload &&
    typeof payload === 'object' &&
    'channel' in payload &&
    (payload as { channel?: unknown }).channel === 'market.candle' &&
    'type' in payload &&
    ['subscribe', 'unsubscribe'].includes(String((payload as { type?: unknown }).type))
  ) {
    handleContractCandleSubscription(ws, payload as Record<string, unknown>);
    return;
  }

  const normalizedPayload = normalizeWsMarketPayload(payload);
  const parsed = wsMarketRequestSchema.safeParse(normalizedPayload);
  if (!parsed.success) {
    logger.warn(
      {
        domain: 'market-ws',
        event: 'subscribe_failed',
        reason: 'invalid_request',
        error: parsed.error.errors[0]?.message,
      },
      '[MarketWS] subscribe_failed reason=invalid_request',
    );
    sendJson(
      ws,
      serializeWsErrorPayload({
        requestId:
          typeof normalizedPayload === 'object' &&
          normalizedPayload !== null &&
          'requestId' in normalizedPayload &&
          typeof (normalizedPayload as { requestId?: unknown }).requestId === 'string'
            ? (normalizedPayload as { requestId: string }).requestId
            : undefined,
        code: 'invalid_request',
        message: parsed.error.errors[0]?.message ?? 'Invalid websocket request.',
      }),
    );
    return;
  }

  const message = parsed.data;
  if (message.action === 'ping') {
    logger.debug({ domain: 'market-ws', event: 'ping' }, '[MarketWS] ping');
    sendJson(ws, serializeWsPongPayload(message.requestId));
    return;
  }

  const subscriptions = clientSubscriptions.get(ws);
  if (!subscriptions) return;

  if (message.channel === 'tickers') {
    handleTickerSubscription(ws, subscriptions, message);
    return;
  }

  if (message.channel === 'orderbook') {
    handleKeyedSubscription(ws, subscriptions.orderbook, 'orderbook', message);
    return;
  }

  if (message.channel === 'candles') {
    void handleCandleSubscription(ws, subscriptions.candles, message);
    return;
  }

  handleKeyedSubscription(ws, subscriptions.trades, 'trades', message);
}

function normalizeWsMarketPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const candidate = payload as Record<string, unknown>;
  const channel = typeof candidate.channel === 'string' ? candidate.channel.trim().toLowerCase() : undefined;
  const normalizedChannel = channel === 'ticker' ? 'tickers' : channel;
  if (!normalizedChannel || !['tickers', 'orderbook', 'trades', 'candles'].includes(normalizedChannel)) {
    return payload;
  }

  const symbols = Array.isArray(candidate.symbols)
    ? candidate.symbols
    : [candidate.symbol, candidate.marketId].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const action = candidate.action ?? candidate.type;
  const requestId = candidate.requestId;

  if (normalizedChannel === 'tickers') {
    const exchanges = Array.isArray(candidate.exchanges)
      ? candidate.exchanges
      : typeof candidate.exchange === 'string'
        ? [candidate.exchange]
        : undefined;
    return { requestId, action, channel: normalizedChannel, exchanges, symbols };
  }

  const exchange = candidate.exchange;
  if (normalizedChannel === 'candles') {
    return {
      requestId,
      action,
      channel: normalizedChannel,
      exchange,
      symbols,
      interval: candidate.interval,
    };
  }

  return { requestId, action, channel: normalizedChannel, exchange, symbols };
}

function cleanupClient(ws: ClientSocket) {
  clientSubscriptions.delete(ws);
  ensureMarketCandlePolling();
}

function cleanupPrivateClient(ws: PrivateClientSocket) {
  const state = privateClientSubscriptions.get(ws);
  if (state?.pollTimer) {
    clearInterval(state.pollTimer);
  }
  privateClientSubscriptions.delete(ws);
}

function extractBearerToken(value?: string | string[] | null) {
  if (!value) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function resolvePrivateAuthToken(request: IncomingMessage) {
  return extractBearerToken(request.headers.authorization);
}

function toPrivateUserContext(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const candidate = payload as { id?: unknown; email?: unknown };
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) {
    return null;
  }

  return {
    userId: candidate.id,
    userEmail: typeof candidate.email === 'string' ? candidate.email : undefined,
  };
}

function getUpgradeRoute(request: IncomingMessage) {
  return new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
}

function getPrivateExchangeContext(request: IncomingMessage) {
  const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const exchanges = [
    ...parsedUrl.searchParams.getAll('exchange'),
    ...(parsedUrl.searchParams.get('exchanges')?.split(',') ?? []),
  ]
    .map((exchange) => exchange.trim().toLowerCase())
    .filter(Boolean);

  return exchanges.length > 0 ? exchanges : null;
}

function rejectPrivateUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  rejection: PrivateUpgradeRejection,
) {
  const body = JSON.stringify({
    success: false,
    error: rejection.message,
    code: rejection.code,
    details: rejection.details,
  });
  const statusTextByCode: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    503: 'Service Unavailable',
  };
  const statusText = statusTextByCode[rejection.statusCode] ?? 'Error';

  logger.warn(
    {
      domain: 'private-ws',
      event: 'websocket_upgrade_rejected',
      route: '/ws/trading',
      path: getUpgradeRoute(request),
      authResult: rejection.statusCode === 401 || rejection.code.startsWith('WS_AUTH') ? 'rejected' : 'not_applicable',
      exchangeContext: getPrivateExchangeContext(request),
      handshakeRejectReason: rejection.code,
      statusCode: rejection.statusCode,
      code: rejection.code,
      details: rejection.details,
    },
    'Private websocket upgrade rejected',
  );

  socket.write(
    `HTTP/1.1 ${rejection.statusCode} ${statusText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + `Content-Length: ${Buffer.byteLength(body)}\r\n`
      + '\r\n'
      + body,
  );
  socket.destroy();
}

function normalizePrivateSymbol(symbol?: string | null) {
  const normalized = symbol?.trim();
  return normalized ? toUnifiedSymbol(normalized) : '*';
}

function updatePrivateChannelSubscription(
  store: Map<string, Set<string>>,
  exchange: string,
  symbol: string,
  action: 'subscribe' | 'unsubscribe',
) {
  const normalizedExchange = exchange.toLowerCase();
  const entry = store.get(normalizedExchange) ?? new Set<string>();

  if (action === 'subscribe') {
    entry.add(symbol);
    store.set(normalizedExchange, entry);
    return;
  }

  entry.delete(symbol);
  if (entry.size === 0) {
    store.delete(normalizedExchange);
  } else {
    store.set(normalizedExchange, entry);
  }
}

function anyPrivateSubscriptionActive(state: PrivateSubscriptionState) {
  return state.orders.size > 0 || state.fills.size > 0 || state.portfolio.size > 0;
}

function privateSubscriptionCount(state: PrivateSubscriptionState) {
  const keyedCount = (store: Map<string, Set<string>>) =>
    Array.from(store.values()).reduce((total, symbols) => total + symbols.size, 0);
  return keyedCount(state.orders) + keyedCount(state.fills) + state.portfolio.size;
}

function setBoundedMapValue(
  map: Map<string, string>,
  key: string,
  value: string,
) {
  if (!map.has(key) && map.size >= MAX_PRIVATE_DIGEST_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey !== undefined) {
      map.delete(oldestKey);
    }
  }
  map.set(key, value);
}

function addBoundedSetValue(set: Set<string>, value: string) {
  if (!set.has(value) && set.size >= MAX_PRIVATE_DIGEST_ENTRIES) {
    const oldestValue = set.values().next().value;
    if (oldestValue !== undefined) {
      set.delete(oldestValue);
    }
  }
  set.add(value);
}

async function pollPrivateOrders(ws: PrivateClientSocket, state: PrivateSubscriptionState) {
  for (const [exchange, symbols] of state.orders.entries()) {
    const queries = symbols.has('*') || symbols.size === 0 ? [undefined] : Array.from(symbols);
    for (const symbol of queries) {
      try {
        const orders = await getOpenOrders(state.userId, exchange as ExchangeId, symbol);
        for (const order of orders) {
          const digestKey = `${exchange}:${order.orderId}`;
          const digest = JSON.stringify(order);
          if (state.orderDigests.get(digestKey) === digest) {
            continue;
          }
          setBoundedMapValue(state.orderDigests, digestKey, digest);
          sendJson(ws, {
            type: 'order',
            channel: 'orders',
            exchange,
            data: order,
          });
        }
      } catch (error) {
        logger.warn(
          {
            domain: 'private-ws',
            event: 'private_poll_failed',
            channel: 'orders',
            userId: state.userId,
            exchange,
            symbol: symbol ?? null,
            err: error,
          },
          'Private websocket orders poll failed',
        );
      }
    }
  }
}

async function pollPrivateFills(ws: PrivateClientSocket, state: PrivateSubscriptionState) {
  for (const [exchange, symbols] of state.fills.entries()) {
    const queries = symbols.has('*') || symbols.size === 0 ? [undefined] : Array.from(symbols);
    for (const symbol of queries) {
      try {
        const fills = await getRecentFills(state.userId, exchange as ExchangeId, symbol, 30);
        for (const fill of fills) {
          const fillId = `${exchange}:${fill.fillId}`;
          if (state.sentFillIds.has(fillId)) {
            continue;
          }
          addBoundedSetValue(state.sentFillIds, fillId);
          sendJson(ws, {
            type: 'fill',
            channel: 'fills',
            exchange,
            data: fill,
          });
        }
      } catch (error) {
        logger.warn(
          {
            domain: 'private-ws',
            event: 'private_poll_failed',
            channel: 'fills',
            userId: state.userId,
            exchange,
            symbol: symbol ?? null,
            err: error,
          },
          'Private websocket fills poll failed',
        );
      }
    }
  }
}

async function pollPrivatePortfolio(ws: PrivateClientSocket, state: PrivateSubscriptionState) {
  for (const exchange of state.portfolio.values()) {
    try {
      const snapshot = await getPortfolioSnapshot(state.userId, exchange as ExchangeId);
      const digest = JSON.stringify(snapshot);
      if (state.portfolioDigests.get(exchange) === digest) {
        continue;
      }
      setBoundedMapValue(state.portfolioDigests, exchange, digest);
      sendJson(ws, {
        type: 'portfolio',
        channel: 'portfolio',
        exchange,
        data: snapshot,
      });
    } catch (error) {
      logger.warn(
        {
          domain: 'private-ws',
          event: 'private_poll_failed',
          channel: 'portfolio',
          userId: state.userId,
          exchange,
          err: error,
        },
        'Private websocket portfolio poll failed',
      );
    }
  }
}

async function pollPrivateClient(ws: PrivateClientSocket) {
  const state = privateClientSubscriptions.get(ws);
  if (!state || ws.readyState !== WebSocket.OPEN || state.pollInFlight) {
    return;
  }

  state.pollInFlight = true;
  try {
    await Promise.allSettled([
      pollPrivateOrders(ws, state),
      pollPrivateFills(ws, state),
      pollPrivatePortfolio(ws, state),
    ]);
  } finally {
    state.pollInFlight = false;
  }
}

function ensurePrivatePolling(ws: PrivateClientSocket) {
  const state = privateClientSubscriptions.get(ws);
  if (!state) {
    return;
  }

  if (!anyPrivateSubscriptionActive(state)) {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    return;
  }

  if (state.pollTimer) {
    return;
  }

  void pollPrivateClient(ws);
  state.pollTimer = setInterval(() => {
    void pollPrivateClient(ws);
  }, 5_000);
  state.pollTimer.unref();
}

function handlePrivateClientMessage(ws: PrivateClientSocket, raw: RawData) {
  if (!consumeInboundBudget(ws, raw)) {
    return;
  }

  const state = privateClientSubscriptions.get(ws);
  if (!state) {
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw.toString()) as Record<string, unknown>;
  } catch {
    sendJson(ws, { type: 'error', code: 'INVALID_JSON', message: 'Invalid private websocket JSON payload.' });
    return;
  }

  const rawAction = typeof payload.action === 'string' ? payload.action.toLowerCase() : null;
  const channel = typeof payload.channel === 'string' ? payload.channel.toLowerCase() : null;
  const exchange = typeof payload.exchange === 'string' ? payload.exchange.toLowerCase() : null;
  const rawSymbol = typeof payload.symbol === 'string' ? payload.symbol : null;
  const symbol = normalizePrivateSymbol(rawSymbol);

  if (channel === 'ping' || rawAction === 'ping') {
    sendJson(ws, { type: 'pong' });
    return;
  }

  if (rawAction !== 'subscribe' && rawAction !== 'unsubscribe') {
    sendJson(ws, { type: 'error', code: 'INVALID_ACTION', message: 'action must be subscribe or unsubscribe.' });
    return;
  }
  const action = rawAction;

  if (
    !channel
    || !['orders', 'fills', 'portfolio'].includes(channel)
    || !exchange
    || (rawSymbol?.trim().length ?? 0) > 64
  ) {
    sendJson(ws, { type: 'error', code: 'INVALID_REQUEST', message: 'channel and exchange are required.' });
    return;
  }

  if (!EXCHANGE_IDS.includes(exchange as ExchangeId)) {
    sendJson(ws, {
      type: 'error',
      code: 'INVALID_EXCHANGE',
      message: 'Unsupported exchange for private websocket subscription.',
      exchange,
    });
    return;
  }

  const isAlreadySubscribed = channel === 'orders'
    ? state.orders.get(exchange)?.has(symbol) === true
    : channel === 'fills'
      ? state.fills.get(exchange)?.has(symbol) === true
      : state.portfolio.has(exchange);
  if (
    action === 'subscribe'
    && !isAlreadySubscribed
    && privateSubscriptionCount(state) >= MAX_PRIVATE_SUBSCRIPTIONS_PER_CLIENT
  ) {
    sendJson(ws, {
      type: 'error',
      code: 'SUBSCRIPTION_LIMIT',
      message: `A client may subscribe to at most ${MAX_PRIVATE_SUBSCRIPTIONS_PER_CLIENT} private streams.`,
    });
    return;
  }

  if (channel === 'orders') {
    updatePrivateChannelSubscription(state.orders, exchange, symbol, action);
  } else if (channel === 'fills') {
    updatePrivateChannelSubscription(state.fills, exchange, symbol, action);
  } else if (action === 'subscribe') {
    state.portfolio.add(exchange);
  } else {
    state.portfolio.delete(exchange);
    state.portfolioDigests.delete(exchange);
  }

  sendJson(ws, {
    type: 'ack',
    channel,
    action,
    exchange,
    symbol: symbol === '*' ? null : symbol,
    mode: 'server_side_polling',
  });

  logger.info(
    {
      domain: 'private-ws',
      event: 'private_subscription_updated',
      userId: state.userId,
      channel,
      action,
      exchange,
      symbol: symbol === '*' ? null : symbol,
      attached: action === 'subscribe',
    },
    'Private websocket subscription updated',
  );

  ensurePrivatePolling(ws);
}

async function verifyPrivateUpgradeRequest(request: IncomingMessage): Promise<PrivateUpgradeVerification> {
  if (getUpgradeRoute(request) !== '/ws/trading') {
    return null;
  }

  if (setupOptions.privateStreamingEnabled === false) {
    return {
      rejection: {
        statusCode: 503,
        code: 'LIVE_STREAM_UNAVAILABLE_POLLING_ACTIVE',
        message: 'Private trading websocket is disabled; polling fallback should remain active.',
        details: {
          status: 'live_stream_unavailable_polling_active',
          pollingFallbackRecommended: true,
        },
      },
    };
  }

  const token = resolvePrivateAuthToken(request);
  if (!token) {
    logger.warn(
      {
        domain: 'private-ws',
        event: 'websocket_upgrade_auth_missing',
        route: '/ws/trading',
        path: getUpgradeRoute(request),
        authResult: 'missing_token',
        exchangeContext: getPrivateExchangeContext(request),
        handshakeRejectReason: 'WS_AUTH_REQUIRED',
      },
      'Private websocket auth token missing',
    );
    return {
      rejection: {
        statusCode: 401,
        code: 'WS_AUTH_REQUIRED',
        message: 'Private websocket requires a bearer token in the Authorization header.',
        details: {
          status: 'auth_required',
          pollingFallbackRecommended: true,
        },
      },
    };
  }

  if (!setupOptions.verifyJwt) {
    return {
      rejection: {
        statusCode: 503,
        code: 'WS_AUTH_UNAVAILABLE',
        message: 'Private websocket auth verifier is unavailable.',
        details: {
          status: 'auth_unavailable',
          pollingFallbackRecommended: true,
        },
      },
    };
  }

  try {
    const verified = await setupOptions.verifyJwt(token);
    const context = toPrivateUserContext(verified);
    if (!context) {
      logger.warn(
        {
          domain: 'private-ws',
          event: 'websocket_upgrade_auth_invalid_payload',
          route: '/ws/trading',
          path: getUpgradeRoute(request),
          authResult: 'invalid_payload',
          exchangeContext: getPrivateExchangeContext(request),
          handshakeRejectReason: 'WS_AUTH_INVALID',
        },
        'Private websocket token payload invalid',
      );
      return {
        rejection: {
          statusCode: 401,
          code: 'WS_AUTH_INVALID',
          message: 'Private websocket token payload is invalid.',
          details: {
            status: 'auth_invalid',
            pollingFallbackRecommended: true,
          },
        },
      };
    }

    return { context };
  } catch (error) {
    logger.warn(
      {
        domain: 'private-ws',
        event: 'ws_auth_failure',
        route: '/ws/trading',
        path: getUpgradeRoute(request),
        authResult: 'verification_failed',
        exchangeContext: getPrivateExchangeContext(request),
        handshakeRejectReason: 'WS_AUTH_INVALID',
        err: error,
      },
      'Private websocket auth failed',
    );
    return {
      rejection: {
        statusCode: 401,
        code: 'WS_AUTH_INVALID',
        message: 'Private websocket token verification failed.',
        details: {
          status: 'auth_invalid',
          pollingFallbackRecommended: true,
        },
      },
    };
  }
}

function startHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    const servers = [wss, privateWss].filter((server): server is WebSocketServer => Boolean(server));
    for (const server of servers) {
      server.clients.forEach((socket) => {
        const ws = socket as ClientSocket;
        if (ws.isAlive === false) {
          cleanupClient(ws);
          cleanupPrivateClient(ws as PrivateClientSocket);
          logger.warn({ domain: 'websocket', event: 'heartbeat_timeout' }, 'Websocket heartbeat timeout');
          ws.close(1001, 'heartbeat_timeout');
          setTimeout(() => ws.terminate(), 500).unref();
          return;
        }

        ws.isAlive = false;
        logger.debug({ domain: 'websocket', event: 'ping' }, 'Websocket heartbeat ping');
        ws.ping();
      });
    }
  }, 30_000);
  heartbeatInterval.unref();
}

marketEventBus.onTicker(publishTicker);
marketEventBus.onOrderbook(publishOrderbook);
marketEventBus.onTrade(publishTrade);
marketEventBus.onCandle(publishCandle);

export function setupWebSocket(server: HttpServer, options: SetupWebSocketOptions = {}) {
  if (wss) {
    return wss;
  }

  attachedServer = server;
  setupOptions = options;
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  privateWss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  wss.on('connection', (socket) => {
    const ws = socket as ClientSocket;
    ws.isAlive = true;
    ws.messageWindowStartedAt = Date.now();
    ws.messageCountInWindow = 0;
    clientSubscriptions.set(ws, createSubscriptionState());

    logger.info({ domain: 'public-market', transport: 'ws' }, 'Public market websocket client connected');
    logger.info({ domain: 'market-ws', event: 'client_connected' }, '[MarketWS] client_connected');

    sendJson(ws, serializeWsWelcomePayload());

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => handleClientMessage(ws, raw));
    ws.on('close', () => {
      cleanupClient(ws);
      logger.info({ domain: 'public-market', transport: 'ws' }, 'Public market websocket client disconnected');
    });
    ws.on('error', (err) => {
      logger.warn({ domain: 'public-market', transport: 'ws', err }, 'Public market websocket error');
    });
  });

  privateWss.on('connection', (socket: WebSocket, request: IncomingMessage, context: PrivateUserContext) => {
    const ws = socket as PrivateClientSocket;
    ws.isAlive = true;
    ws.messageWindowStartedAt = Date.now();
    ws.messageCountInWindow = 0;
    ws.userId = context.userId;
    ws.userEmail = context.userEmail;
    privateClientSubscriptions.set(ws, createPrivateSubscriptionState(context.userId));

    logger.info(
      {
        domain: 'private-ws',
        event: 'websocket_upgrade_accepted',
        route: '/ws/trading',
        path: getUpgradeRoute(request),
        authResult: 'accepted',
        exchangeContext: getPrivateExchangeContext(request),
        handshakeRejectReason: null,
        userId: context.userId,
      },
      'Private websocket upgrade accepted',
    );

    sendJson(ws, {
      type: 'subscribed',
      channel: 'private',
      path: '/ws/trading',
      mode: 'server_side_polling',
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', (raw) => handlePrivateClientMessage(ws, raw));
    ws.on('close', () => {
      cleanupPrivateClient(ws);
      logger.info({ domain: 'private-ws', userId: context.userId }, 'Private websocket client disconnected');
    });
    ws.on('error', (err) => {
      logger.warn({ domain: 'private-ws', userId: context.userId, err }, 'Private websocket error');
    });
  });

  privateUpgradeListener = (request, socket, head) => {
    void (async () => {
      const route = getUpgradeRoute(request);
      if (route === '/ws/market') {
        logger.info(
          { domain: 'market-ws', event: 'websocket_upgrade', route, path: route },
          '[MarketWS] websocket_upgrade route=/ws/market',
        );
        wss?.handleUpgrade(request, socket, head, (ws) => {
          wss?.emit('connection', ws, request);
        });
        return;
      }

      if (route !== '/ws/trading') {
        const body = JSON.stringify({
          success: false,
          error: 'WebSocket route not found.',
          code: 'route_not_found',
          details: { route },
        });
        logger.warn(
          {
            domain: 'websocket',
            event: 'websocket_upgrade_unknown_route',
            route,
            path: route,
            handshakeRejectReason: 'route_not_found',
          },
          'Websocket upgrade route not found',
        );
        socket.write(
          'HTTP/1.1 404 Not Found\r\n'
            + 'Connection: close\r\n'
            + 'Content-Type: application/json; charset=utf-8\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\n`
            + '\r\n'
            + body,
        );
        socket.destroy();
        return;
      }

      const verification = await verifyPrivateUpgradeRequest(request);
      if (!verification) {
        return;
      }

      if (verification.rejection) {
        rejectPrivateUpgrade(request, socket, verification.rejection);
        return;
      }

      privateWss?.handleUpgrade(request, socket, head, (ws) => {
        privateWss?.emit('connection', ws, request, verification.context);
      });
    })().catch((error) => {
      logger.error(
        { domain: 'private-ws', event: 'websocket_upgrade_failed', path: getUpgradeRoute(request), err: error },
        'Private websocket upgrade failed unexpectedly',
      );
      rejectPrivateUpgrade(request, socket, {
        statusCode: 503,
        code: 'WS_UPGRADE_FAILED',
        message: 'Private websocket upgrade failed unexpectedly.',
        details: {
          status: 'upgrade_failed',
          pollingFallbackRecommended: true,
        },
      });
    });
  };
  server.on('upgrade', privateUpgradeListener);

  startHeartbeat();
  logger.info({ domain: 'public-market', path: '/ws/market' }, 'Unified public market websocket server started');
  logger.info({ domain: 'private-ws', path: '/ws/trading' }, 'Private trading websocket server started');

  return wss;
}

export function getWss(): WebSocketServer | null {
  return wss;
}

function closeSocketGracefully(ws: WebSocket, reason: string) {
  try {
    ws.close(1012, reason.slice(0, 120));
  } catch {
    ws.terminate();
    return;
  }
  setTimeout(() => ws.terminate(), 500).unref();
}

function closeServerInstance(server: WebSocketServer | null, reason: string) {
  return new Promise<void>((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.clients.forEach((client) => closeSocketGracefully(client, reason));
    server.close(() => resolve());
  });
}

export async function closeWebSocketServer(reason = 'server_shutdown') {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  clientSubscriptions.clear();
  if (marketCandlePollInterval) {
    clearInterval(marketCandlePollInterval);
    marketCandlePollInterval = null;
  }
  for (const [ws] of privateClientSubscriptions.entries()) {
    cleanupPrivateClient(ws);
  }

  if (attachedServer && privateUpgradeListener) {
    attachedServer.off('upgrade', privateUpgradeListener);
  }
  privateUpgradeListener = null;
  attachedServer = null;

  await Promise.all([
    closeServerInstance(wss, reason),
    closeServerInstance(privateWss, reason),
  ]);
  wss = null;
  privateWss = null;
}
