import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import type { CanonicalOrderbookSnapshot, CanonicalTickerSnapshot, CanonicalTrade, ExchangeId, StreamSubscription } from '../../core/exchange/exchange.types';
import { COINS } from '../../config/constants';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import { marketEventBus } from '../../modules/public-market/market.event-bus';
import { logger } from '../../utils/logger';

const STREAM_EXCHANGES: ExchangeId[] = ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'];

function persistTicker(ticker: CanonicalTickerSnapshot) {
  publicMarketDataStore.upsertTicker({
    channel: 'tickers',
    exchange: ticker.exchange,
    symbol: ticker.symbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  });
  marketEventBus.emitTicker({
    channel: 'tickers',
    exchange: ticker.exchange,
    symbol: ticker.symbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  });
}

function persistOrderbook(orderbook: CanonicalOrderbookSnapshot) {
  publicMarketDataStore.upsertOrderbook({
    channel: 'orderbook',
    exchange: orderbook.exchange,
    symbol: orderbook.symbol,
    market: orderbook.market,
    baseCurrency: orderbook.baseCurrency,
    quoteCurrency: orderbook.quoteCurrency,
    rawSymbol: orderbook.rawSymbol,
    asks: orderbook.asks.map((level) => ({ price: level.price, qty: level.quantity })),
    bids: orderbook.bids.map((level) => ({ price: level.price, qty: level.quantity })),
    bestAsk: orderbook.bestAsk,
    bestBid: orderbook.bestBid,
    timestamp: orderbook.timestamp,
  });
  marketEventBus.emitOrderbook({
    channel: 'orderbook',
    exchange: orderbook.exchange,
    symbol: orderbook.symbol,
    market: orderbook.market,
    baseCurrency: orderbook.baseCurrency,
    quoteCurrency: orderbook.quoteCurrency,
    rawSymbol: orderbook.rawSymbol,
    asks: orderbook.asks.map((level) => ({ price: level.price, qty: level.quantity })),
    bids: orderbook.bids.map((level) => ({ price: level.price, qty: level.quantity })),
    bestAsk: orderbook.bestAsk,
    bestBid: orderbook.bestBid,
    timestamp: orderbook.timestamp,
  });
}

function persistTrade(trade: CanonicalTrade) {
  publicMarketDataStore.appendTrade({
    channel: 'trades',
    exchange: trade.exchange,
    symbol: trade.symbol,
    market: trade.market,
    baseCurrency: trade.baseCurrency,
    quoteCurrency: trade.quoteCurrency,
    rawSymbol: trade.rawSymbol,
    tradeId: trade.tradeId,
    price: trade.price,
    quantity: trade.quantity,
    side: trade.side,
    timestamp: trade.timestamp,
  });
  marketEventBus.emitTrade({
    channel: 'trades',
    exchange: trade.exchange,
    symbol: trade.symbol,
    market: trade.market,
    baseCurrency: trade.baseCurrency,
    quoteCurrency: trade.quoteCurrency,
    rawSymbol: trade.rawSymbol,
    tradeId: trade.tradeId,
    price: trade.price,
    quantity: trade.quantity,
    side: trade.side,
    timestamp: trade.timestamp,
  });
}

class MarketStreamingOrchestrator {
  private started = false;

  async start() {
    if (this.started) return;
    this.started = true;

    const subscriptions: StreamSubscription[] = STREAM_EXCHANGES.map((exchange) => ({
      exchange,
      channel: 'tickers',
      symbols: COINS.map((coin) => coin.symbol),
    }));

    await Promise.all(
      STREAM_EXCHANGES.map(async (exchange) => {
        try {
          const provider = exchangeProviderRegistry.getStreamingProvider(exchange);
          await provider.startPublicStream(subscriptions, {
            onTicker: persistTicker,
            onOrderbook: persistOrderbook,
            onTrade: persistTrade,
            onReconnect: async (subscription) => {
              logger.info(
                { domain: 'market-streaming', exchange: subscription.exchange, channel: subscription.channel },
                'Resyncing public market snapshot after reconnect',
              );
            },
          });
        } catch (error) {
          logger.error({ domain: 'market-streaming', exchange, err: error }, 'Failed to start public market stream');
        }
      }),
    );
  }

  async stop() {
    if (!this.started) return;
    this.started = false;

    await Promise.all(
      STREAM_EXCHANGES.map(async (exchange) => {
        try {
          const provider = exchangeProviderRegistry.getStreamingProvider(exchange);
          await provider.stopPublicStream();
        } catch (error) {
          logger.warn({ domain: 'market-streaming', exchange, err: error }, 'Failed to stop public market stream');
        }
      }),
    );
  }
}

export const marketStreamingOrchestrator = new MarketStreamingOrchestrator();
