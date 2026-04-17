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
import { toCanonicalMarket, toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager } from '../../core/exchange/websocket.client-manager';
import { BithumbAdapter } from '../../exchanges/BithumbAdapter';
import { logger } from '../../utils/logger';
import { BaseExchangeProvider } from './base-exchange.provider';
import { safeNumber, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class BithumbProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new BithumbAdapter();
  private readonly signer = new JwtHmacSigner();
  private streamManager: WebSocketClientManager | null = null;
  private readonly books = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();
  private activeSubscriptions: StreamSubscription[] = [];

  constructor() {
    super('bithumb');
  }

  async listMarkets() {
    const response = await this.restClient.request<Array<{ market: string }>>('/v1/market/all', {
      query: { isDetails: false },
    });

    return response
      .filter((item) => item.market.startsWith('KRW-'))
      .map((item) => ({
        symbol: item.market.replace('KRW-', ''),
        market: item.market.replace('KRW-', '') + '/KRW',
        rawSymbol: item.market,
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
    const response = await this.restClient.request<any>(`/public/transaction_history/${canonical}_KRW`, {
      query: { count: limit },
    });
    const trades = response.data ?? [];
    const market = toCanonicalMarket(this.exchange, canonical);

    return trades.map((trade: any) => {
      const price = safeNumber(trade.price ?? trade.contPrice);
      const quantity = safeNumber(trade.units_traded ?? trade.contQty);
      return {
        ...market,
        tradeId: String(trade.transaction_date ?? `${canonical}:${price}:${quantity}`),
        side: String(trade.type ?? '').toLowerCase() === 'ask' ? 'sell' : 'buy',
        price,
        quantity,
        notional: price * quantity,
        timestamp: Date.now(),
      };
    });
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

    const socketSymbols = symbols.map((symbol) => `${symbol}_KRW`);
    this.streamManager = new WebSocketClientManager({
      name: 'bithumb-public',
      url: getExchangeConfig(this.exchange).publicWebSocketUrl,
      onOpen: async (ctx) => {
        ctx.sendJson({ type: 'ticker', symbols: socketSymbols, tickTypes: ['24H'], isOnlyRealtime: true });
        ctx.sendJson({ type: 'orderbooksnapshot', symbols: socketSymbols });
        ctx.sendJson({ type: 'orderbookdepth', symbols: socketSymbols, isOnlyRealtime: true });
        ctx.sendJson({ type: 'transaction', symbols: socketSymbols, isOnlyRealtime: true });
      },
      onMessage: async (raw) => {
        const payload = JSON.parse(raw.toString());
        if (payload.status === '0000') return;

        const type = String(payload.type ?? '');
        const content = payload.content ?? {};
        if (type === 'ticker' && sink.onTicker) {
          const symbol = toCanonicalSymbol(String(content.symbol ?? '').replace('_KRW', ''));
          await sink.onTicker({
            ...toCanonicalMarket(this.exchange, symbol),
            price: safeNumber(content.closePrice),
            change24h: safeNumber(content.chgRate),
            volume24h: safeNumber(content.value),
            high24h: safeNumber(content.highPrice),
            low24h: safeNumber(content.lowPrice),
            timestamp: Date.now(),
          });
          return;
        }

        if (type === 'orderbooksnapshot') {
          const rawSymbol = String(content.symbol ?? '');
          const asks = sortAsks(
            (content.asks ?? []).map((ask: any) => ({
              price: safeNumber(Array.isArray(ask) ? ask[0] : ask.price),
              quantity: safeNumber(Array.isArray(ask) ? ask[1] : ask.quantity),
            })),
          );
          const bids = sortBids(
            (content.bids ?? []).map((bid: any) => ({
              price: safeNumber(Array.isArray(bid) ? bid[0] : bid.price),
              quantity: safeNumber(Array.isArray(bid) ? bid[1] : bid.quantity),
            })),
          );
          this.books.set(rawSymbol, {
            asks: new Map(asks.map((entry) => [entry.price, entry.quantity])),
            bids: new Map(bids.map((entry) => [entry.price, entry.quantity])),
          });
          await this.emitBook(rawSymbol, safeNumber(content.datetime ?? Date.now()), sink);
          return;
        }

        if (type === 'orderbookdepth') {
          const updates = content.list ?? [];
          for (const update of updates) {
            const rawSymbol = String(update.symbol ?? '');
            const existing = this.books.get(rawSymbol) ?? { asks: new Map<number, number>(), bids: new Map<number, number>() };
            const side = String(update.orderType ?? '').toLowerCase();
            const price = safeNumber(update.price);
            const quantity = safeNumber(update.quantity);
            if (side === 'ask') {
              if (quantity <= 0) existing.asks.delete(price);
              else existing.asks.set(price, quantity);
            } else {
              if (quantity <= 0) existing.bids.delete(price);
              else existing.bids.set(price, quantity);
            }
            this.books.set(rawSymbol, existing);
          }
          const rawSymbol = String(updates[0]?.symbol ?? '');
          if (rawSymbol) {
            await this.emitBook(rawSymbol, safeNumber(content.datetime ?? Date.now()), sink);
          }
          return;
        }

        if (type === 'transaction' && sink.onTrade) {
          const trades = content.list ?? [];
          for (const trade of trades) {
            const symbol = toCanonicalSymbol(String(trade.symbol ?? '').replace('_KRW', ''));
            const market = toCanonicalMarket(this.exchange, symbol);
            const price = safeNumber(trade.contPrice ?? trade.price);
            const quantity = safeNumber(trade.contQty ?? trade.quantity);
            await sink.onTrade({
              ...market,
              tradeId: String(trade.contNo ?? trade.transaction_date ?? `${symbol}:${Date.now()}`),
              side: String(trade.buySellGb ?? '') === '1' ? 'sell' : 'buy',
              price,
              quantity,
              notional: price * quantity,
              timestamp: Date.now(),
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

  async getOrderChance(symbol: string, context: ProviderContext): Promise<OrderChance> {
    const credentials = this.requireCredentials(context);
    const rawSymbol = toExchangeSymbol(this.exchange, symbol);
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query: { market: rawSymbol },
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any>('/v1/orders/chance', {
      query: { market: rawSymbol },
      headers,
    });

    return {
      exchange: this.exchange,
      market: `${toCanonicalSymbol(symbol)}/KRW`,
      symbol: toCanonicalSymbol(symbol),
      quoteCurrency: 'KRW',
      minTotal: safeNumber(response.market?.ask?.min_total ?? response.market?.bid?.min_total),
      makerFee: safeNumber(response.maker_bid_fee ?? response.maker_ask_fee),
      takerFee: safeNumber(response.bid_fee ?? response.ask_fee),
      supportedOrderTypes: ['limit', 'market'],
    };
  }

  async createOrder(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = this.requireCredentials(context);
    const rawSymbol = toExchangeSymbol(this.exchange, request.symbol);
    const body: Record<string, unknown> = {
      market: rawSymbol,
      side: request.side === 'buy' ? 'bid' : 'ask',
      ord_type: request.type === 'limit' ? 'limit' : request.side === 'buy' ? 'price' : 'market',
    };

    if (request.type === 'limit' || request.type === 'stop_limit') {
      body.price = request.price;
      body.volume = request.quantity;
    } else if (request.side === 'buy') {
      const quoteAmount =
        request.price
        ?? (await this.getTickerSnapshot([request.symbol]))[0]?.price * request.quantity;
      body.price = quoteAmount;
    } else {
      body.volume = request.quantity;
    }

    if (request.clientOrderId) {
      body.client_order_id = request.clientOrderId;
    }

    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      body,
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any>('/v1/orders', {
      method: 'POST',
      headers,
      json: body,
    });
    return this.mapPrivateOrder(response, request.symbol);
  }

  async cancelOrder(request: CancelOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = this.requireCredentials(context);
    const query = { uuid: request.orderId };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any>('/v1/order', {
      method: 'DELETE',
      query,
      headers,
    });
    return this.mapPrivateOrder(response, request.symbol);
  }

  async getOrder(orderId: string, symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = this.requireCredentials(context);
    const query = { uuid: orderId };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any>('/v1/order', {
      query,
      headers,
    });
    return this.mapPrivateOrder(response, symbol);
  }

  async listOpenOrders(symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder[]> {
    const credentials = this.requireCredentials(context);
    const query = {
      ...(symbol ? { market: toExchangeSymbol(this.exchange, symbol) } : {}),
      state: 'wait',
      limit: 100,
    };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any[]>('/v1/orders', {
      query,
      headers,
    });
    return response.map((order) => this.mapPrivateOrder(order, symbol));
  }

  async listFills(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<CanonicalFill[]> {
    const credentials = this.requireCredentials(context);
    const query = {
      ...(symbol ? { market: toExchangeSymbol(this.exchange, symbol) } : {}),
      state: 'done',
      limit: limit ?? 50,
      order_by: 'desc',
    };
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query,
      includeTimestamp: true,
    });
    const response = await this.restClient.request<any[]>('/v1/orders', {
      query,
      headers,
    });

    return response.flatMap((order) => {
      const market = toCanonicalMarket(
        this.exchange,
        symbol ?? String(order.market ?? '').replace('KRW-', '').toUpperCase(),
      );
      const trades = Array.isArray(order.trades) && order.trades.length > 0 ? order.trades : [order];
      return trades.map((trade: any) => {
        const price = safeNumber(trade.price ?? order.price);
        const quantity = safeNumber(trade.volume ?? trade.executed_volume ?? order.executed_volume);
        return {
          exchange: this.exchange,
          fillId: String(trade.uuid ?? trade.trade_uuid ?? `${order.uuid}:${trade.created_at ?? trade.trade_timestamp ?? order.created_at}`),
          orderId: String(order.uuid ?? order.order_id),
          symbol: market.symbol,
          market: market.market,
          side: String(order.side ?? '').toLowerCase() === 'ask' ? 'sell' : 'buy',
          price,
          quantity,
          fee: safeNumber(trade.fee ?? order.paid_fee),
          feeCurrency: market.quoteCurrency,
          timestamp: safeNumber(trade.trade_timestamp ?? new Date(trade.created_at ?? order.created_at ?? Date.now()).getTime()),
        };
      });
    });
  }

  async getPortfolioSnapshot(context: ProviderContext): Promise<PortfolioSnapshot> {
    const credentials = this.requireCredentials(context);
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      includeTimestamp: true,
    });
    const accounts = await this.restClient.request<any[]>('/v1/accounts', {
      headers,
    });
    const balances = accounts.map((account) => ({
      asset: String(account.currency).toUpperCase(),
      free: safeNumber(account.balance),
      locked: safeNumber(account.locked),
      averageBuyPrice: safeNumber(account.avg_buy_price),
    }));

    const symbols = balances
      .filter((balance) => balance.asset !== 'KRW' && balance.free + balance.locked > 0)
      .map((balance) => balance.asset);
    const tickers = symbols.length > 0 ? await this.getTickerSnapshot(symbols) : [];
    const tickerMap = new Map(tickers.map((ticker) => [ticker.symbol, ticker.price]));
    const positions = balances
      .filter((balance) => balance.asset !== 'KRW' && balance.free + balance.locked > 0)
      .map((balance) => {
        const quantity = balance.free + balance.locked;
        const averageBuyPrice = balance.averageBuyPrice ?? 0;
        const currentPrice = tickerMap.get(balance.asset) ?? 0;
        const marketValue = quantity * currentPrice;
        const totalCost = quantity * averageBuyPrice;
        const pnlValue = marketValue - totalCost;
        return {
          exchange: this.exchange,
          symbol: balance.asset,
          quantity,
          free: balance.free,
          locked: balance.locked,
          averageBuyPrice,
          currentPrice,
          marketValue,
          pnlValue,
          pnlPercent: totalCost > 0 ? (pnlValue / totalCost) * 100 : 0,
          timestamp: Date.now(),
        };
      });
    const totalAssetValue =
      balances
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
      exchange: this.exchange,
      symbol: fill.symbol,
      type: 'trade',
      amount: fill.side === 'buy' ? fill.quantity : -fill.quantity,
      timestamp: fill.timestamp,
      description: `${fill.side.toUpperCase()} ${fill.quantity} @ ${fill.price}`,
    }));
  }

  private async emitBook(rawSymbol: string, timestamp: number, sink: MarketStreamSink) {
    if (!sink.onOrderbook) return;
    const book = this.books.get(rawSymbol);
    if (!book) return;
    const symbol = toCanonicalSymbol(rawSymbol.replace('_KRW', ''));
    const asks = sortAsks(Array.from(book.asks.entries()).map(([price, quantity]) => ({ price, quantity })));
    const bids = sortBids(Array.from(book.bids.entries()).map(([price, quantity]) => ({ price, quantity })));

    await sink.onOrderbook({
      ...toCanonicalMarket(this.exchange, symbol),
      asks,
      bids,
      bestAsk: asks[0]?.price ?? 0,
      bestBid: bids[0]?.price ?? 0,
      spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
      timestamp,
    });
  }

  private async resyncSnapshots(sink: MarketStreamSink, symbols: string[]) {
    if (sink.onReconnect) {
      for (const subscription of this.activeSubscriptions.filter((item) => item.exchange === this.exchange)) {
        try {
          await sink.onReconnect(subscription);
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, capability: 'reconnect', err: error },
            'Bithumb reconnect notification failed',
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
              'Bithumb ticker resync sink failed',
            );
          }
        }
      } catch (error) {
        logger.warn(
          { domain: 'market-streaming', exchange: this.exchange, capability: 'ticker', err: error },
          'Bithumb ticker resync failed',
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
            'Bithumb orderbook resync failed',
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
                'Bithumb trade resync sink failed',
              );
            }
          }
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange: this.exchange, symbol, capability: 'trades', err: error },
            'Bithumb trade resync failed',
          );
        }
      }
    }
  }

  private requireCredentials(context: ProviderContext) {
    if (!context.credentials) {
      throw new Error('Bithumb credentials are required');
    }

    return context.credentials;
  }

  private mapPrivateOrder(order: any, symbol?: string): CanonicalOrder {
    const resolvedSymbol = symbol ? toCanonicalSymbol(symbol) : String(order.market ?? '').replace('KRW-', '').toUpperCase();
    const market = toCanonicalMarket(this.exchange, resolvedSymbol);
    const quantity = safeNumber(order.volume ?? order.original_qty ?? order.qty ?? order.executed_volume);
    const filledQuantity = safeNumber(order.executed_volume ?? order.executed_qty ?? order.traded_qty ?? 0);
    const remainingQuantity = safeNumber(order.remaining_volume ?? order.remain_qty ?? Math.max(quantity - filledQuantity, 0));
    const state = String(order.state ?? order.status ?? 'wait').toLowerCase();
    const status =
      state === 'done' ? 'filled'
      : state === 'cancel' || state === 'cancelled' || state === 'canceled' ? 'cancelled'
      : filledQuantity > 0 ? 'partial'
      : 'open';

    return {
      exchange: this.exchange,
      orderId: String(order.uuid ?? order.order_id ?? order.id),
      symbol: market.symbol,
      market: market.market,
      side: String(order.side ?? '').toLowerCase() === 'ask' ? 'sell' : 'buy',
      type: String(order.ord_type ?? order.order_type ?? 'limit') === 'price' ? 'market' : (order.ord_type ?? order.order_type ?? 'limit'),
      status,
      price: safeNumber(order.price ?? order.avg_price),
      quantity,
      filledQuantity,
      remainingQuantity,
      averageFillPrice: safeNumber(order.avg_price ?? order.price),
      createdAt: safeNumber(new Date(order.created_at ?? order.order_timestamp ?? Date.now()).getTime()),
      updatedAt: safeNumber(
        order.trade_timestamp
          ?? new Date(order.updated_at ?? order.created_at ?? order.order_timestamp ?? Date.now()).getTime(),
      ),
    };
  }
}
