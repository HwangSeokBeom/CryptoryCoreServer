import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { JwtHmacSigner } from '../../core/exchange/auth/jwt-hmac.signer';
import { ExchangeUnsupportedSymbolError } from '../../core/exchange/errors';
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
import { BithumbAdapter } from '../../exchanges/BithumbAdapter';
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
const TICKER_CACHE_TTL_MS = 1_000;
const TICKER_STALE_TTL_MS = 20_000;

function normalizeRequestedSymbols(symbols?: string[]) {
  return Array.from(new Set((symbols ?? []).map(toCanonicalSymbol)));
}

function toSortedSymbols(symbols: Iterable<string>) {
  return Array.from(new Set(symbols)).sort((left, right) => left.localeCompare(right));
}

export class BithumbProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, ExchangeTradingProvider, ExchangePortfolioProvider
{
  private readonly adapter = new BithumbAdapter();
  private readonly signer = new JwtHmacSigner();
  private streamManager: WebSocketClientManager | null = null;
  private readonly books = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();
  private activeSubscriptions: StreamSubscription[] = [];
  private supportedStreamSymbols = new Set<string>();
  private readonly capabilityExcludedSymbols = {
    orderbook: new Map<string, string>(),
    trades: new Map<string, string>(),
    candles: new Map<string, string>(),
  };

  constructor() {
    super('bithumb');
  }

  async listMarkets() {
    return this.withRequestCache({
      operation: 'markets',
      key: 'krw',
      ttlMs: MARKET_CACHE_TTL_MS,
      staleTtlMs: MARKET_STALE_TTL_MS,
      loader: async () => {
        const response = await this.restClient.request<Array<{
          market: string;
          korean_name?: string | null;
          english_name?: string | null;
        }>>('/v1/market/all', {
          query: { isDetails: true },
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
              koreanName: item.korean_name ?? null,
              englishName: item.english_name ?? null,
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
        orderbook: marketUniverse.filter((symbol) => !this.capabilityExcludedSymbols.orderbook.has(symbol)),
        trades: marketUniverse.filter((symbol) => !this.capabilityExcludedSymbols.trades.has(symbol)),
        candles: marketUniverse.filter((symbol) => !this.capabilityExcludedSymbols.candles.has(symbol)),
      },
      capabilityExcludedSymbols: {
        orderbook: toSortedSymbols(this.capabilityExcludedSymbols.orderbook.keys()).map((symbol) => ({
          symbol,
          reason: this.capabilityExcludedSymbols.orderbook.get(symbol) ?? 'capability_not_supported',
        })),
        trades: toSortedSymbols(this.capabilityExcludedSymbols.trades.keys()).map((symbol) => ({
          symbol,
          reason: this.capabilityExcludedSymbols.trades.get(symbol) ?? 'capability_not_supported',
        })),
        candles: toSortedSymbols(this.capabilityExcludedSymbols.candles.keys()).map((symbol) => ({
          symbol,
          reason: this.capabilityExcludedSymbols.candles.get(symbol) ?? 'capability_not_supported',
        })),
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
    try {
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
    } catch (error) {
      this.noteCapabilitySymbolUnsupported('orderbook', canonical, error);
      throw error;
    }
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<CanonicalTrade[]> {
    const canonical = toCanonicalSymbol(symbol);
    try {
      const response = await this.restClient.request<any>(`/public/transaction_history/${canonical}_KRW`, {
        query: { count: limit },
      });
      const trades = response.data ?? [];
      const market = toCanonicalMarket(this.exchange, canonical);

      return trades.map((trade: any) => {
        const price = safeNumber(trade.price ?? trade.contPrice);
        const quantity = safeNumber(trade.units_traded ?? trade.contQty);
        const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
          [trade.contDtm, trade.transaction_date, trade.datetime],
          { assumeTimezone: 'KST' },
        );
        if (normalizedTimestamp.timestamp === null) {
          logger.warn(
            { domain: 'market-routes', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
            `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
          );
        }
        return {
          ...market,
          tradeId: String(trade.transaction_date ?? `${canonical}:${price}:${quantity}`),
          side: String(trade.type ?? '').toLowerCase() === 'ask' ? 'sell' : 'buy',
          price,
          quantity,
          notional: price * quantity,
          timestamp: normalizedTimestamp.timestamp,
          executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
        };
      });
    } catch (error) {
      this.noteCapabilitySymbolUnsupported('trades', canonical, error);
      throw error;
    }
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
        'Skipping Bithumb public stream start because no symbols resolved',
      );
      return;
    }

    this.streamManager = new WebSocketClientManager({
      name: 'bithumb-public',
      url: getExchangeConfig(this.exchange).publicWebSocketUrl,
      onOpen: async (ctx) => {
        const plan = await this.buildActiveStreamPlan();
        const tickerSymbols = plan.resolvedByChannel.tickers.map((symbol) => toExchangeSymbol(this.exchange, symbol));
        const orderbookSymbols = plan.resolvedByChannel.orderbook.map((symbol) => toExchangeSymbol(this.exchange, symbol));
        const tradeSymbols = plan.resolvedByChannel.trades.map((symbol) => toExchangeSymbol(this.exchange, symbol));

        if (tickerSymbols.length > 0) {
          ctx.sendJson({ type: 'ticker', symbols: tickerSymbols, tickTypes: ['24H'], isOnlyRealtime: true });
        }
        if (orderbookSymbols.length > 0) {
          ctx.sendJson({ type: 'orderbooksnapshot', symbols: orderbookSymbols });
          ctx.sendJson({ type: 'orderbookdepth', symbols: orderbookSymbols, isOnlyRealtime: true });
        }
        if (tradeSymbols.length > 0) {
          ctx.sendJson({ type: 'transaction', symbols: tradeSymbols, isOnlyRealtime: true });
        }
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
            const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
              [trade.contDtm, trade.transaction_date, trade.datetime, content.datetime],
              { assumeTimezone: 'KST' },
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
              tradeId: String(trade.contNo ?? trade.transaction_date ?? `${symbol}:${normalizedTimestamp.timestamp}`),
              side: String(trade.buySellGb ?? '') === '1' ? 'sell' : 'buy',
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
      capabilityExclusionsByChannel: {
        orderbook: this.capabilityExcludedSymbols.orderbook,
        trades: this.capabilityExcludedSymbols.trades,
        candles: this.capabilityExcludedSymbols.candles,
      },
    });
  }

  private logStreamPlan(
    phase: 'start' | 'initial' | 'reconnect',
    plan: Awaited<ReturnType<BithumbProvider['buildActiveStreamPlan']>>,
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
      phase === 'start' ? 'Prepared Bithumb public stream plan' : 'Prepared Bithumb public resync plan',
    );
  }

  private noteCapabilitySymbolUnsupported(
    channel: 'orderbook' | 'trades' | 'candles',
    symbol: string,
    error: unknown,
  ) {
    if (!(error instanceof ExchangeUnsupportedSymbolError)) {
      return;
    }

    this.capabilityExcludedSymbols[channel].set(symbol, error.message);
    logger.warn(
      {
        domain: 'market-streaming',
        exchange: this.exchange,
        capability: channel,
        symbol,
        reason: error.message,
      },
      'Bithumb capability symbol downgraded to unsupported',
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
            'Bithumb reconnect notification failed',
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

    if (sink.onOrderbook && plan.resolvedByChannel.orderbook.length > 0) {
      for (const symbol of plan.resolvedByChannel.orderbook) {
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
    return requireCredentials(this.exchange, context);
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
