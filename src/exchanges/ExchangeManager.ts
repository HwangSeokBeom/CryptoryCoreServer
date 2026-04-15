import { ExchangeAdapter, NormalizedTicker } from './ExchangeAdapter';
import { UpbitAdapter } from './UpbitAdapter';
import { BithumbAdapter } from './BithumbAdapter';
import { CoinoneAdapter } from './CoinoneAdapter';
import { KorbitAdapter } from './KorbitAdapter';
import { BinanceAdapter } from './BinanceAdapter';
import { COINS } from '../config/constants';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

// sparkline: symbol:exchange → last 20 prices
const sparklines = new Map<string, number[]>();

function sparklineKey(symbol: string, exchange: string): string {
  return `${symbol}:${exchange}`;
}

export function updateSparkline(symbol: string, exchange: string, price: number): void {
  const key = sparklineKey(symbol, exchange);
  let arr = sparklines.get(key);
  if (!arr) {
    arr = [];
    sparklines.set(key, arr);
  }
  arr.push(price);
  if (arr.length > 20) arr.shift();
}

export function getSparkline(symbol: string, exchange: string): number[] {
  return sparklines.get(sparklineKey(symbol, exchange)) || [];
}

function createAdapters(): Map<string, ExchangeAdapter> {
  const map = new Map<string, ExchangeAdapter>();
  map.set('upbit', new UpbitAdapter());
  map.set('bithumb', new BithumbAdapter());
  map.set('coinone', new CoinoneAdapter());
  map.set('korbit', new KorbitAdapter());
  map.set('binance', new BinanceAdapter());
  return map;
}

const adapters = createAdapters();

export function getAdapter(exchangeId: string): ExchangeAdapter | undefined {
  return adapters.get(exchangeId);
}

export async function collectAllTickers(): Promise<Map<string, NormalizedTicker[]>> {
  const symbols = COINS.map((c) => c.symbol);
  const allTickers = new Map<string, NormalizedTicker[]>();

  const results = await Promise.allSettled(
    Array.from(adapters.entries()).map(async ([exchangeId, adapter]) => {
      const tickers = await adapter.fetchTickers(symbols);
      return { exchangeId, tickers };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const { exchangeId, tickers } = result.value;
      allTickers.set(exchangeId, tickers);
      for (const ticker of tickers) {
        const data = {
          ...ticker,
          exchange: exchangeId,
          sparkline: getSparkline(ticker.symbol, exchangeId),
        };
        await redis.set(
          `ticker:${ticker.symbol}:${exchangeId}`,
          JSON.stringify(data),
          'EX',
          5,
        );
        updateSparkline(ticker.symbol, exchangeId, ticker.price);
      }
    } else {
      logger.warn({ reason: result.reason }, 'Exchange fetch failed');
    }
  }

  return allTickers;
}

export { adapters };
