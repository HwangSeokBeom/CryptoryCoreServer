export const CONTRACT_EXCHANGES = ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'] as const;
export const CONTRACT_QUOTE_CURRENCIES = ['KRW', 'BTC', 'USDT', 'ETH'] as const;
export const CONTRACT_TIMEFRAMES = ['1M', '5M', '15M', '1H', '4H', '1D', '1W'] as const;

export type ContractExchange = (typeof CONTRACT_EXCHANGES)[number];
export type ContractQuoteCurrency = (typeof CONTRACT_QUOTE_CURRENCIES)[number];
export type ContractTimeframe = (typeof CONTRACT_TIMEFRAMES)[number];
export type TickerSort = 'volume' | 'changeRate' | 'price' | 'name';
export type SortOrder = 'asc' | 'desc';
export type ExchangeContractStatus = 'active' | 'unsupported' | 'degraded' | 'error';
export type SparklineQuality =
  | 'placeholder'
  | 'flat_current'
  | 'derived_preview'
  | 'provider_mini'
  | 'prepared_cache'
  | 'refined_mini'
  | 'selected_chart';
export type TickerSparklineSource = 'provider' | 'cache' | 'derived_change24h' | 'flat_current' | 'unavailable';

export type ExchangeQuoteContract = {
  exchange: ContractExchange;
  displayName: string;
  supportedQuotes: ContractQuoteCurrency[];
  defaultQuoteCurrency: ContractQuoteCurrency;
  enabled: boolean;
  status: ExchangeContractStatus;
  reason?: string | null;
};

export type MarketDescriptor = {
  exchange: ContractExchange;
  market: string;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
  koreanName: string | null;
  englishName: string | null;
};

export type MarketCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number;
  value?: number;
  tradePriceVolume?: number;
};

export type MarketTickerItem = {
  exchange: ContractExchange;
  exchangeName: string;
  market: string;
  marketId: string;
  exchangeSymbol: string;
  rawSymbol: string;
  symbol: string;
  baseCurrency: string;
  displaySymbol: string;
  displayPair: string;
  displayName: string;
  quoteCurrency: ContractQuoteCurrency;
  koreanName: string;
  englishName: string;
  currentPrice: number | null;
  current: number | null;
  price: number | null;
  tradePrice: number | null;
  changeRate24h: number | null;
  change24h: number | null;
  percent: number | null;
  changeRate: number | null;
  signedChangeRate: number | null;
  signedChangePrice24h: number;
  changePrice: number;
  signedChangePrice: number;
  accTradePrice24h: number;
  value: number;
  accTradeVolume24h: number;
  volume: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  previousPrice24h: number | null;
  timestamp: number;
  sourceTimestamp: number;
  stale: boolean;
  updatedAt: string;
  sparkline: number[];
  sparklinePoints: Array<{ price: number; timestamp: number }>;
  sparklineSource: TickerSparklineSource;
  sparklineQuality: SparklineQuality;
  sparklinePointCount: number;
  sparklineIsDerived: boolean;
};

export type CurrentPriceSnapshot = {
  exchange: ContractExchange;
  market: string;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
  currentPrice: number;
  high24h: number;
  low24h: number;
  changeRate24h: number;
  volume24h: number;
};

export type CandleSnapshotParams = {
  exchange: ContractExchange;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
  timeframe: ContractTimeframe;
  limit: number;
};

export type TickerListParams = {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  sort?: TickerSort;
  order?: SortOrder;
  limit?: number;
};

export type MarketTickerDiagnostics = {
  requestedExchange: ContractExchange;
  requestedQuoteCurrency: ContractQuoteCurrency;
  supported: boolean;
  unsupported: boolean;
  providerStatus: ExchangeContractStatus;
  providerLatencyMs: number | null;
  rawCount: number;
  mappedCount: number;
  returnedCount: number;
  omittedCount: number;
  zeroPriceCount: number;
  zeroVolumeCount: number;
  staleCount: number;
  reason: string | null;
};

export interface ExchangeMarketDataAdapter {
  readonly exchange: ContractExchange;
  normalizeMarket(symbol: string, quoteCurrency: ContractQuoteCurrency): string;
  parseMarket(market: string): { symbol: string; quoteCurrency: ContractQuoteCurrency } | null;
  listMarkets(quoteCurrency: ContractQuoteCurrency): Promise<MarketDescriptor[]>;
  getCandles(params: CandleSnapshotParams): Promise<MarketCandle[]>;
  getTickers(params: TickerListParams): Promise<MarketTickerItem[]>;
  getCurrentPrices(markets: string[]): Promise<CurrentPriceSnapshot[]>;
}
