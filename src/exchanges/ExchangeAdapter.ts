import { CandleData } from '../generators/candleGenerator';
import { OrderbookData } from '../generators/orderbookGenerator';

export interface NormalizedTicker {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface NormalizedOrderbook extends OrderbookData {
  currentPrice: number;
}

export type NormalizedCandle = CandleData;

export interface ExchangeAdapter {
  readonly id: string;
  readonly name: string;
  fetchTickers(symbols: string[]): Promise<NormalizedTicker[]>;
  fetchOrderbook(symbol: string, depth?: number): Promise<NormalizedOrderbook>;
  fetchCandles(symbol: string, period: string, limit?: number): Promise<NormalizedCandle[]>;
}
