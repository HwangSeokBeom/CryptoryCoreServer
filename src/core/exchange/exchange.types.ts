export const EXCHANGE_IDS = ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];
export const DOMESTIC_EXCHANGE_IDS = ['upbit', 'bithumb', 'coinone', 'korbit'] as const;
export type DomesticExchangeId = (typeof DOMESTIC_EXCHANGE_IDS)[number];

export const QUOTE_CURRENCIES = ['KRW', 'USDT'] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];
export type MarketDataMode = 'streaming' | 'snapshot' | 'cached_snapshot';

export const EXCHANGE_CAPABILITIES = [
  'market:list',
  'market:ticker',
  'market:orderbook',
  'market:trades',
  'market:candles',
  'stream:public:ticker',
  'stream:public:orderbook',
  'stream:public:trades',
  'stream:public:candles',
  'trading:order-chance',
  'trading:create-order',
  'trading:cancel-order',
  'trading:get-order',
  'trading:list-open-orders',
  'trading:list-fills',
  'stream:private:orders',
  'portfolio:balances',
  'portfolio:positions',
  'portfolio:history',
  'stream:private:assets',
] as const;
export type ExchangeCapability = (typeof EXCHANGE_CAPABILITIES)[number];

export interface ExchangeMetadata {
  id: ExchangeId;
  displayName: string;
  quoteCurrency: QuoteCurrency;
  domestic: boolean;
  restBaseUrl: string;
  publicRestBaseUrl?: string;
  privateRestBaseUrl?: string;
  publicWebSocketUrl: string;
  privateWebSocketUrl?: string;
  referenceOnly?: boolean;
  capabilities: ExchangeCapability[];
}

export interface CanonicalMarket {
  exchange: ExchangeId;
  marketId: string;
  canonicalMarketId: string;
  rawSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: QuoteCurrency;
  displaySymbol: string;
  koreanName: string | null;
  englishName: string | null;
  iconUrl: string | null;
  isActive: boolean;
  capabilities: CanonicalMarketCapabilities;
  candlesSupported: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  nameKo?: string;
  nameEn?: string;
}

export interface CanonicalMarketCapabilities {
  supportsCandles: boolean;
  supportsOrderBook: boolean;
  supportsTrades: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
}

export interface CanonicalMarketMetadata {
  exchange: ExchangeId;
  marketId: string;
  canonicalMarketId: string;
  rawSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: QuoteCurrency;
  displaySymbol: string;
  koreanName: string | null;
  englishName: string | null;
  iconUrl: string | null;
  isActive: boolean;
  capabilities: CanonicalMarketCapabilities;
  candlesSupported: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
}

