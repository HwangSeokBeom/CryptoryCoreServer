import { COINS, EXCHANGES } from '../../config/constants';
import { getAdapter, getSparkline } from '../../exchanges/ExchangeManager';
import { publicMarketDataStore } from '../public-market/market.data.store';
import { toUnifiedSymbol } from '../public-market/market.normalization';

export interface TickerResponse {
  symbol: string;
  exchange: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  sparkline: number[];
  timestamp: number;
}

export async function getTickersByExchange(exchangeId: string): Promise<TickerResponse[]> {
  const exchange = EXCHANGES.find((e) => e.id === exchangeId);
  if (!exchange) return [];

  const cached = publicMarketDataStore.getTickers(exchangeId);
  if (cached.length > 0) {
    return cached.map((ticker) => ({
      symbol: ticker.symbol,
      exchange: exchangeId,
      price: ticker.price,
      change24h: ticker.change24h,
      volume24h: ticker.volume24h,
      high24h: ticker.high24h,
      low24h: ticker.low24h,
      sparkline: getSparkline(ticker.symbol, exchangeId),
      timestamp: ticker.timestamp,
    }));
  }

  const adapter = getAdapter(exchangeId);
  if (!adapter) return [];

  const tickers = await adapter.fetchTickers(COINS.map((coin) => coin.symbol));
  return tickers.map((result) => ({
    symbol: result.symbol,
    exchange: exchangeId,
    price: result.price,
    change24h: result.change24h,
    volume24h: result.volume24h,
    high24h: result.high24h,
    low24h: result.low24h,
    sparkline: getSparkline(result.symbol, exchangeId),
    timestamp: result.timestamp,
  }));
}

export async function getCurrentPrice(symbol: string, exchangeId: string): Promise<number> {
  const unifiedSymbol = toUnifiedSymbol(symbol);
  const cached = publicMarketDataStore.getTicker(exchangeId, unifiedSymbol);
  if (cached) {
    return cached.price;
  }

  const adapter = getAdapter(exchangeId);
  if (!adapter) return 0;

  try {
    const [result] = await adapter.fetchTickers([unifiedSymbol]);
    return result?.price ?? 0;
  } catch {
    return 0;
  }
}
