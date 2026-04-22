import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { JwtHmacSigner } from '../../core/exchange/auth/jwt-hmac.signer';
import type {
  AssetHistoryRecord,
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
  OrderChance,
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
import { toCanonicalMarket, toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager, type WebSocketReconnectMetadata } from '../../core/exchange/websocket.client-manager';
import { UpbitAdapter } from '../../exchanges/UpbitAdapter';
import { logger } from '../../utils/logger';
import { BaseExchangeProvider } from './base-exchange.provider';
import {
  normalizeExchangeTimestampFromCandidates,
  requireCredentials,
  safeNumber,
  sortAsks,
  sortBids,
  toHistoricalCandleWindow,
  toIsoTimestamp,
} from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);
const MARKET_CACHE_TTL_MS = 60_000;
const MARKET_STALE_TTL_MS = 5 * 60_000;
const TICKER_CACHE_TTL_MS = 2_000;
const TICKER_STALE_TTL_MS = 30_000;

function normalizeRequestedSymbols(symbols?: string[]) {
  return Array.from(new Set((symbols ?? []).map(toCanonicalSymbol)));
}

function toSortedSymbols(symbols: Iterable<string>) {
  return Array.from(new Set(symbols)).sort((left, right) => left.localeCompare(right));
}

export class UpbitProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new UpbitAdapter();
  private readonly signer = new JwtHmacSigner();
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];
  private supportedStreamSymbols = new Set<string>();

  constructor() {
    super('upbit');
  }

  async listMarkets() {
    return this.withRequestCache({
      operation: 'markets',
      key: 'krw',
      ttlMs: MARKET_CACHE_TTL_MS,
      staleTtlMs: MARKET_STALE_TTL_MS,
      loader: async () => {
        const response = await this.restClient.request<Array<{ market: string }>>('/v1/market/all', {
          query: { isDetails: false },
        });

        return response
          .filter((item) => item.market.startsWith('KRW-'))
          .map<ExchangeMarketDescriptor>((item) => {
            const symbol = item.market.replace('KRW-', '');
            return {
              symbol,
              exchangeSymbol: item.market,
              marketId: item.market,
              market: `${symbol}/KRW`,
              baseCurrency: symbol,
              quoteCurrency: 'KRW',
              rawSymbol: item.market,
              tradable: true,
            };
          });
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
    const rawSymbol = toExchangeSymbol(this.exchange, canonical);
    const response = await this.restClient.request<any[]>('/v1/trades/ticks', {
      query: {
        market: rawSymbol,
        count: limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return response.map((trade) => {
      const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
        [trade.trade_timestamp, trade.ttms, trade.timestamp],
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
        tradeId: String(trade.sequential_id ?? `${rawSymbol}:${trade.trade_timestamp}`),
        side: String(trade.ask_bid).toLowerCase() === 'ask' ? 'sell' : 'buy',
        price: safeNumber(trade.trade_price),
        quantity: safeNumber(trade.trade_volume),
        notional: safeNumber(trade.trade_price) * safeNumber(trade.trade_volume),
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
    if (this.activeSubscriptions.length === 0) {
      return;
    }

    await this.refreshSupportedStreamSymbols();
    const initialPlan = await this.buildActiveStreamPlan();
    this.logStreamPlan('start', initialPlan);
    if (initialPlan.totalResolvedSymbols === 0) {
      logger.warn(
        { domain: 'market-streaming', exchange: this.exchange, skippedResyncSymbols: initialPlan.skippedSymbols },
        'Skipping Upbit public stream start because no symbols resolved',
      );
      return;
    }

    const config = getExchangeConfig(this.exchange);
    this.streamManager = new WebSocketClientManager({
      name: 'upbit-public',
      url: config.publicWebSocketUrl,
      onOpen: async (ctx) => {
        const plan = await this.buildActiveStreamPlan();
        const payload = [{ ticket: `cryptory-upbit-${Date.now()}` }] as Array<Record<string, unknown>>;

        if (plan.resolvedByChannel.tickers.length > 0) {
          payload.push({
            type: 'ticker',
            codes: plan.resolvedByChannel.tickers.map((symbol) => toExchangeSymbol(this.exchange, symbol)),
            is_only_realtime: true,
          });
        }
        if (plan.resolvedByChannel.orderbook.length > 0) {
          payload.push({
            type: 'orderbook',
            codes: plan.resolvedByChannel.orderbook.map((symbol) => toExchangeSymbol(this.exchange, symbol)),
            is_only_realtime: true,
          });
        }
        if (plan.resolvedByChannel.trades.length > 0) {
          payload.push({
            type: 'trade',
            codes: plan.resolvedByChannel.trades.map((symbol) => toExchangeSymbol(this.exchange, symbol)),
            is_only_realtime: true,
          });
        }

        payload.push({ format: 'DEFAULT' });
        ctx.sendJson(payload);
      },
      onMessage: async (raw) => {
        const payload = JSON.parse(raw.toString());
        const type = payload.type ?? payload.ty;
        const rawSymbol = String(payload.code ?? payload.cd ?? '');
        const symbol = toCanonicalSymbol(rawSymbol.replace('KRW-', '').replace('USDT-', ''));
        const market = toCanonicalMarket(this.exchange, symbol);
        const timestamp = safeNumber(payload.trade_timestamp ?? payload.ttms ?? payload.timestamp ?? Date.now());

        if (type === 'ticker' && sink.onTicker) {
          await sink.onTicker({
            ...market,
            price: safeNumber(payload.trade_price ?? payload.tp),
            change24h: safeNumber(payload.signed_change_rate ?? payload.scr) * 100,
            volume24h: safeNumber(payload.acc_trade_price_24h ?? payload.atp24h),
            high24h: safeNumber(payload.high_price ?? payload.hp),
            low24h: safeNumber(payload.low_price ?? payload.lp),
            timestamp,
          });
          return;
        }

        if (type === 'orderbook' && sink.onOrderbook) {
          const units = payload.orderbook_units ?? payload.obu ?? [];
          const asks = sortAsks(
            units.map((unit: any) => ({
              price: safeNumber(unit.ask_price ?? unit.ap),
              quantity: safeNumber(unit.ask_size ?? unit.as),
            })),
          );
          const bids = sortBids(
            units.map((unit: any) => ({
              price: safeNumber(unit.bid_price ?? unit.bp),
              quantity: safeNumber(unit.bid_size ?? unit.bs),
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

        if (type === 'trade' && sink.onTrade) {
          const price = safeNumber(payload.trade_price ?? payload.tp);
          const quantity = safeNumber(payload.trade_volume ?? payload.tv);
          const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
            [payload.trade_timestamp, payload.ttms, payload.timestamp],
            { assumeTimezone: 'UTC' },
          );
          if (normalizedTimestamp.timestamp === null) {
            logger.warn(
              { domain: 'market-streaming', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
              `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
            );
            return;
          }
          await sink.onTrade({
            ...market,
            tradeId: String(payload.sequential_id ?? payload.sid ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
            side: String(payload.ask_bid ?? payload.ab).toLowerCase() === 'ask' ? 'sell' : 'buy',
            price,
            quantity,
            notional: price * quantity,
            timestamp: normalizedTimestamp.timestamp,
            executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
          });
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

  async getOrderChance(symbol: string, context: ProviderContext): Promise<OrderChance> {
    const credentials = requireCredentials(this.exchange, context);
    const rawSymbol = toExchangeSymbol(this.exchange, symbol);
    const canonicalSymbol = toCanonicalSymbol(symbol);
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query: { market: rawSymbol },
    });
    const response = await this.restClient.request<any>('/v1/orders/chance', {
      query: { market: rawSymbol },
      headers,
    });
    const upstreamOrderTypes = Array.isArray(response.market?.order_types)
      ? response.market.order_types.map((type: unknown) => String(type).toLowerCase())
      : [];
    const upstreamOrderSides = Array.isArray(response.market?.order_sides)
      ? response.market.order_sides.map((side: unknown) => String(side).toLowerCase())
      : [];
    const supportsLimit = upstreamOrderTypes.length === 0 || upstreamOrderTypes.includes('limit');
    const supportsMarket =
      upstreamOrderTypes.length === 0
      || upstreamOrderTypes.includes('market')
      || upstreamOrderTypes.includes('price');
    const makerFee = safeNumber(response.bid_fee);
    const takerFee = safeNumber(response.ask_fee);
    const minTotal = safeNumber(response.market?.ask?.min_total ?? response.market?.bid?.min_total);
    const maxTotal = safeNumber(response.market?.max_total);
    const priceUnit = safeNumber(response.market?.bid?.price_unit ?? response.market?.ask?.price_unit);
    const availableQuote = safeNumber(response.bid_account?.balance);
    const availableBaseAsset = safeNumber(response.ask_account?.balance);

    return {
      exchange: this.exchange,
      market: `${canonicalSymbol}/KRW`,
      symbol: canonicalSymbol,
      quoteCurrency: 'KRW',
      baseAsset: canonicalSymbol,
      availableKRW: availableQuote,
      availableQuote,
      availableBaseAsset,
      minTotal,
      maxTotal,
      makerFee,
      takerFee,
      supportedOrderTypes: [
        ...(supportsLimit ? ['limit'] : []),
        ...(supportsMarket ? ['market'] : []),
      ],
      fees: {
        maker: makerFee,
        taker: takerFee,
      },
      precision: {
        priceUnit,
      },
      limits: {
        minTotal,
        maxTotal,
      },
      orderable: {
        buy: upstreamOrderSides.length === 0 || upstreamOrderSides.includes('bid'),
        sell: upstreamOrderSides.length === 0 || upstreamOrderSides.includes('ask'),
        limit: supportsLimit,
        market: supportsMarket,
      },
    };
  }

  async createOrder(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = requireCredentials(this.exchange, context);
    const rawSymbol = toExchangeSymbol(this.exchange, request.symbol);
    const body: Record<string, unknown> = {
      market: rawSymbol,
      side: request.side === 'buy' ? 'bid' : 'ask',
      ord_type: request.type === 'limit' ? 'limit' : request.side === 'buy' ? 'price' : 'market',
    };

    if (request.type === 'limit' || request.type === 'stop_limit') {
      if (request.price) body.price = request.price;
      if (request.quantity) body.volume = request.quantity;
    } else if (request.side === 'buy') {
      const quoteAmount =
        request.price
        ?? (await this.getTickerSnapshot([request.symbol]))[0]?.price * request.quantity;
      body.price = quoteAmount;
    } else {
      body.volume = request.quantity;
    }

    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      body,
    });
    const response = await this.restClient.request<any>('/v1/orders', {
      method: 'POST',
      headers,
      json: body,
    });

    return this.mapPrivateOrder(response, request.symbol);
  }

  async cancelOrder(request: CancelOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = requireCredentials(this.exchange, context);
    const query = { uuid: request.orderId };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
    });
    const response = await this.restClient.request<any>('/v1/order', {
      method: 'DELETE',
      query,
      headers,
    });
    return this.mapPrivateOrder(response, request.symbol);
  }

  async getOrder(orderId: string, symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = requireCredentials(this.exchange, context);
    const query = { uuid: orderId };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
    });
    const response = await this.restClient.request<any>('/v1/order', {
      query,
      headers,
    });
    return this.mapPrivateOrder(response, symbol);
  }

  async listOpenOrders(symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder[]> {
    const credentials = requireCredentials(this.exchange, context);
    const query = symbol ? { market: toExchangeSymbol(this.exchange, symbol) } : {};
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
    });
    const response = await this.restClient.request<any[]>('/v1/orders/open', {
      query,
      headers,
    });
    return response.map((order) => this.mapPrivateOrder(order, symbol));
  }

  async listFills(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<CanonicalFill[]> {
    const credentials = requireCredentials(this.exchange, context);
    const query = {
      ...(symbol ? { market: toExchangeSymbol(this.exchange, symbol) } : {}),
      limit: limit ?? 50,
      states: ['done'],
    };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
    });
    const response = await this.restClient.request<any[]>('/v1/orders/closed', {
      query,
      headers,
    });

    return response.flatMap((order) =>
      (order.trades ?? []).map((trade: any) => {
        const market = toCanonicalMarket(this.exchange, symbol ?? order.market.replace('KRW-', ''));
        const price = safeNumber(trade.price);
        const quantity = safeNumber(trade.volume);
        return {
          exchange: this.exchange,
          fillId: String(trade.uuid ?? trade.funds ?? order.uuid),
          orderId: String(order.uuid ?? order.id),
          symbol: market.symbol,
          market: market.market,
          side: String(order.side).toLowerCase() === 'ask' ? 'sell' : 'buy',
          price,
          quantity,
          fee: safeNumber(trade.fee ?? order.paid_fee),
          feeCurrency: String(trade.fee_currency ?? market.quoteCurrency),
          timestamp: safeNumber(new Date(trade.created_at).getTime()),
        };
      }),
    );
  }

  async getPortfolioSnapshot(context: ProviderContext): Promise<PortfolioSnapshot> {
    const credentials = requireCredentials(this.exchange, context);
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
    });
    const accounts = await this.restClient.request<any[]>('/v1/accounts', {
      headers,
    });
    const symbols = accounts
      .map((account) => String(account.currency).toUpperCase())
      .filter((symbol) => symbol !== 'KRW');
    const tickers = await this.getTickerSnapshot(symbols);
    const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker.price]));

    const balances = accounts.map((account) => ({
      asset: String(account.currency).toUpperCase(),
      free: safeNumber(account.balance),
      locked: safeNumber(account.locked),
      averageBuyPrice: safeNumber(account.avg_buy_price),
    }));
    const positions = balances
      .filter((balance) => balance.asset !== 'KRW' && balance.free + balance.locked > 0)
      .map((balance) => {
        const currentPrice = tickerMap.get(balance.asset) ?? 0;
        const quantity = balance.free + balance.locked;
        const marketValue = currentPrice * quantity;
        const totalCost = (balance.averageBuyPrice ?? 0) * quantity;
        const pnlValue = marketValue - totalCost;
        return {
          exchange: this.exchange,
          symbol: balance.asset,
          quantity,
          free: balance.free,
          locked: balance.locked,
          averageBuyPrice: balance.averageBuyPrice ?? 0,
          currentPrice,
          marketValue,
          pnlValue,
          pnlPercent: totalCost > 0 ? (pnlValue / totalCost) * 100 : 0,
          timestamp: Date.now(),
        };
      });
    const totalAssetValue = balances
      .filter((balance) => balance.asset === 'KRW')
      .reduce((sum, balance) => sum + balance.free + balance.locked, 0)
      + positions.reduce((sum, position) => sum + position.marketValue, 0);
    const totalCost = positions.reduce((sum, position) => sum + position.averageBuyPrice * position.quantity, 0);
    const totalPnlValue = positions.reduce((sum, position) => sum + position.pnlValue, 0);

    return {
      exchange: this.exchange,
      balances,
      positions,
      totalAssetValue,
      totalPnlValue,
      totalPnlPercent: totalCost > 0 ? (totalPnlValue / totalCost) * 100 : 0,
      timestamp: Date.now(),
    };
  }

  async getAssetHistory(
    symbol: string | undefined,
    limit: number | undefined,
    context: ProviderContext,
  ): Promise<AssetHistoryRecord[]> {
    const fills = await this.listFills(symbol, limit, context);
    return fills.map((fill) => ({
      id: fill.fillId,
      exchange: this.exchange,
      assetSymbol: fill.symbol,
      symbol: fill.symbol,
      eventType: 'trade',
      type: 'trade',
      amount: fill.side === 'buy' ? fill.quantity : -fill.quantity,
      price: fill.price,
      occurredAt: toIsoTimestamp(fill.timestamp),
      timestamp: fill.timestamp,
      source: 'exchange_private_api',
      sourceType: 'fill',
      isSynthetic: false,
      isVerifiedUserEvent: true,
      orderId: fill.orderId,
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
    plan: Awaited<ReturnType<UpbitProvider['buildActiveStreamPlan']>>,
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
      phase === 'start' ? 'Prepared Upbit public stream plan' : 'Prepared Upbit public resync plan',
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
        try {
          await sink.onReconnect({
            exchange: this.exchange,
            channel,
            symbols: plan.resolvedByChannel[channel],
          });
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, capability: 'reconnect', channel, err: error },
            'Upbit reconnect notification failed',
          );
        }
      }
    }

    if (sink.onTicker && plan.resolvedByChannel.tickers.length > 0) {
      try {
        const tickers = await this.getTickerSnapshot(plan.resolvedByChannel.tickers);
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
              'Upbit ticker resync sink failed',
            );
          }
        }
      } catch (error) {
        logger.warn(
          { domain: 'market-streaming', exchange: this.exchange, capability: 'ticker', err: error },
          'Upbit ticker resync failed',
        );
      }
    }

    if (sink.onOrderbook && plan.resolvedByChannel.orderbook.length > 0) {
      for (const symbol of plan.resolvedByChannel.orderbook) {
        try {
          await sink.onOrderbook(await this.getOrderbookSnapshot(symbol));
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, symbol, capability: 'orderbook', err: error },
            'Upbit orderbook resync failed',
          );
        }
      }
    }

    if (sink.onTrade && plan.resolvedByChannel.trades.length > 0) {
      for (const symbol of plan.resolvedByChannel.trades) {
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
                'Upbit trade resync sink failed',
              );
            }
          }
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, symbol, capability: 'trades', err: error },
            'Upbit trade resync failed',
          );
        }
      }
    }
  }

  private mapPrivateOrder(order: any, symbol?: string): CanonicalOrder {
    const resolvedSymbol = symbol ? toCanonicalSymbol(symbol) : String(order.market ?? '').replace('KRW-', '').toUpperCase();
    const market = toCanonicalMarket(this.exchange, resolvedSymbol);
    const quantity = safeNumber(order.volume ?? order.executed_volume ?? 0);
    const filledQuantity = safeNumber(order.executed_volume ?? 0);
    const remainingQuantity = Math.max(quantity - filledQuantity, 0);
    const state = String(order.state ?? order.status ?? 'wait').toLowerCase();
    const status =
      state === 'done' ? 'filled'
        : state === 'cancel' || state === 'cancelled' ? 'cancelled'
        : filledQuantity > 0 ? 'partial'
        : 'open';

    return {
      exchange: this.exchange,
      orderId: String(order.uuid ?? order.id),
      symbol: market.symbol,
      market: market.market,
      side: String(order.side ?? '').toLowerCase() === 'ask' ? 'sell' : 'buy',
      type: String(order.ord_type ?? 'limit') === 'price' ? 'market' : (order.ord_type ?? 'limit'),
      status,
      price: safeNumber(order.price),
      quantity,
      filledQuantity,
      remainingQuantity,
      averageFillPrice: safeNumber(order.avg_price ?? order.price),
      createdAt: safeNumber(new Date(order.created_at ?? Date.now()).getTime()),
      updatedAt: safeNumber(new Date(order.updated_at ?? order.created_at ?? Date.now()).getTime()),
    };
  }
}
