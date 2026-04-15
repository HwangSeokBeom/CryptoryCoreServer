import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
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
  GlobalReferencePriceSource,
  MarketStreamSink,
} from '../../core/exchange/provider.interfaces';
import { toCanonicalMarket, toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager } from '../../core/exchange/websocket.client-manager';
import { BaseExchangeProvider } from './base-exchange.provider';
import { safeNumber, sortAsks, sortBids } from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);

export class BinanceProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, GlobalReferencePriceSource
{
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];

  constructor() {
    super('binance');
  }

  async listMarkets() {
    const response = await this.restClient.request<any>('/api/v3/exchangeInfo');
    return (response.symbols ?? [])
      .filter((item: any) => String(item.quoteAsset ?? '').toUpperCase() === 'USDT')
      .map((item: any) => ({
        symbol: String(item.baseAsset).toUpperCase(),
        market: `${String(item.baseAsset).toUpperCase()}/USDT`,
        rawSymbol: String(item.symbol),
      }));
  }

  async getTickerSnapshot(symbols = DEFAULT_SYMBOLS): Promise<CanonicalTickerSnapshot[]> {
    const requestSymbols = symbols.map((symbol) => toExchangeSymbol(this.exchange, symbol));
    const response = await this.restClient.request<any[]>('/api/v3/ticker/24hr', {
      query: {
        symbols: JSON.stringify(requestSymbols),
      },
    });

    return response.map((ticker) => ({
      ...toCanonicalMarket(this.exchange, String(ticker.symbol).replace(/USDT$/i, '')),
      price: safeNumber(ticker.lastPrice),
      change24h: safeNumber(ticker.priceChangePercent),
      volume24h: safeNumber(ticker.quoteVolume),
      high24h: safeNumber(ticker.highPrice),
      low24h: safeNumber(ticker.lowPrice),
      timestamp: Date.now(),
    }));
  }

  async getReferenceTicker(symbol: string): Promise<CanonicalTickerSnapshot | null> {
    const [ticker] = await this.getTickerSnapshot([symbol]);
    return ticker ?? null;
  }

  async getOrderbookSnapshot(symbol: string, depth = 15): Promise<CanonicalOrderbookSnapshot> {
    const canonical = toCanonicalSymbol(symbol);
    const market = toCanonicalMarket(this.exchange, canonical);
    const response = await this.restClient.request<any>('/api/v3/depth', {
      query: {
        symbol: toExchangeSymbol(this.exchange, canonical),
        limit: Math.min(depth, 1000),
      },
    });
    const asks = sortAsks(
      (response.asks ?? []).map((ask: any) => ({
        price: safeNumber(ask[0]),
        quantity: safeNumber(ask[1]),
      })),
      depth,
    );
    const bids = sortBids(
      (response.bids ?? []).map((bid: any) => ({
        price: safeNumber(bid[0]),
        quantity: safeNumber(bid[1]),
      })),
      depth,
    );

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
    const response = await this.restClient.request<any[]>('/api/v3/trades', {
      query: {
        symbol: rawSymbol,
        limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return response.map((trade) => {
      const price = safeNumber(trade.price);
      const quantity = safeNumber(trade.qty);
      return {
        ...market,
        tradeId: String(trade.id),
        side: trade.isBuyerMaker ? 'sell' : 'buy',
        price,
        quantity,
        notional: price * quantity,
        timestamp: safeNumber(trade.time),
      };
    });
  }

  async getCandles(symbol: string, interval: string, limit = 60): Promise<CanonicalCandle[]> {
    const canonical = toCanonicalSymbol(symbol);
    const resolved = resolveExchangeInterval(this.exchange, interval);
    if (!resolved) {
      return [];
    }
    const candles = await this.restClient.request<any[]>('/api/v3/klines', {
      query: {
        symbol: toExchangeSymbol(this.exchange, canonical),
        interval: resolved.exchangeInterval,
        limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return candles.map((candle) => ({
      ...market,
      interval: resolved.resolvedInterval,
      openTime: safeNumber(candle[0]),
      closeTime: safeNumber(candle[6]),
      open: safeNumber(candle[1]),
      high: safeNumber(candle[2]),
      low: safeNumber(candle[3]),
      close: safeNumber(candle[4]),
      volume: safeNumber(candle[5]),
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

    const streams = symbols.flatMap((symbol) => {
      const pair = `${symbol.toLowerCase()}usdt`;
      return [`${pair}@ticker`, `${pair}@depth20@100ms`, `${pair}@trade`];
    });
    this.streamManager = new WebSocketClientManager({
      name: 'binance-public',
      url: `${getExchangeConfig(this.exchange).publicWebSocketUrl}?streams=${streams.join('/')}`,
      onOpen: async () => {},
      onMessage: async (raw) => {
        const payload = JSON.parse(raw.toString());
        const wrapped = payload.data ?? payload;
        const stream = String(payload.stream ?? '');
        const streamSymbol = stream.split('@')[0]?.toUpperCase();
        const rawSymbol = String(wrapped.s ?? streamSymbol ?? '');
        const symbol = toCanonicalSymbol(rawSymbol.replace(/USDT$/i, ''));
        const market = toCanonicalMarket(this.exchange, symbol);
        const timestamp = safeNumber(wrapped.E ?? wrapped.T ?? Date.now());
        const type = wrapped.e ?? (stream.includes('@depth') ? 'depth' : '');

        if (type === '24hrTicker' && sink.onTicker) {
          await sink.onTicker({
            ...market,
            price: safeNumber(wrapped.c),
            change24h: safeNumber(wrapped.P),
            volume24h: safeNumber(wrapped.q),
            high24h: safeNumber(wrapped.h),
            low24h: safeNumber(wrapped.l),
            timestamp,
          });
          return;
        }

        if (type === 'depth' && sink.onOrderbook) {
          const asks = sortAsks(
            (wrapped.asks ?? []).map((ask: any) => ({
              price: safeNumber(ask[0]),
              quantity: safeNumber(ask[1]),
            })),
          );
          const bids = sortBids(
            (wrapped.bids ?? []).map((bid: any) => ({
              price: safeNumber(bid[0]),
              quantity: safeNumber(bid[1]),
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

        if ((type === 'trade' || type === 'aggTrade') && sink.onTrade) {
          const price = safeNumber(wrapped.p);
          const quantity = safeNumber(wrapped.q);
          await sink.onTrade({
            ...market,
            tradeId: String(wrapped.t ?? wrapped.a ?? `${rawSymbol}:${timestamp}`),
            side: wrapped.m ? 'sell' : 'buy',
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
