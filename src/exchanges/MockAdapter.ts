import { ExchangeAdapter, NormalizedTicker, NormalizedOrderbook, NormalizedCandle } from './ExchangeAdapter';
import { genPrice, genChange, genVolume } from '../generators/priceGenerator';
import { genCandleData } from '../generators/candleGenerator';
import { genOrderbook } from '../generators/orderbookGenerator';
import { COIN_MAP } from '../config/constants';

export class MockAdapter implements ExchangeAdapter {
  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}

  async fetchTickers(symbols: string[]): Promise<NormalizedTicker[]> {
    return symbols.map((symbol) => {
      const coin = COIN_MAP.get(symbol);
      if (!coin) throw new Error(`Unknown symbol: ${symbol}`);
      const price = genPrice(coin.basePrice, this.id);
      const change = genChange();
      const volume = genVolume(coin.basePrice);
      return {
        symbol,
        price,
        change24h: Math.round(change * 100) / 100,
        volume24h: volume,
        high24h: price * (1 + Math.random() * 0.03),
        low24h: price * (1 - Math.random() * 0.03),
        timestamp: Date.now(),
      };
    });
  }

  async fetchOrderbook(symbol: string, depth = 10): Promise<NormalizedOrderbook> {
    const coin = COIN_MAP.get(symbol);
    if (!coin) throw new Error(`Unknown symbol: ${symbol}`);
    const price = genPrice(coin.basePrice, this.id);
    const ob = genOrderbook(price, depth);
    return { ...ob, currentPrice: price };
  }

  async fetchCandles(symbol: string, _period: string, limit = 60): Promise<NormalizedCandle[]> {
    const coin = COIN_MAP.get(symbol);
    if (!coin) throw new Error(`Unknown symbol: ${symbol}`);
    const price = genPrice(coin.basePrice, this.id);
    return genCandleData(price, limit);
  }
}
