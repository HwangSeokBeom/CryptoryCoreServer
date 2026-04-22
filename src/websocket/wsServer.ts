import { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { EXCHANGE_IDS, type ExchangeId } from '../core/exchange/exchange.types';
import { ensureChartLiveCandle } from '../domains/charts/chart.service';
import { getPortfolioSnapshot } from '../domains/portfolio/portfolio.service';
import { getOpenOrders, getRecentFills } from '../domains/trading/trading.service';
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

function createPrivateSubscriptionState(userId: string): PrivateSubscriptionState {
  return {
    userId,
    orders: new Map<string, Set<string>>(),
    fills: new Map<string, Set<string>>(),
    portfolio: new Set<string>(),
    pollTimer: null,
    orderDigests: new Map<string, string>(),
    portfolioDigests: new Map<string, string>(),
    sentFillIds: new Set<string>(),
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
  return match?.[1]?.trim() ?? raw.trim() ?? null;
}

function parseCookieHeader(header?: string) {
  if (!header) return new Map<string, string>();
  return new Map(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separatorIndex = part.indexOf('=');
        if (separatorIndex === -1) {
          return [part, ''] as const;
        }
        return [part.slice(0, separatorIndex), decodeURIComponent(part.slice(separatorIndex + 1))] as const;
      }),
  );
}

function resolvePrivateAuthToken(request: IncomingMessage) {
  const parsedUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  const cookies = parseCookieHeader(typeof request.headers.cookie === 'string' ? request.headers.cookie : undefined);
  return extractBearerToken(request.headers.authorization)
    ?? parsedUrl.searchParams.get('token')
    ?? parsedUrl.searchParams.get('accessToken')
    ?? parsedUrl.searchParams.get('authorization')
    ?? cookies.get('accessToken')
    ?? cookies.get('authToken')
    ?? null;
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
      path: request.url,
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
          state.orderDigests.set(digestKey, digest);
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
          state.sentFillIds.add(fillId);
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
      state.portfolioDigests.set(exchange, digest);
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
  if (!state || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  await Promise.allSettled([
    pollPrivateOrders(ws, state),
    pollPrivateFills(ws, state),
    pollPrivatePortfolio(ws, state),
  ]);
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
}

function handlePrivateClientMessage(ws: PrivateClientSocket, raw: RawData) {
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
  const symbol = normalizePrivateSymbol(typeof payload.symbol === 'string' ? payload.symbol : null);

  if (channel === 'ping' || rawAction === 'ping') {
    sendJson(ws, { type: 'pong' });
    return;
  }

  const action = rawAction === 'unsubscribe' ? 'unsubscribe' : 'subscribe';

  if (!channel || !['orders', 'fills', 'portfolio'].includes(channel) || !exchange) {
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
        path: request.url,
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
        message: 'Private websocket requires a bearer token in Authorization header, query, or cookie.',
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
          path: request.url,
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
        path: request.url,
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
          ws.close(1001, 'heartbeat_timeout');
          setTimeout(() => ws.terminate(), 500).unref();
          return;
        }

        ws.isAlive = false;
        ws.ping();
      });
    }
  }, 30_000);
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
  wss = new WebSocketServer({ noServer: true });
  privateWss = new WebSocketServer({ noServer: true });

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

  privateWss.on('connection', (socket: WebSocket, request: IncomingMessage, context: PrivateUserContext) => {
    const ws = socket as PrivateClientSocket;
    ws.isAlive = true;
    ws.userId = context.userId;
    ws.userEmail = context.userEmail;
    privateClientSubscriptions.set(ws, createPrivateSubscriptionState(context.userId));

    logger.info(
      {
        domain: 'private-ws',
        event: 'websocket_upgrade_accepted',
        route: '/ws/trading',
        path: request.url,
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
            path: request.url,
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
      logger.error({ domain: 'private-ws', event: 'websocket_upgrade_failed', path: request.url, err: error }, 'Private websocket upgrade failed unexpectedly');
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
