import type { OrderEntry } from '../../generators/orderbookGenerator';

export type MarketChannel = 'tickers' | 'orderbook' | 'trades' | 'candles';

export interface NormalizedMarketBase {
  exchange: string;
  marketId?: string;
  canonicalSymbol?: string;
  baseAsset?: string;
  quoteAsset?: string;
  displaySymbol?: string;
  koreanName?: string | null;
  englishName?: string | null;
  iconUrl?: string | null;
  isActive?: boolean;
  capabilities?: {
    supportsCandles: boolean;
    supportsOrderBook: boolean;
    supportsTrades: boolean;
  };
  symbol: string;
  canonicalAssetKey?: string | null;
  assetImageUrl?: string | null;
  imageUrl?: string | null;
  imageURL?: string | null;
  hasImage?: boolean;
  imageAvailability?: 'available' | 'fallback' | 'pending' | 'lookup_failed' | 'unavailable';
  imageFailureReason?: string | null;
  imageMissingReason?: string | null;
  fallbackType?: string | null;
  assetType?: string | null;
  canonicalName?: string | null;
  fallbackColor?: string | null;
  fallbackInitials?: string | null;
  assetSlug?: string | null;
  imageFallbackKey?: string | null;
  fallbackKey?: string | null;
  stableImageKey?: string | null;
  imageLookupKey?: string | null;
  imageDebug?: {
    canonicalSymbol: string;
    assetSlug: string | null;
    preferredImageSlug: string | null;
    imageResolutionSource: string | null;
    imageMissingReason: string | null;
  };
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
  executedAt: string | null;
}

export interface NormalizedMarketCandle extends NormalizedMarketBase {
  channel: 'candles';
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  asOf: number;
  confirmed: boolean;
  candleStatus: 'live' | 'stale';
  sourceEvent: 'seed' | 'trade' | 'ticker';
}

export interface PublicMarketCollectorStatus {
  exchange: string;
  connected: boolean;
  reconnectAttempts: number;
  lastConnectedAt: number | null;
  lastMessageAt: number | null;
  lastError: string | null;
  mode?: 'streaming' | 'polling';
  stale?: boolean;
  failureCount?: number;
  lastFailureAt?: number | null;
  lastFailureReason?: string | null;
  capabilities?: Partial<Record<'stream' | 'ticker' | 'orderbook' | 'trades', PublicMarketCapabilityState>>;
}

export interface PublicMarketCapabilityState {
  state:
    | 'active'
    | 'retryable'
    | 'blocked'
    | 'bad_request'
    | 'unsupported'
    | 'malformed'
    | 'upstream_error'
    | 'empty_response'
    | 'temporarily_unavailable'
    | 'rate_limited'
    | 'cancelled';
  failureCount: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastFailureReason: string | null;
  suppressedUntil: number | null;
}

export interface MarketCatalogEntry {
  exchange: string;
  exchangeName: string;
  marketId: string;
  rawSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: string;
  displaySymbol: string;
  koreanName: string | null;
  englishName: string | null;
  iconUrl: string | null;
  isActive: boolean;
  capabilities: {
    supportsCandles: boolean;
    supportsOrderBook: boolean;
    supportsTrades: boolean;
  };
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: string;
  nameKo: string;
  nameEn: string;
}
