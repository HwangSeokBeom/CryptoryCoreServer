import type { OrderEntry } from '../../generators/orderbookGenerator';

export type MarketChannel = 'tickers' | 'orderbook' | 'trades';

export interface NormalizedMarketBase {
  exchange: string;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: string;
  rawSymbol: string;
  timestamp: number;
}

export interface NormalizedMarketTicker extends NormalizedMarketBase {
  channel: 'tickers';
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
}

export interface NormalizedMarketOrderbook extends NormalizedMarketBase {
  channel: 'orderbook';
  asks: OrderEntry[];
  bids: OrderEntry[];
  bestAsk: number;
  bestBid: number;
}

export interface NormalizedMarketTrade extends NormalizedMarketBase {
  channel: 'trades';
  tradeId: string;
  price: number;
  quantity: number;
  side: 'buy' | 'sell';
}

export interface PublicMarketCollectorStatus {
  exchange: string;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
}

export interface MarketCatalogEntry {
  exchange: string;
  exchangeName: string;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: string;
  nameKo: string;
  nameEn: string;
  rawSymbol: string;
}
