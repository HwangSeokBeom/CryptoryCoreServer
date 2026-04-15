import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import type {
  CanonicalCandle,
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  StreamSubscription,
} from '../../core/exchange/exchange.types';
import type {
  ExchangeMarketDataProvider,
  ExchangeStreamingProvider,
  MarketStreamSink,
} from '../../core/exchange/provider.interfaces';
import { toCanonicalMarket, toCanonicalSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager } from '../../core/exchange/websocket.client-manager';
import { BithumbAdapter } from '../../exchanges/BithumbAdapter';
import { BaseExchangeProvider } from './base-exchange.provider';
import { safeNumber, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class BithumbProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider
{
  private readonly adapter = new BithumbAdapter();
  private streamManager: WebSocketClientManager | null = null;
  private readonly books = new Map<string, { asks: Map<number, number>; bids: Map<number, number> }>();
  private activeSubscriptions: StreamSubscription[] = [];

  constructor() {
    super('bithumb');
  }

  async listMarkets() {
    return DEFAULT_SYMBOLS.map((symbol) => ({
      symbol,
      market: `${symbol}/KRW`,
      rawSymbol: `${symbol}_KRW`,
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
}
