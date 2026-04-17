export const EXCHANGE_IDS = ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'] as const;
export type ExchangeId = (typeof EXCHANGE_IDS)[number];

export const QUOTE_CURRENCIES = ['KRW', 'USDT'] as const;
export type QuoteCurrency = (typeof QUOTE_CURRENCIES)[number];

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
  publicWebSocketUrl: string;
  privateWebSocketUrl?: string;
  referenceOnly?: boolean;
  capabilities: ExchangeCapability[];
}

export interface CanonicalMarket {
  exchange: ExchangeId;
  symbol: string;
  market: string;
  baseCurrency: string;
  quoteCurrency: QuoteCurrency;
  rawSymbol: string;
  nameKo?: string;
  nameEn?: string;
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
  timestamp: number;
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
  minTotal?: number;
  minQuantity?: number;
  maxQuantity?: number;
  makerFee?: number;
  takerFee?: number;
  supportedOrderTypes: string[];
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

export interface AssetHistoryRecord {
  exchange: ExchangeId;
  symbol?: string;
  type: 'deposit' | 'withdrawal' | 'trade' | 'airdrop' | 'fee' | 'adjustment';
  amount: number;
  balanceAfter?: number;
  timestamp: number;
  description?: string;
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

export interface KimchiPremiumQuote {
  exchange: ExchangeId;
  market: string;
  priceKrw: number;
  premiumPercent: number;
  timestamp: number;
  sourceExchange: ExchangeId;
  sourceTimestamp: number;
  stale: boolean;
  staleAgeMs: number;
  krwConvertedReference: number;
}

export interface KimchiPremiumEntry {
  symbol: string;
  nameKo: string;
  nameEn: string;
  referenceExchange: ExchangeId;
  referenceMarket: string;
  referenceTimestamp: number;
  referenceStale: boolean;
  referenceStaleAgeMs: number;
  binanceUsdtPrice: number;
  usdKrwRate: number;
  binanceKrwPrice: number;
  krwConvertedReference: number;
  fxProvider: string;
  fxTimestamp: number;
  fxStale: boolean;
  fxStaleAgeMs: number;
  domestic: KimchiPremiumQuote[];
  stale: boolean;
  timestampSkewMs: number;
}

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
