import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { KorbitHmacSigner } from '../../core/exchange/auth/korbit.signer';
import { ExchangeAuthError } from '../../core/exchange/errors';
import type {
  AssetHistoryRecord,
  Balance,
  CancelOrderRequest,
  CanonicalCandle,
  CanonicalFill,
  CanonicalOrder,
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  CreateOrderRequest,
  PortfolioSnapshot,
  StreamSubscription,
} from '../../core/exchange/exchange.types';
import type {
  ExchangeMarketDataProvider,
  ExchangePortfolioProvider,
  ExchangeStreamingProvider,
  ExchangeTradingProvider,
  MarketStreamSink,
  ProviderContext,
} from '../../core/exchange/provider.interfaces';
import { ExchangeRequestError } from '../../core/exchange/errors';
import { toCanonicalMarket, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager } from '../../core/exchange/websocket.client-manager';
import { KorbitAdapter } from '../../exchanges/KorbitAdapter';
import { logger } from '../../utils/logger';
import { BaseExchangeProvider } from './base-exchange.provider';
import { buildPortfolioSnapshot, normalizeOrderStatus, normalizeOrderType, safeNumber, safeString, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class KorbitProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new KorbitAdapter();
  private readonly signer = new KorbitHmacSigner();
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];
  private recentTradesSuppressedUntil = 0;
  private recentTradesFailureCount = 0;
  private recentTradesLastFailure: string | null = null;

  constructor() {
    super('korbit');
  }

  async listMarkets() {
    return DEFAULT_SYMBOLS.map((symbol) => ({
      symbol,
      market: `${symbol}/KRW`,
      rawSymbol: `${symbol.toLowerCase()}_krw`,
    }));
  }

  async getTickerSnapshot(symbols = DEFAULT_SYMBOLS): Promise<CanonicalTickerSnapshot[]> {
    const tickers = await this.adapter.fetchTickers(symbols.map(toCanonicalSymbol));
    return tickers.map((ticker) => ({
      ...toCanonicalMarket(this.exchange, ticker.symbol),
      price: ticker.price,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      high24h: ticker.high24h,
      low24h: ticker.low24h,
      timestamp: ticker.timestamp,
    }));
  }

  async getOrderbookSnapshot(symbol: string, depth = 15): Promise<CanonicalOrderbookSnapshot> {
    const canonical = toCanonicalSymbol(symbol);
    const snapshot = await this.adapter.fetchOrderbook(canonical, depth);
    const market = toCanonicalMarket(this.exchange, canonical);
    const asks = sortAsks(snapshot.asks.map((level) => ({ price: level.price, quantity: level.qty })), depth);
    const bids = sortBids(snapshot.bids.map((level) => ({ price: level.price, quantity: level.qty })), depth);

    return {
      ...market,
      asks,
      bids,
      bestAsk: asks[0]?.price ?? 0,
      bestBid: bids[0]?.price ?? 0,
      spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
      timestamp: Date.now(),
    };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<CanonicalTrade[]> {
    const canonical = toCanonicalSymbol(symbol);
    const pair = `${canonical.toLowerCase()}_krw`;
    if (Date.now() < this.recentTradesSuppressedUntil) {
      logger.debug(
        {
          domain: 'market-streaming',
          exchange: this.exchange,
          symbol: canonical,
          capability: 'trades',
          suppressedUntil: this.recentTradesSuppressedUntil,
          reason: this.recentTradesLastFailure,
        },
        'Korbit recent trades polling suppressed',
      );
      return [];
    }

    const market = toCanonicalMarket(this.exchange, canonical);
    try {
      const response = await this.restClient.request<any>('/v2/trades', {
        query: {
          symbol: pair,
          limit,
        },
      });
      const trades = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : [];
      this.recentTradesSuppressedUntil = 0;
      this.recentTradesFailureCount = 0;
      this.recentTradesLastFailure = null;

      return trades.map((trade: any) => {
        const price = safeNumber(trade.price);
        const quantity = safeNumber(trade.qty ?? trade.amount);
        return {
          ...market,
          tradeId: String(trade.tradeId ?? trade.id ?? `${pair}:${trade.timestamp}`),
          side:
            typeof trade.isBuyerTaker === 'boolean'
              ? trade.isBuyerTaker ? 'buy' : 'sell'
              : String(trade.taker ?? trade.side ?? '').toLowerCase() === 'buy'
                ? 'buy'
                : 'sell',
          price,
          quantity,
          notional: price * quantity,
          timestamp: safeNumber(trade.timestamp ?? Date.now()),
        };
      });
    } catch (error) {
      const classification = this.classifyRecentTradesError(error, canonical, pair);
      if (classification) {
        this.recentTradesFailureCount += 1;
        this.recentTradesLastFailure = classification.reason;
        this.recentTradesSuppressedUntil = Date.now() + classification.suppressMs;
        logger.warn(
          {
            domain: 'market-streaming',
            exchange: this.exchange,
            symbol: canonical,
            endpoint: '/v2/trades',
            capability: 'trades',
            upstreamStatus: classification.statusCode,
            retry: false,
            suppressMs: classification.suppressMs,
            reason: classification.reason,
          },
          'Korbit recent trades degraded',
        );
      }

      throw error;
    }
  }

  async getCandles(symbol: string, interval: string, limit = 60): Promise<CanonicalCandle[]> {
    const canonical = toCanonicalSymbol(symbol);
    const candles = await this.adapter.fetchCandles(canonical, interval, limit);
    const market = toCanonicalMarket(this.exchange, canonical);

    return candles.map((candle, index) => ({
      ...market,
      interval,
      openTime: safeNumber(candle.time) || Date.now() - (limit - index) * 60_000,
      closeTime: safeNumber(candle.time) || Date.now() - (limit - index - 1) * 60_000,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }

  async startPublicStream(subscriptions: StreamSubscription[], sink: MarketStreamSink) {
    this.activeSubscriptions = subscriptions;
    const symbols = Array.from(
      new Set(
        subscriptions
          .filter((subscription) => subscription.exchange === this.exchange)
          .flatMap((subscription) => subscription.symbols.map(toCanonicalSymbol)),
      ),
    );
    if (symbols.length === 0) return;

    this.streamManager = new WebSocketClientManager({
      name: 'korbit-public',
      url: getExchangeConfig(this.exchange).publicWebSocketUrl,
      onOpen: async (ctx) => {
        const socketSymbols = symbols.map((symbol) => `${symbol.toLowerCase()}_krw`);
        ctx.sendJson([
          { method: 'subscribe', type: 'ticker', symbols: socketSymbols },
          { method: 'subscribe', type: 'orderbook', symbols: socketSymbols },
          { method: 'subscribe', type: 'trade', symbols: socketSymbols },
        ]);
      },
      onMessage: async (raw) => {
        const payload = JSON.parse(raw.toString());
        const type = String(payload.type ?? '');
        const symbol = toCanonicalSymbol(String(payload.symbol ?? '').replace('_krw', ''));
        const market = toCanonicalMarket(this.exchange, symbol);
        const timestamp = safeNumber(payload.timestamp ?? payload.data?.timestamp ?? Date.now());

        if (type === 'ticker' && sink.onTicker) {
          const data = payload.data ?? {};
          await sink.onTicker({
            ...market,
            price: safeNumber(data.close),
            change24h: safeNumber(data.priceChangePercent),
            volume24h: safeNumber(data.quoteVolume),
            high24h: safeNumber(data.high),
            low24h: safeNumber(data.low),
            timestamp: safeNumber(data.lastTradedAt ?? timestamp),
          });
          return;
        }

        if (type === 'orderbook' && sink.onOrderbook) {
          const data = payload.data ?? {};
          const asks = sortAsks(
            (data.asks ?? []).map((ask: any) => ({
              price: safeNumber(ask.price ?? ask[0]),
              quantity: safeNumber(ask.qty ?? ask.amount ?? ask[1]),
            })),
          );
          const bids = sortBids(
            (data.bids ?? []).map((bid: any) => ({
              price: safeNumber(bid.price ?? bid[0]),
              quantity: safeNumber(bid.qty ?? bid.amount ?? bid[1]),
            })),
          );

          await sink.onOrderbook({
            ...market,
            asks,
            bids,
            bestAsk: asks[0]?.price ?? 0,
            bestBid: bids[0]?.price ?? 0,
            spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
            timestamp: safeNumber(data.timestamp ?? timestamp),
          });
          return;
        }

        if (type === 'trade' && sink.onTrade) {
          const trades = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.data?.trades) ? payload.data.trades : [payload.data];
          for (const trade of trades) {
            const price = safeNumber(trade.price);
            const quantity = safeNumber(trade.amount ?? trade.qty);
            await sink.onTrade({
              ...market,
              tradeId: String(trade.id ?? trade.tradeId ?? `${symbol}:${timestamp}`),
              side: String(trade.takerSide ?? trade.side ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
              price,
              quantity,
              notional: price * quantity,
              timestamp: safeNumber(trade.timestamp ?? timestamp),
            });
          }
        }
      },
      onReconnect: async () => {
        await this.resyncSnapshots(sink, symbols);
      },
    });

    await this.streamManager.start();
    await this.resyncSnapshots(sink, symbols);
  }

  async stopPublicStream() {
    await this.streamManager?.stop();
    this.streamManager = null;
  }

  async createOrder(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const symbol = this.requireSymbol(request.symbol, 'create order');
    const payload: Record<string, unknown> = {
      symbol,
      side: request.side,
      orderType: request.type === 'limit' ? 'limit' : 'market',
      timeInForce: request.type === 'limit' ? 'gtc' : 'ioc',
    };

    if (request.type === 'limit') {
      payload.price = String(request.price ?? 0);
      payload.qty = String(request.quantity);
    } else if (request.side === 'buy') {
      payload.amt = String(await this.resolveMarketBuyAmount(request));
    } else {
      payload.qty = String(request.quantity);
    }

    if (request.clientOrderId) {
      payload.clientOrderId = request.clientOrderId;
    }

    const response = await this.requestPrivate<{ orderId: number }>('/v2/orders', 'POST', context, payload);
    return this.getOrder(String(response.orderId), request.symbol, context);
  }

  async cancelOrder(request: CancelOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const symbol = this.requireSymbol(request.symbol, 'cancel order');
    await this.requestPrivate('/v2/orders', 'DELETE', context, {
      symbol,
      orderId: request.orderId,
    });
    return this.getOrder(request.orderId, request.symbol, context);
  }

  async getOrder(orderId: string, symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder> {
    const resolvedSymbol = this.requireSymbol(symbol, 'get order');
    const response = await this.requestPrivate<any>('/v2/orders', 'GET', context, {
      symbol: resolvedSymbol,
      orderId,
    });
    return this.mapOrder(response, symbol);
  }

  async listOpenOrders(symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder[]> {
    if (symbol) {
      const response = await this.requestPrivate<any[]>('/v2/openOrders', 'GET', context, {
        symbol: this.requireSymbol(symbol, 'list open orders'),
        limit: 100,
      });
      return response.map((order) => this.mapOrder(order, symbol));
    }

    const results = await Promise.all(
      DEFAULT_SYMBOLS.map(async (item) => {
        try {
          return await this.listOpenOrders(item, context);
        } catch {
          return [];
        }
      }),
    );
    return results.flat();
  }

  async listFills(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<CanonicalFill[]> {
    if (symbol) {
      const response = await this.requestPrivate<any[]>('/v2/myTrades', 'GET', context, {
        symbol: this.requireSymbol(symbol, 'list fills'),
        startTime: Date.now() - 36 * 60 * 60 * 1000,
        endTime: Date.now(),
        limit: Math.min(limit ?? 50, 1000),
      });
      return response.map((fill) => {
        const market = toCanonicalMarket(this.exchange, symbol);
        return {
          exchange: this.exchange,
          fillId: safeString(fill.tradeId),
          orderId: safeString(fill.orderId),
          symbol: market.symbol,
          market: market.market,
          side: safeString(fill.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
          price: safeNumber(fill.price),
          quantity: safeNumber(fill.qty),
          fee: safeNumber(fill.feeQty),
          feeCurrency: safeString(fill.feeCurrency || market.quoteCurrency),
          timestamp: safeNumber(fill.tradedAt),
        };
      });
    }

    const results = await Promise.all(
      DEFAULT_SYMBOLS.map(async (item) => {
        try {
          return await this.listFills(item, limit, context);
        } catch {
          return [];
        }
      }),
    );
    return results.flat().sort((left, right) => right.timestamp - left.timestamp).slice(0, limit ?? 50);
  }

  async getPortfolioSnapshot(context: ProviderContext): Promise<PortfolioSnapshot> {
    const response = await this.requestPrivate<any[]>('/v2/balance', 'GET', context);
    const balances: Balance[] = response.map((balance) => ({
      asset: safeString(balance.currency).toUpperCase(),
      free: safeNumber(balance.available),
      locked: safeNumber(balance.tradeInUse) + safeNumber(balance.withdrawalInUse),
      averageBuyPrice: safeNumber(balance.avgPrice),
    }));

    return buildPortfolioSnapshot({
      exchange: this.exchange,
      balances,
      resolvePrices: async (symbols) => {
        const tickers = symbols.length > 0 ? await this.getTickerSnapshot(symbols) : [];
        return new Map(tickers.map((ticker) => [ticker.symbol, ticker.price]));
      },
    });
  }

  async getAssetHistory(
    symbol: string | undefined,
    limit: number | undefined,
    context: ProviderContext,
  ): Promise<AssetHistoryRecord[]> {
    const fills = await this.listFills(symbol, limit, context);
    return fills.map((fill) => ({
      exchange: this.exchange,
      symbol: fill.symbol,
      type: 'trade',
      amount: fill.side === 'buy' ? fill.quantity : -fill.quantity,
      timestamp: fill.timestamp,
      description: `${fill.side.toUpperCase()} ${fill.quantity} @ ${fill.price}`,
    }));
  }

  private async resyncSnapshots(sink: MarketStreamSink, symbols: string[]) {
    if (sink.onReconnect) {
      for (const subscription of this.activeSubscriptions.filter((item) => item.exchange === this.exchange)) {
        try {
          await sink.onReconnect(subscription);
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, capability: 'reconnect', err: error },
            'Korbit reconnect notification failed',
          );
        }
      }
    }
    if (sink.onTicker) {
      try {
        const tickers = await this.getTickerSnapshot(symbols);
        for (const ticker of tickers) {
          try {
            await sink.onTicker(ticker);
          } catch (error) {
            logger.warn(
              {
                domain: 'market-streaming',
                exchange: this.exchange,
                symbol: ticker.symbol,
                capability: 'ticker',
                err: error,
              },
              'Korbit ticker resync sink failed',
            );
          }
        }
      } catch (error) {
        logger.warn(
          { domain: 'market-streaming', exchange: this.exchange, capability: 'ticker', err: error },
          'Korbit ticker resync failed',
        );
      }
    }
    if (sink.onOrderbook) {
      for (const symbol of symbols) {
        try {
          await sink.onOrderbook(await this.getOrderbookSnapshot(symbol));
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, symbol, capability: 'orderbook', err: error },
            'Korbit orderbook resync failed',
          );
        }
      }
    }
    if (sink.onTrade) {
      for (const symbol of symbols) {
        try {
          const trades = await this.getRecentTrades(symbol, 20);
          for (const trade of trades.reverse()) {
            try {
              await sink.onTrade(trade);
            } catch (error) {
              logger.warn(
                {
                  domain: 'market-streaming',
                  exchange: this.exchange,
                  symbol,
                  capability: 'trades',
                  err: error,
                },
                'Korbit trade resync sink failed',
              );
            }
          }
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, symbol, capability: 'trades', err: error },
            'Korbit trade resync failed',
          );
        }
      }
    }
  }

  private classifyRecentTradesError(error: unknown, symbol: string, pair: string) {
    if (!(error instanceof ExchangeRequestError)) {
      return null;
    }

    const body = safeString(error.responseBody).replace(/\s+/g, ' ').trim();
    const snippet = body.length > 220 ? `${body.slice(0, 220)}...` : body;
    const cloudflareBlocked = error.statusCode === 403 && /cloudflare|attention required|access denied/i.test(body);
    const unsupported = error.statusCode === 400 || error.statusCode === 404;
    const malformed = /html|<!doctype/i.test(body);

    if (!cloudflareBlocked && !unsupported && !malformed) {
      return null;
    }

    const suppressMs = cloudflareBlocked ? 5 * 60_000 : unsupported ? 2 * 60_000 : 60_000;
    const reason = `Korbit trades unavailable for ${symbol} (${pair}) via /v2/trades: HTTP ${error.statusCode}${snippet ? ` body=${snippet}` : ''}`;
    return {
      statusCode: error.statusCode,
      suppressMs,
      reason,
    };
  }

  private async requestPrivate<T>(
    path: string,
    method: 'GET' | 'POST' | 'DELETE',
    context: ProviderContext,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const credentials = this.requireCredentials(context);
    const signed = this.signer.createSignedRequest({
      apiKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      payload,
    });
    const signedPayload = { ...signed.payload, signature: signed.signature };
    const response = await this.restClient.request<{
      success?: boolean;
      data?: T;
      error?: { message?: string };
      message?: string;
      code?: string;
    }>(path, {
      method,
      headers: signed.headers,
      ...(method === 'POST'
        ? { form: signedPayload }
        : { query: signedPayload as Record<string, string | number | boolean | undefined> }),
    });

    if (response.success === false) {
      throw new ExchangeAuthError(
        this.exchange,
        safeString(response.error?.message ?? response.message ?? response.code) || 'Korbit request failed',
      );
    }

    return (response.data ?? (response as unknown)) as T;
  }

  private requireCredentials(context: ProviderContext) {
    if (!context.credentials) {
      throw new ExchangeAuthError(this.exchange, 'Korbit credentials are required');
    }

    return context.credentials;
  }

  private requireSymbol(symbol: string | undefined, action: string) {
    if (!symbol) {
      throw new ExchangeAuthError(this.exchange, `Korbit ${action} requires symbol`);
    }

    return `${toCanonicalSymbol(symbol).toLowerCase()}_krw`;
  }

  private async resolveMarketBuyAmount(request: CreateOrderRequest) {
    if (request.price && request.price > 0) {
      return request.price;
    }

    const [ticker] = await this.getTickerSnapshot([request.symbol]);
    return Math.max((ticker?.price ?? 0) * request.quantity, 0);
  }

  private mapOrder(order: any, symbol?: string): CanonicalOrder {
    const market = toCanonicalMarket(this.exchange, symbol ?? safeString(order.symbol).replace(/_krw$/i, ''));
    const quantity = safeNumber(order.qty);
    const filledQuantity = safeNumber(order.filledQty);
    const remainingQuantity = Math.max(quantity - filledQuantity, 0);
    return {
      exchange: this.exchange,
      orderId: safeString(order.orderId),
      symbol: market.symbol,
      market: market.market,
      side: safeString(order.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: normalizeOrderType(order.orderType),
      status: normalizeOrderStatus({
        state: order.status,
        quantity,
        filledQuantity,
        remainingQuantity,
        openStates: ['open', 'pending'],
        cancelledStates: ['canceled', 'partiallyfilledcanceled'],
        filledStates: ['filled'],
        rejectedStates: ['expired'],
      }),
      price: safeNumber(order.price ?? order.avgPrice),
      quantity,
      filledQuantity,
      remainingQuantity,
      averageFillPrice: safeNumber(order.avgPrice),
      createdAt: safeNumber(order.createdAt),
      updatedAt: safeNumber(order.lastFilledAt ?? order.createdAt),
    };
  }
}
