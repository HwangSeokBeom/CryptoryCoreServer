import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { CoinoneSigner } from '../../core/exchange/auth/coinone.signer';
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
  ExchangeMarketDescriptor,
  MarketCapabilitySnapshot,
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
import { buildStreamSubscriptionPlan } from '../../core/exchange/stream-subscription.plan';
import { toCanonicalMarket, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager, type WebSocketReconnectMetadata } from '../../core/exchange/websocket.client-manager';
import { CoinoneAdapter } from '../../exchanges/CoinoneAdapter';
import { parseCoinoneMarketsResponse } from './coinone.mapper';
import { BaseExchangeProvider } from './base-exchange.provider';
import { logger } from '../../utils/logger';
import {
  buildPortfolioSnapshot,
  normalizeExchangeTimestampFromCandidates,
  normalizeOrderStatus,
  normalizeOrderType,
  safeNumber,
  safeString,
  sortAsks,
  sortBids,
  toHistoricalCandleWindow,
  toIsoTimestamp,
} from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);
const MARKET_CACHE_TTL_MS = 60_000;
const MARKET_STALE_TTL_MS = 5 * 60_000;
const TICKER_CACHE_TTL_MS = 1_000;
const TICKER_STALE_TTL_MS = 20_000;

function normalizeRequestedSymbols(symbols?: string[]) {
  return Array.from(new Set((symbols ?? []).map(toCanonicalSymbol)));
}

function toSortedSymbols(symbols: Iterable<string>) {
  return Array.from(new Set(symbols)).sort((left, right) => left.localeCompare(right));
}

