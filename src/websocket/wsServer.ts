import { Server as HttpServer } from 'http';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import type { ExchangeId } from '../core/exchange/exchange.types';
import { ensureChartLiveCandle } from '../domains/charts/chart.service';
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
    active: boolean;
    exchanges: Set<string>;
    symbols: Set<string>;
  };
  orderbook: Set<string>;
  trades: Set<string>;
  candles: Set<string>;
}

interface ClientSocket extends WebSocket {
  isAlive?: boolean;
}

let wss: WebSocketServer | null = null;
const clientSubscriptions = new Map<ClientSocket, ClientSubscriptionState>();
let heartbeatInterval: NodeJS.Timeout | null = null;

function sendJson(ws: WebSocket, payload: unknown) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function buildKey(exchange: string, symbol: string) {
  return `${exchange}:${toUnifiedSymbol(symbol)}`;
}

function buildCandleKey(exchange: string, symbol: string, interval: string) {
  return `${exchange}:${toUnifiedSymbol(symbol)}:${interval}`;
}

function createSubscriptionState(): ClientSubscriptionState {
  return {
    tickers: {
      active: false,
      exchanges: new Set<string>(),
      symbols: new Set<string>(),
    },
    orderbook: new Set<string>(),
    trades: new Set<string>(),
    candles: new Set<string>(),
  };
}

function matchesTicker(subscriptions: ClientSubscriptionState, ticker: NormalizedMarketTicker) {
  if (!subscriptions.tickers.active) {
    return false;
  }

  const exchangeMatch =
    subscriptions.tickers.exchanges.size === 0 || subscriptions.tickers.exchanges.has(ticker.exchange);
  const symbolMatch =
    subscriptions.tickers.symbols.size === 0 || subscriptions.tickers.symbols.has(ticker.symbol);

  return exchangeMatch && symbolMatch;
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

function handleTickerSubscription(
  ws: ClientSocket,
  subscriptions: ClientSubscriptionState,
  message: Extract<WsMarketRequest, { channel: 'tickers' }>,
) {
  const exchanges = (message.exchanges ?? []).map((exchange) => exchange.toLowerCase());
  const symbols = (message.symbols ?? []).map((symbol) => toUnifiedSymbol(symbol));

  if (message.action === 'subscribe') {
    subscriptions.tickers.active = true;
    exchanges.forEach((exchange) => subscriptions.tickers.exchanges.add(exchange));
    symbols.forEach((symbol) => subscriptions.tickers.symbols.add(symbol));
  } else if (exchanges.length === 0 && symbols.length === 0) {
    subscriptions.tickers.active = false;
    subscriptions.tickers.exchanges.clear();
    subscriptions.tickers.symbols.clear();
  } else {
    exchanges.forEach((exchange) => subscriptions.tickers.exchanges.delete(exchange));
    symbols.forEach((symbol) => subscriptions.tickers.symbols.delete(symbol));
    if (
      subscriptions.tickers.exchanges.size === 0 &&
      subscriptions.tickers.symbols.size === 0
    ) {
      subscriptions.tickers.active = false;
    }
  }

  sendJson(
    ws,
    serializeWsAckPayload({
      requestId: message.requestId,
      action: message.action,
      channel: 'tickers',
      filters: {
        active: subscriptions.tickers.active,
        exchanges: Array.from(subscriptions.tickers.exchanges),
        symbols: Array.from(subscriptions.tickers.symbols),
      },
      snapshotSent: message.action === 'subscribe',
    }),
  );

  if (message.action !== 'subscribe') return;

  const snapshots = publicMarketDataStore
    .getTickers()
    .filter((ticker) => matchesTicker(subscriptions, ticker));

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
    keys.forEach((key) => subscriptions.add(key));
  } else {
    keys.forEach((key) => subscriptions.delete(key));
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
    keys.forEach((key) => subscriptions.add(key));
  } else {
    keys.forEach((key) => subscriptions.delete(key));
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

  const parsed = wsMarketRequestSchema.safeParse(payload);
  if (!parsed.success) {
    sendJson(
      ws,
      serializeWsErrorPayload({
        requestId:
          typeof payload === 'object' &&
          payload !== null &&
          'requestId' in payload &&
          typeof (payload as { requestId?: unknown }).requestId === 'string'
            ? (payload as { requestId: string }).requestId
            : undefined,
        code: 'invalid_request',
        message: parsed.error.errors[0]?.message ?? 'Invalid websocket request.',
      }),
    );
    return;
  }

  const message = parsed.data;
  if (message.action === 'ping') {
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

function cleanupClient(ws: ClientSocket) {
  clientSubscriptions.delete(ws);
}

function startHeartbeat() {
  if (heartbeatInterval) return;

  heartbeatInterval = setInterval(() => {
    if (!wss) return;

    wss.clients.forEach((socket) => {
      const ws = socket as ClientSocket;
      if (ws.isAlive === false) {
        cleanupClient(ws);
        ws.terminate();
        return;
      }

      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);
}

marketEventBus.onTicker(publishTicker);
marketEventBus.onOrderbook(publishOrderbook);
marketEventBus.onTrade(publishTrade);
marketEventBus.onCandle(publishCandle);

export function setupWebSocket(server: HttpServer) {
  if (wss) {
    return wss;
  }

  wss = new WebSocketServer({ server, path: '/ws/market' });

  wss.on('connection', (socket) => {
    const ws = socket as ClientSocket;
    ws.isAlive = true;
    clientSubscriptions.set(ws, createSubscriptionState());

    logger.info({ domain: 'public-market', transport: 'ws' }, 'Public market websocket client connected');

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

  startHeartbeat();
  logger.info({ domain: 'public-market', path: '/ws/market' }, 'Unified public market websocket server started');

  return wss;
}

export function getWss(): WebSocketServer | null {
  return wss;
}

export function closeWebSocketServer() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  clientSubscriptions.clear();

  if (!wss) return;

  wss.clients.forEach((client) => client.terminate());
  wss.close();
  wss = null;
}