export interface CanonicalTickerSnapshot extends CanonicalMarket {
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface CanonicalOrderbookLevel {
  price: number;
  quantity: number;
}

export interface CanonicalOrderbookSnapshot extends CanonicalMarket {
  asks: CanonicalOrderbookLevel[];
  bids: CanonicalOrderbookLevel[];
  bestAsk: number;
  bestBid: number;
  spread: number;
  timestamp: number;
}

export type TradeSide = 'buy' | 'sell';

export interface CanonicalTrade extends CanonicalMarket {
  tradeId: string;
  side: TradeSide;
  price: number;
  quantity: number;
  notional: number;
  timestamp: number | null;
  executedAt: string | null;
}

export interface CanonicalCandle extends CanonicalMarket {
  interval: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketStreamChannel = 'tickers' | 'orderbook' | 'trades' | 'candles';

export interface MarketStreamEventMap {
  tickers: CanonicalTickerSnapshot;
  orderbook: CanonicalOrderbookSnapshot;
  trades: CanonicalTrade;
  candles: CanonicalCandle;
}

export interface OrderChance {
  exchange: ExchangeId;
  market: string;
  symbol: string;
  quoteCurrency: QuoteCurrency;
  availableKRW?: number;
  availableQuote?: number;
  availableBaseAsset?: number;
  baseAsset?: string;
  minTotal?: number;
  minQuantity?: number;
  maxQuantity?: number;
  maxTotal?: number;
  makerFee?: number;
  takerFee?: number;
  supportedOrderTypes: string[];
  fees?: {
    maker?: number;
    taker?: number;
  };
  precision?: {
    priceUnit?: number;
    quantityUnit?: number;
  };
  limits?: {
    minTotal?: number;
    minQuantity?: number;
    maxQuantity?: number;
    maxTotal?: number;
  };
  orderable?: {
    buy: boolean;
    sell: boolean;
    limit: boolean;
    market: boolean;
  };
}

export type CanonicalOrderSide = 'buy' | 'sell';
export type CanonicalOrderType = 'market' | 'limit' | 'stop_limit';
export type CanonicalOrderStatus =
  | 'pending'
  | 'open'
  | 'partial'
  | 'filled'
  | 'cancelled'
  | 'rejected';

export interface CreateOrderRequest {
  exchange: ExchangeId;
  symbol: string;
  side: CanonicalOrderSide;
  type: CanonicalOrderType;
  quantity: number;
  price?: number;
  clientOrderId?: string;
}

export interface CancelOrderRequest {
  exchange: ExchangeId;
  orderId: string;
  symbol?: string;
}

export interface CanonicalOrder {
  exchange: ExchangeId;
  orderId: string;
  symbol: string;
  market: string;
  side: CanonicalOrderSide;
  type: CanonicalOrderType;
  status: CanonicalOrderStatus;
  price: number;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  averageFillPrice?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CanonicalFill {
  exchange: ExchangeId;
  fillId: string;
  orderId: string;
  symbol: string;
  market: string;
  side: CanonicalOrderSide;
  price: number;
  quantity: number;
  fee?: number;
  feeCurrency?: string;
  timestamp: number;
}

export interface Balance {
  asset: string;
  free: number;
  locked: number;
  averageBuyPrice?: number;
}

export interface PortfolioPosition {
  exchange: ExchangeId;
  symbol: string;
  quantity: number;
  free: number;
  locked: number;
  averageBuyPrice: number;
  currentPrice: number;
  marketValue: number;
  pnlValue: number;
  pnlPercent: number;
  timestamp: number;
}

export interface PortfolioSnapshot {
  exchange: ExchangeId;
  balances: Balance[];
  positions: PortfolioPosition[];
  totalAssetValue: number;
  totalPnlValue: number;
  totalPnlPercent: number;
  timestamp: number;
}

export type AssetHistoryEventType = 'deposit' | 'withdrawal' | 'trade' | 'transfer' | 'airdrop' | 'fee' | 'adjustment';
export type AssetHistorySourceType =
  | 'fill'
  | 'deposit'
  | 'withdrawal'
  | 'transfer'
  | 'airdrop'
  | 'fee'
  | 'adjustment'
  | 'mock'
  | 'seed'
  | 'sample'
  | 'synthetic_snapshot'
  | 'snapshot_diff'
  | 'unknown';

export interface AssetHistoryRecord {
  id?: string;
  exchange: ExchangeId;
  assetSymbol?: string;
  symbol?: string;
  eventType?: AssetHistoryEventType;
  type: AssetHistoryEventType;
  amount: number;
  price?: number | null;
  balanceAfter?: number;
  occurredAt?: string | null;
  timestamp: number;
  description?: string;
  source?: string | null;
  sourceType?: AssetHistorySourceType;
  isSynthetic?: boolean;
  isVerifiedUserEvent?: boolean;
  orderId?: string;
}

export interface UserExchangeCredentials {
  exchange: ExchangeId;
  apiKey: string;
  secretKey: string;
  passphrase?: string | null;
}

export interface ProviderHealthStatus {
  exchange: ExchangeId | 'fx';
  healthy: boolean;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  message?: string | null;
}

export interface FxRate {
  pair: 'USD/KRW';
  rate: number;
  timestamp: number;
  staleAt: number;
  provider: string;
}

export interface FreshnessMetadata {
  dataMode: MarketDataMode;
  isStale: boolean;
  lastUpdatedAt: number | null;
  sourceTimestamp: number | null;
  cacheAgeMs: number | null;
}

export type SnapshotSource = 'snapshot' | 'cache' | 'derived' | 'fallback' | 'mixed';
export type SnapshotOverallStatus = 'success' | 'partial_success' | 'failure';
export type SnapshotItemStatus = 'success' | 'partial' | 'error' | 'stale';
export type SnapshotErrorCode =
  | 'UNSUPPORTED_SYMBOL'
  | 'SYMBOL_MAPPING_NOT_FOUND'
  | 'EXCHANGE_TEMPORARILY_UNAVAILABLE'
  | 'FX_RATE_UNAVAILABLE'
  | 'PARTIAL_DATA'
  | 'SNAPSHOT_STALE'
  | 'ALL_PROVIDERS_FAILED';

export interface SnapshotPartialFailure {
  code: SnapshotErrorCode;
  message: string;
  symbol?: string;
  exchange?: ExchangeId | 'fx';
  stage?: string;
  source?: SnapshotSource;
  retryable?: boolean;
}

export type KimchiPremiumRowStatus = 'loaded' | 'partial' | 'unavailable' | 'failed' | 'stale';
export type KimchiPremiumFreshnessState = 'fresh' | 'slightly_stale' | 'stale' | 'partial' | 'unavailable';
export type KimchiPremiumSparklineStatus = 'ok' | 'insufficientData' | 'empty';
export type KimchiPremiumStatusReason =
  | 'READY'
  | 'DOMESTIC_MARKET_MISSING'
  | 'DOMESTIC_TICKER_MISSING'
  | 'BINANCE_REFERENCE_MISSING'
  | 'FX_RATE_UNAVAILABLE'
  | 'PREMIUM_DATA_INCOMPLETE'
  | 'STALE_SNAPSHOT'
  | 'UNKNOWN';
export type KimchiPremiumFailureStage = 'reference_ticker' | 'domestic_ticker' | 'fx_rate' | 'premium_compute' | 'settlement';
export type KimchiPremiumDelayBucket = 'none' | 'slight' | 'moderate' | 'severe';
export type KimchiPremiumDisplayHint = 'keep_last_good' | 'loading_initial' | 'unavailable_cold';
export type KimchiPremiumStableStatus = 'ready' | 'stale' | 'partial' | 'unavailable';

export interface KimchiPremiumQuote {
  exchange: ExchangeId;
  market: string;
  priceKrw: number;
  premiumPercent: number | null;
  timestamp: number;
  sourceExchange: ExchangeId;
  sourceTimestamp: number;
  stale: boolean;
  staleAgeMs: number;
  krwConvertedReference: number | null;
  reason?: string | null;
}

export interface KimchiPremiumEntry {
  symbol: string;
  nameKo: string;
  nameEn: string;
  quoteCurrency: 'KRW';
  status: KimchiPremiumRowStatus;
  statusReason: KimchiPremiumStatusReason;
  domesticVenue: DomesticExchangeId;
  missingFields: string[];
  failureStage: KimchiPremiumFailureStage | null;
  referenceExchange: ExchangeId | null;
  referenceMarket: string | null;
  referenceTimestamp: number | null;
  referenceStale: boolean;
  referenceStaleAgeMs: number | null;
  binancePrice: number | null;
  binanceUsdtPrice: number | null;
  usdKrwRate: number | null;
  binanceKrwPrice: number | null;
  krwConvertedReference: number | null;
  domesticExchange: DomesticExchangeId;
  domesticMarket: string | null;
  domesticPrice: number | null;
  domesticPriceKRW: number | null;
  premiumPercent: number | null;
  premiumAmountKRW: number | null;
  selectedExchange: DomesticExchangeId;
  sourceExchange: DomesticExchangeId | null;
  domesticPriceTimestamp: number | null;
  globalPriceTimestamp: number | null;
  fxRateTimestamp: number | null;
  computedAt: number;
  freshnessState: KimchiPremiumFreshnessState;
  freshnessReason: string | null;
  displayMeta?: {
    status: KimchiPremiumStableStatus;
    hasUsableDomesticPrice: boolean;
    hasUsableReferencePrice: boolean;
    hasUsableFxRate: boolean;
    lastSuccessfulDomesticAt: number | null;
    lastSuccessfulReferenceAt: number | null;
    lastSuccessfulFxAt: number | null;
    delayBucket: KimchiPremiumDelayBucket;
    displayHint: KimchiPremiumDisplayHint;
  };
  stableStatus?: KimchiPremiumStableStatus;
  hasUsableDomesticPrice?: boolean;
  hasUsableReferencePrice?: boolean;
  hasUsableFxRate?: boolean;
  lastSuccessfulDomesticAt?: number | null;
  lastSuccessfulReferenceAt?: number | null;
  lastSuccessfulFxAt?: number | null;
  delayBucket?: KimchiPremiumDelayBucket;
  displayHint?: KimchiPremiumDisplayHint;
  fxProvider: string | null;
  fxTimestamp: number | null;
  fxStale: boolean;
  fxStaleAgeMs: number | null;
  globalPrice: number | null;
  fxRate: number | null;
  convertedGlobalPriceKRW: number | null;
  domestic: KimchiPremiumQuote[];
  sparkline: number[];
  sparklinePoints: Array<{ price: number; timestamp: number; premiumPercent?: number }>;
  sparklineSource: 'history' | 'current_sample' | 'unavailable';
  sparklineValueType: 'premium_percent';
  sparklineStatus: KimchiPremiumSparklineStatus;
  sparklinePointCount: number;
  pointCount: number;
  rangeMin: number | null;
  rangeMax: number | null;
  sparklineLastUpdatedAt: number | null;
  sourceTimestamps: {
    reference: number | null;
    domestic: number | null;
    fx: number | null;
  };
  dataMode: MarketDataMode;
  isStale: boolean;
  updatedAt: number | null;
  lastUpdatedAt: number | null;
  sourceTimestamp: number | null;
  cacheAgeMs: number | null;
  stale: boolean;
  timestampSkewMs: number | null;
  asOf?: number | null;
  freshnessMs?: number | null;
  source?: Exclude<SnapshotSource, 'mixed'>;
  errorCode?: SnapshotErrorCode | null;
  errorMessage?: string | null;
}

export interface MarketSymbolSupportEntry {
  exchange: ExchangeId;
  marketId: string;
  canonicalMarketId: string;
  rawSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: QuoteCurrency;
  displaySymbol: string;
  koreanName: string | null;
  englishName: string | null;
  iconUrl: string | null;
  isActive: boolean;
  capabilities: CanonicalMarketCapabilities;
  candlesSupported: boolean;
  graphSupported: boolean;
  supportedIntervals: string[];
  unsupportedReason: string | null;
  symbol: string;
  canonicalAssetKey?: string | null;
  assetImageUrl?: string | null;
  imageAvailability?: 'available' | 'fallback' | 'pending' | 'lookup_failed' | 'unavailable';
  imageFailureReason?: string | null;
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
  imageMissingReason?: string | null;
  assetSupportStatus?: 'supported' | 'metadata_pending' | 'unsupported';
  exchangeSymbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  tradable: boolean;
  kimchiComparable: boolean;
  kimchiComparisonReason:
    | 'COMPARABLE'
    | 'DOMESTIC_ONLY'
    | 'BINANCE_REFERENCE_MISSING'
    | 'QUOTE_NOT_SUPPORTED';
}

export interface ExchangeMarketDescriptor {
  symbol: string;
  exchangeSymbol: string;
  marketId?: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  rawSymbol: string;
  tradable: boolean;
  koreanName?: string | null;
  englishName?: string | null;
}

export type MarketCapabilityChannel = 'tickers' | 'orderbook' | 'trades' | 'candles';

export type MarketCapabilitySnapshot = {
  websocketTickerSymbols: string[];
  capabilitySymbols: Partial<Record<MarketCapabilityChannel, string[]>>;
  capabilityExcludedSymbols?: Partial<Record<MarketCapabilityChannel, Array<{ symbol: string; reason: string }>>>;
};

export interface StreamSubscription<TChannel extends MarketStreamChannel = MarketStreamChannel> {
  channel: TChannel;
  exchange: ExchangeId;
  symbols: string[];
  interval?: string;
}

export interface CredentialsLookupContext {
  userId: string;
  exchange: ExchangeId;
}
