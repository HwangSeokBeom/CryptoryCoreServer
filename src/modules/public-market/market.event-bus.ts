import { EventEmitter } from 'events';
import type {
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
  PublicMarketCollectorStatus,
} from './market.types';

type MarketEventMap = {
  ticker: NormalizedMarketTicker;
  orderbook: NormalizedMarketOrderbook;
  trade: NormalizedMarketTrade;
  status: PublicMarketCollectorStatus;
};

class MarketEventBus extends EventEmitter {
  emitTicker(data: NormalizedMarketTicker) {
    this.emit('ticker', data);
  }

  emitOrderbook(data: NormalizedMarketOrderbook) {
    this.emit('orderbook', data);
  }

  emitTrade(data: NormalizedMarketTrade) {
    this.emit('trade', data);
  }

  emitStatus(data: PublicMarketCollectorStatus) {
    this.emit('status', data);
  }

  onTicker(listener: (data: NormalizedMarketTicker) => void) {
    this.on('ticker', listener);
  }

  onOrderbook(listener: (data: NormalizedMarketOrderbook) => void) {
    this.on('orderbook', listener);
  }

  onTrade(listener: (data: NormalizedMarketTrade) => void) {
    this.on('trade', listener);
  }

  onStatus(listener: (data: PublicMarketCollectorStatus) => void) {
    this.on('status', listener);
  }

  offTyped<K extends keyof MarketEventMap>(event: K, listener: (data: MarketEventMap[K]) => void) {
    this.off(event, listener);
  }
}

export const marketEventBus = new MarketEventBus();
