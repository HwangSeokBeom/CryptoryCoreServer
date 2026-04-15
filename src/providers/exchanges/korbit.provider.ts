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
import { KorbitAdapter } from '../../exchanges/KorbitAdapter';
import { BaseExchangeProvider } from './base-exchange.provider';
import { safeNumber, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class KorbitProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider
{
  private readonly adapter = new KorbitAdapter();
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];

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
    const pair = `${canonical.toLowerCase()}_krw`;
    const response = await this.restClient.request<any[]>('/v1/transactions', {
      query: {
        currency_pair: pair,
        limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return response.map((trade: any) => {
      const price = safeNumber(trade.price);
      const quantity = safeNumber(trade.amount ?? trade.qty);
      return {
        ...market,
        tradeId: String(trade.id ?? `${pair}:${trade.timestamp}`),
        side: String(trade.taker ?? trade.side ?? '').toLowerCase() === 'buy' ? 'buy' : 'sell',
        price,
        quantity,
        notional: price * quantity,
        timestamp: safeNumber(trade.timestamp ?? Date.now()),
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
