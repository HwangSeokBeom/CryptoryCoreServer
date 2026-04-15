import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { JwtHmacSigner } from '../../core/exchange/auth/jwt-hmac.signer';
import type {
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
import { UpbitAdapter } from '../../exchanges/UpbitAdapter';
import { BaseExchangeProvider } from './base-exchange.provider';
import { safeNumber, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class UpbitProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new UpbitAdapter();
  private readonly signer = new JwtHmacSigner();
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];

  constructor() {
    super('upbit');
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
    const rawSymbol = toExchangeSymbol(this.exchange, canonical);
    const response = await this.restClient.request<any[]>('/v1/trades/ticks', {
      query: {
        market: rawSymbol,
        count: limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return response.map((trade) => ({
      ...market,
      tradeId: String(trade.sequential_id ?? `${rawSymbol}:${trade.trade_timestamp}`),
      side: String(trade.ask_bid).toLowerCase() === 'ask' ? 'sell' : 'buy',
      price: safeNumber(trade.trade_price),
      quantity: safeNumber(trade.trade_volume),
      notional: safeNumber(trade.trade_price) * safeNumber(trade.trade_volume),
      timestamp: safeNumber(trade.trade_timestamp),
    }));
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

    if (symbols.length === 0) {
      return;
    }

    const config = getExchangeConfig(this.exchange);
    this.streamManager = new WebSocketClientManager({
      name: 'upbit-public',
      url: config.publicWebSocketUrl,
      onOpen: async (ctx) => {
        ctx.sendJson([
          { ticket: `cryptory-upbit-${Date.now()}` },
          { type: 'ticker', codes: symbols.map((symbol) => toExchangeSymbol(this.exchange, symbol)), is_only_realtime: true },
          { type: 'orderbook', codes: symbols.map((symbol) => toExchangeSymbol(this.exchange, symbol)), is_only_realtime: true },
          { type: 'trade', codes: symbols.map((symbol) => toExchangeSymbol(this.exchange, symbol)), is_only_realtime: true },
          { format: 'DEFAULT' },
        ]);
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
          await sink.onTrade({
            ...market,
            tradeId: String(payload.sequential_id ?? payload.sid ?? `${rawSymbol}:${timestamp}`),
            side: String(payload.ask_bid ?? payload.ab).toLowerCase() === 'ask' ? 'sell' : 'buy',
            price,
            quantity,
            notional: price * quantity,
            timestamp,
          });
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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
    const rawSymbol = toExchangeSymbol(this.exchange, symbol);
    const headers = this.signer.createAuthorizationHeader({
      accessKey: credentials.apiKey,
      secretKey: credentials.secretKey,
      query: { market: rawSymbol },
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
      makerFee: safeNumber(response.bid_fee),
      takerFee: safeNumber(response.ask_fee),
      supportedOrderTypes: ['limit', 'market'],
    };
  }

  async createOrder(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder> {
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
    const rawSymbol = toExchangeSymbol(this.exchange, request.symbol);
    const body: Record<string, unknown> = {
      market: rawSymbol,
      side: request.side === 'buy' ? 'bid' : 'ask',
      ord_type: request.type === 'limit' ? 'limit' : 'market',
    };

    if (request.price) body.price = request.price;
    if (request.quantity) body.volume = request.quantity;

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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
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
    const credentials = context.credentials;
    if (!credentials) throw new Error('Upbit credentials are required');
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

  private async resyncSnapshots(sink: MarketStreamSink, symbols: string[]) {
    if (sink.onReconnect) {
      for (const subscription of this.activeSubscriptions.filter((item) => item.exchange === this.exchange)) {
        await sink.onReconnect(subscription);
      }
    }

    if (sink.onTicker) {
      const tickers = await this.getTickerSnapshot(symbols);
      for (const ticker of tickers) await sink.onTicker(ticker);
    }

    if (sink.onOrderbook) {
      for (const symbol of symbols) {
        await sink.onOrderbook(await this.getOrderbookSnapshot(symbol));
      }
    }

    if (sink.onTrade) {
      for (const symbol of symbols) {
        const trades = await this.getRecentTrades(symbol, 20);
        for (const trade of trades.reverse()) await sink.onTrade(trade);
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