export class CoinoneProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new CoinoneAdapter();
  private readonly signer = new CoinoneSigner();
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];
  private supportedStreamSymbols = new Set<string>();

  constructor() {
    super('coinone');
  }

  async listMarkets() {
    return this.withRequestCache({
      operation: 'markets',
      key: 'krw',
      ttlMs: MARKET_CACHE_TTL_MS,
      staleTtlMs: MARKET_STALE_TTL_MS,
      loader: async () => {
        const response = await this.restClient.request<any>('/public/v2/markets/KRW');
        return parseCoinoneMarketsResponse(response);
      },
      responseItemCount: (items) => items.length,
    });
  }

  async getMarketCapabilitySnapshot(markets?: ExchangeMarketDescriptor[]): Promise<MarketCapabilitySnapshot> {
    const marketUniverse = toSortedSymbols((markets ?? await this.listMarkets()).map((market) => market.symbol));
    return {
      websocketTickerSymbols: this.supportedStreamSymbols.size > 0 ? toSortedSymbols(this.supportedStreamSymbols) : marketUniverse,
      capabilitySymbols: {
        tickers: marketUniverse,
        orderbook: marketUniverse,
        trades: marketUniverse,
        candles: marketUniverse,
      },
    };
  }

  async getTickerSnapshot(symbols?: string[]): Promise<CanonicalTickerSnapshot[]> {
    const listedMarkets = await this.listMarkets();
    const marketUniverse = toSortedSymbols(listedMarkets.map((market) => market.symbol));
    const requestedSymbols = normalizeRequestedSymbols(symbols);
    const effectiveRequestedSymbols = requestedSymbols.length > 0 ? requestedSymbols : marketUniverse;
    const requestedSet = new Set(effectiveRequestedSymbols);
    const marketSymbols = new Set(marketUniverse);
    const snapshots = await this.withRequestCache({
      operation: 'tickers',
      key: 'krw:all',
      ttlMs: TICKER_CACHE_TTL_MS,
      staleTtlMs: TICKER_STALE_TTL_MS,
      staleWhileRevalidate: true,
      requestedMarketCount: effectiveRequestedSymbols.length,
      normalizedSymbolCount: effectiveRequestedSymbols.length,
      loader: async () => {
        const tickers = await this.adapter.fetchTickers(Array.from(marketSymbols));
        return tickers.map((ticker) => ({
          ...toCanonicalMarket(this.exchange, ticker.symbol),
          price: ticker.price,
          change24h: ticker.change24h,
          volume24h: ticker.volume24h,
          high24h: ticker.high24h,
          low24h: ticker.low24h,
          timestamp: ticker.timestamp,
        }));
      },
      responseItemCount: (items) => items.length,
      symbolDiff: {
        requestedSymbols: effectiveRequestedSymbols,
        resolvedSymbols: (items) => items.map((item) => item.symbol),
        droppedReason: (symbol) =>
          marketSymbols.has(symbol) ? 'missing_from_exchange_ticker_response' : 'not_listed_on_exchange_market_universe',
      },
    });
    const filtered = snapshots.filter((ticker) => requestedSet.has(ticker.symbol));
    logger.debug(
      {
        domain: 'market-provider',
        exchange: this.exchange,
        operation: 'tickers',
        requestedMarketCount: effectiveRequestedSymbols.length,
        responseItemCount: filtered.length,
        sample: filtered.slice(0, 3).map((ticker) => ({
          symbol: ticker.symbol,
          rawSymbol: ticker.rawSymbol,
          price: ticker.price,
          change24h: ticker.change24h,
        })),
      },
      'Coinone ticker normalization sample',
    );
    const capabilitySnapshot = await this.getMarketCapabilitySnapshot(listedMarkets);
    this.logResolvedMarketUniverse({
      operation: 'tickers',
      requestedSymbols: effectiveRequestedSymbols,
      returnedSymbols: toSortedSymbols(filtered.map((ticker) => ticker.symbol)),
      droppedReason: (symbol) => (marketSymbols.has(symbol) ? 'missing_upstream_ticker' : 'unsupported_on_exchange'),
      universe: {
        registrySymbols: DEFAULT_SYMBOLS,
        marketSymbols: marketUniverse,
        ...capabilitySnapshot,
      },
    });

    return filtered;
  }

  async getOrderbookSnapshot(symbol: string, depth = 15): Promise<CanonicalOrderbookSnapshot> {
    const canonical = toCanonicalSymbol(symbol);
    const snapshot = await this.adapter.fetchOrderbook(canonical, depth);
    const market = toCanonicalMarket(this.exchange, canonical);
    const asks = snapshot.asks.map((level) => ({ price: level.price, quantity: level.qty }));
    const bids = snapshot.bids.map((level) => ({ price: level.price, quantity: level.qty }));

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
    const response = await this.restClient.request<any>(`/public/v2/trades/KRW/${canonical}`, {
      query: { size: limit },
    });
    const trades = response.trades ?? response.data?.trades ?? response.data ?? [];
    const market = toCanonicalMarket(this.exchange, canonical);

    return trades.map((trade: any) => {
      const price = safeNumber(trade.price ?? trade.last);
      const quantity = safeNumber(trade.qty ?? trade.quantity);
      const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
        [trade.timestamp, trade.ts],
        { assumeTimezone: 'UTC' },
      );
      if (normalizedTimestamp.timestamp === null) {
        logger.warn(
          { domain: 'market-routes', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
          `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
        );
      }
      return {
        ...market,
        tradeId: String(trade.id ?? trade.trade_id ?? `${canonical}:${Date.now()}`),
        side: trade.is_buy === true || String(trade.side ?? '').toUpperCase() === 'BUY' ? 'buy' : 'sell',
        price,
        quantity,
        notional: price * quantity,
        timestamp: normalizedTimestamp.timestamp,
        executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
      };
    });
  }

  async getCandles(symbol: string, interval: string, limit = 60): Promise<CanonicalCandle[]> {
    const canonical = toCanonicalSymbol(symbol);
    const candles = await this.adapter.fetchCandles(canonical, interval, limit);
    const market = toCanonicalMarket(this.exchange, canonical);

    return candles.map((candle, index) => ({
      ...toHistoricalCandleWindow({
        interval,
        timestamp: candle.time,
        index,
        total: candles.length,
      }),
      ...market,
      interval,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
  }

  async startPublicStream(subscriptions: StreamSubscription[], sink: MarketStreamSink) {
    this.activeSubscriptions = subscriptions.filter((subscription) => subscription.exchange === this.exchange);
    if (this.activeSubscriptions.length === 0) return;

    await this.refreshSupportedStreamSymbols();
    const initialPlan = await this.buildActiveStreamPlan();
    this.logStreamPlan('start', initialPlan);
    if (initialPlan.totalResolvedSymbols === 0) {
      logger.warn(
        { domain: 'market-streaming', exchange: this.exchange, skippedResyncSymbols: initialPlan.skippedSymbols },
        'Skipping Coinone public stream start because no symbols resolved',
      );
      return;
    }

    this.streamManager = new WebSocketClientManager({
      name: 'coinone-public',
      url: getExchangeConfig(this.exchange).publicWebSocketUrl,
      heartbeatIntervalMs: 15 * 60 * 1000,
      onOpen: async (ctx) => {
        const plan = await this.buildActiveStreamPlan();
        const tickerSymbols = new Set(plan.resolvedByChannel.tickers);
        const orderbookSymbols = new Set(plan.resolvedByChannel.orderbook);
        const tradeSymbols = new Set(plan.resolvedByChannel.trades);
        const allSymbols = Array.from(new Set([
          ...plan.resolvedByChannel.tickers,
          ...plan.resolvedByChannel.orderbook,
          ...plan.resolvedByChannel.trades,
        ]));

        for (const symbol of allSymbols) {
          const topic = { quote_currency: 'KRW', target_currency: symbol };
          if (tickerSymbols.has(symbol)) {
            ctx.sendJson({ request_type: 'SUBSCRIBE', channel: 'TICKER', topic, format: 'DEFAULT' });
          }
          if (orderbookSymbols.has(symbol)) {
            ctx.sendJson({ request_type: 'SUBSCRIBE', channel: 'ORDERBOOK', topic, format: 'DEFAULT' });
          }
          if (tradeSymbols.has(symbol)) {
            ctx.sendJson({ request_type: 'SUBSCRIBE', channel: 'TRADE', topic, format: 'DEFAULT' });
          }
        }
      },
      onMessage: async (raw, ctx) => {
        const payload = JSON.parse(raw.toString());
        if (String(payload.response_type ?? '').toUpperCase() === 'PING') {
          ctx.sendJson({ request_type: 'PING' });
          return;
        }

        const channel = String(payload.channel ?? payload.c ?? '').toUpperCase();
        const data = payload.data ?? payload.d ?? {};
        const symbol = toCanonicalSymbol(String(data.target_currency ?? data.tc ?? ''));
        const market = toCanonicalMarket(this.exchange, symbol);
        const timestamp = safeNumber(data.timestamp ?? data.ts ?? Date.now());

        if (channel === 'TICKER' && sink.onTicker) {
          const price = safeNumber(data.last ?? data.close ?? data.price);
          const previous = safeNumber(data.yesterday_last ?? data.prev_close ?? data.open);
          const change24h = previous > 0 ? ((price - previous) / previous) * 100 : safeNumber(data.change_rate);
          await sink.onTicker({
            ...market,
            price,
            change24h,
            volume24h: safeNumber(data.quote_volume ?? data.volume),
            high24h: safeNumber(data.high ?? data.high_price),
            low24h: safeNumber(data.low ?? data.low_price),
            timestamp,
          });
          return;
        }

        if (channel === 'ORDERBOOK' && sink.onOrderbook) {
          const asks = sortAsks(
            (data.asks ?? []).map((ask: any) => ({
              price: safeNumber(ask.price ?? ask[0]),
              quantity: safeNumber(ask.qty ?? ask.quantity ?? ask[1]),
            })),
          );
          const bids = sortBids(
            (data.bids ?? []).map((bid: any) => ({
              price: safeNumber(bid.price ?? bid[0]),
              quantity: safeNumber(bid.qty ?? bid.quantity ?? bid[1]),
            })),
          );

          await sink.onOrderbook({
            ...market,
            asks,
            bids,
            bestAsk: asks[0]?.price ?? 0,
            bestBid: bids[0]?.price ?? 0,
            spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
            timestamp,
          });
          return;
        }

        if (channel === 'TRADE' && sink.onTrade) {
          const trades = Array.isArray(data) ? data : Array.isArray(data.trades) ? data.trades : [data];
          for (const trade of trades) {
            const price = safeNumber(trade.price ?? trade.last);
            const quantity = safeNumber(trade.qty ?? trade.quantity);
            const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
              [trade.timestamp, trade.ts, data.timestamp, data.ts],
              { assumeTimezone: 'UTC' },
            );
            if (normalizedTimestamp.timestamp === null) {
              logger.warn(
                { domain: 'market-streaming', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
                `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
              );
              continue;
            }
            await sink.onTrade({
              ...market,
              tradeId: String(trade.id ?? trade.trade_id ?? `${symbol}:${normalizedTimestamp.timestamp}`),
              side: trade.is_buy === true || String(trade.side ?? '').toUpperCase() === 'BUY' ? 'buy' : 'sell',
              price,
              quantity,
              notional: price * quantity,
              timestamp: normalizedTimestamp.timestamp,
              executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
            });
          }
        }
      },
      onReconnect: async (ctx) => {
        await this.resyncSnapshots(sink, 'reconnect', ctx.getReconnectMetadata() ?? undefined);
      },
    });

    await this.streamManager.start();
    await this.resyncSnapshots(sink, 'initial');
  }

  async stopPublicStream() {
    await this.streamManager?.stop();
    this.streamManager = null;
  }

  async createOrder(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const market = this.toMarketPayload(request.symbol);
    const type = request.type.toUpperCase();
    const payload: Record<string, unknown> = {
      ...market,
      side: request.side.toUpperCase(),
      type,
    };

    if (type === 'LIMIT') {
      payload.price = String(request.price ?? 0);
      payload.qty = String(request.quantity);
    } else if (type === 'MARKET' && request.side === 'buy') {
      payload.amount = String(await this.resolveMarketBuyAmount(request));
    } else if (type === 'MARKET') {
      payload.qty = String(request.quantity);
    } else {
      payload.price = String(request.price ?? 0);
      payload.qty = String(request.quantity);
    }

    if (request.clientOrderId) {
      payload.user_order_id = request.clientOrderId;
    }

    const response = await this.requestPrivate<{ order_id: string }>('/v2.1/order', context, payload);
    return this.getOrder(response.order_id, request.symbol, context);
  }

  async cancelOrder(request: CancelOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const market = this.toMarketPayload(request.symbol);
    const response = await this.requestPrivate<any>('/v2.1/order/cancel', context, {
      ...market,
      order_id: request.orderId,
    });
    return this.mapOrder(response, request.symbol);
  }

  async getOrder(orderId: string, symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder> {
    const market = this.toMarketPayload(symbol);
    const response = await this.requestPrivate<any>('/v2.1/order/detail', context, {
      ...market,
      order_id: orderId,
    });
    return this.mapOrder(response.order ?? response, symbol);
  }

  async listOpenOrders(symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder[]> {
    const path = symbol ? '/v2.1/order/active_orders' : '/v2.1/order/active_orders/all';
    const response = await this.requestPrivate<{ active_orders?: any[]; activeOrders?: any[] }>(path, context, {
      ...(symbol ? this.toMarketPayload(symbol) : {}),
    });
    const orders = response.active_orders ?? response.activeOrders ?? [];
    return orders.map((order) => this.mapOrder(order, symbol));
  }

  async listFills(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<CanonicalFill[]> {
    const now = Date.now();
    const path = symbol ? '/v2.1/order/completed_orders' : '/v2.1/order/completed_orders/all';
    const response = await this.requestPrivate<{ completed_orders?: any[]; completedOrders?: any[] }>(path, context, {
      ...(symbol ? this.toMarketPayload(symbol) : {}),
      size: Math.min(limit ?? 50, 100),
      from_ts: now - 30 * 24 * 60 * 60 * 1000,
      to_ts: now,
    });
    const fills = response.completed_orders ?? response.completedOrders ?? [];

    return fills.map((fill) => {
      const market = toCanonicalMarket(this.exchange, symbol ?? safeString(fill.target_currency));
      return {
        exchange: this.exchange,
        fillId: safeString(fill.trade_id ?? fill.tradeId),
        orderId: safeString(fill.order_id ?? fill.orderId),
        symbol: market.symbol,
        market: market.market,
        side: fill.is_ask === true ? 'sell' : 'buy',
        price: safeNumber(fill.price),
        quantity: safeNumber(fill.qty),
        fee: safeNumber(fill.fee),
        feeCurrency: safeString(fill.fee_currency || market.quoteCurrency),
        timestamp: safeNumber(fill.timestamp),
      };
    });
  }

  async getPortfolioSnapshot(context: ProviderContext): Promise<PortfolioSnapshot> {
    const response = await this.requestPrivate<{ balances?: any[] }>('/v2.1/account/balance/all', context);
    const balances: Balance[] = (response.balances ?? []).map((balance) => ({
      asset: safeString(balance.currency).toUpperCase(),
      free: safeNumber(balance.available),
      locked: safeNumber(balance.limit),
      averageBuyPrice: safeNumber(balance.average_price),
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

  private async refreshSupportedStreamSymbols() {
    this.supportedStreamSymbols = new Set((await this.listMarkets()).map((market) => market.symbol));
  }

  private async buildActiveStreamPlan() {
    if (this.supportedStreamSymbols.size === 0) {
      await this.refreshSupportedStreamSymbols();
    }

    return buildStreamSubscriptionPlan({
      subscriptions: this.activeSubscriptions,
      supportedSymbolsByChannel: {
        tickers: this.supportedStreamSymbols,
        orderbook: this.supportedStreamSymbols,
        trades: this.supportedStreamSymbols,
        candles: this.supportedStreamSymbols,
      },
    });
  }

  private logStreamPlan(
    phase: 'start' | 'initial' | 'reconnect',
    plan: Awaited<ReturnType<CoinoneProvider['buildActiveStreamPlan']>>,
    reconnectMetadata?: WebSocketReconnectMetadata,
  ) {
    logger.info(
      {
        domain: 'market-streaming',
        exchange: this.exchange,
        phase,
        reconnectReason: reconnectMetadata,
        activeSubscriptionCount: plan.activeSubscriptionCount,
        resyncScope: plan.activeChannels.map((channel) => ({
          channel,
          symbolCount: plan.resolvedByChannel[channel].length,
        })),
        skippedResyncSymbols: plan.skippedSymbols,
      },
      phase === 'start' ? 'Prepared Coinone public stream plan' : 'Prepared Coinone public resync plan',
    );
  }

  private async resyncSnapshots(
    sink: MarketStreamSink,
    phase: 'initial' | 'reconnect',
    reconnectMetadata?: WebSocketReconnectMetadata,
  ) {
    const plan = await this.buildActiveStreamPlan();
    this.logStreamPlan(phase, plan, reconnectMetadata);

    if (phase === 'reconnect' && sink.onReconnect) {
      for (const channel of plan.activeChannels) {
        await sink.onReconnect({
          exchange: this.exchange,
          channel,
          symbols: plan.resolvedByChannel[channel],
        });
      }
    }
    if (sink.onTicker && plan.resolvedByChannel.tickers.length > 0) {
      const tickers = await this.getTickerSnapshot(plan.resolvedByChannel.tickers);
      for (const ticker of tickers) await sink.onTicker(ticker);
    }
    if (sink.onOrderbook && plan.resolvedByChannel.orderbook.length > 0) {
      for (const symbol of plan.resolvedByChannel.orderbook) {
        await sink.onOrderbook(await this.getOrderbookSnapshot(symbol));
      }
    }
    if (sink.onTrade && plan.resolvedByChannel.trades.length > 0) {
      for (const symbol of plan.resolvedByChannel.trades) {
        const trades = await this.getRecentTrades(symbol, 20);
        for (const trade of trades.reverse()) await sink.onTrade(trade);
      }
    }
  }

  private async requestPrivate<T>(path: string, context: ProviderContext, payload: Record<string, unknown> = {}) {
    const credentials = this.requireCredentials(context);
    const signed = this.signer.createSignedRequest({
      accessToken: credentials.apiKey,
      secretKey: credentials.secretKey,
      payload,
    });
    const response = await this.restClient.request<T & {
      result?: string;
      error_code?: string;
      errorCode?: string;
      error_msg?: string;
      errorMsg?: string;
    }>(path, {
      method: 'POST',
      headers: signed.headers,
      json: signed.payload,
    });
    const result = safeString((response as any).result).toLowerCase();
    if (result && result !== 'success') {
      const message = safeString((response as any).error_msg ?? (response as any).errorMsg ?? (response as any).error_code ?? (response as any).errorCode) || 'Coinone request failed';
      throw new ExchangeAuthError(this.exchange, message);
    }
    return response;
  }

  private requireCredentials(context: ProviderContext) {
    if (!context.credentials) {
      throw new ExchangeAuthError(this.exchange, 'Coinone credentials are required');
    }

    return context.credentials;
  }

  private toMarketPayload(symbol?: string) {
    return {
      quote_currency: 'KRW',
      ...(symbol ? { target_currency: toCanonicalSymbol(symbol) } : {}),
    };
  }

  private async resolveMarketBuyAmount(request: CreateOrderRequest) {
    if (request.price && request.price > 0) {
      return request.price;
    }

    const [ticker] = await this.getTickerSnapshot([request.symbol]);
    return Math.max((ticker?.price ?? 0) * request.quantity, 0);
  }

  private mapOrder(order: any, symbol?: string): CanonicalOrder {
    const market = toCanonicalMarket(this.exchange, symbol ?? safeString(order.target_currency));
    const quantity = safeNumber(order.original_qty ?? order.qty);
    const filledQuantity = safeNumber(order.executed_qty ?? order.traded_qty ?? 0);
    const remainingQuantity = safeNumber(order.remain_qty ?? Math.max(quantity - filledQuantity, 0));
    const status = normalizeOrderStatus({
      state: order.status,
      quantity,
      filledQuantity,
      remainingQuantity,
      openStates: ['live', 'not_triggered', 'triggered'],
      cancelledStates: ['canceled', 'partially_canceled', 'not_triggered_canceled', 'not_triggered_partially_canceled'],
      filledStates: ['filled'],
      rejectedStates: ['canceled_no_order', 'canceled_limit_price_exceed', 'canceled_under_product_unit'],
    });

    return {
      exchange: this.exchange,
      orderId: safeString(order.order_id ?? order.orderId),
      symbol: market.symbol,
      market: market.market,
      side: safeString(order.side).toLowerCase() === 'sell' ? 'sell' : 'buy',
      type: normalizeOrderType(order.type),
      status,
      price: safeNumber(order.price ?? order.average_executed_price),
      quantity: quantity || safeNumber(order.original_amount),
      filledQuantity,
      remainingQuantity,
      averageFillPrice: safeNumber(order.average_executed_price ?? order.avg_price),
      createdAt: safeNumber(order.ordered_at),
      updatedAt: safeNumber(order.updated_at ?? order.canceled_at ?? order.ordered_at),
    };
  }
}
