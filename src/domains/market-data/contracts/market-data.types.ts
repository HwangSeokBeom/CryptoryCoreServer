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
  | 'providerCandle24'
  | 'listSparkline24'
  | 'staleListSparkline24'
  | 'fallbackListSparkline'
  | 'lowInformation'
  | 'liveDetailed'
  | 'staleRealSeries'
  | 'derivedPreview'
  | 'placeholder'
  | 'unavailable'
  | 'insufficient_points'
  | 'flat_current'
  | 'insufficient_variation'
  | 'derived_preview'
  | 'derived_interpolated'
  | 'live_buffer_partial'
  | 'cache_partial_real'
  | 'cache_stale_real'
  | 'provider_partial_real'
  | 'provider_mini'
  | 'provider_mini_real'
  | 'provider_candle_1m'
  | 'prepared_cache'
  | 'prepared_cache_real'
  | 'refined_mini'
  | 'refined_mini_real'
  | 'selected_chart';
export type TickerSparklineSource =
  | 'provider_candle'
  | 'candle_cache'
  | 'sparkline_cache'
  | 'ticker_ring_buffer'
  | 'previous_snapshot'
  | 'fallback_backfill'
  | 'provider'
  | 'cache'
  | 'derived_change24h'
  | 'flat_current'
  | 'unavailable';

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
  canonicalMarketId: string;
  originalMarketId: string;
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
  sparklineUpdatedAt: string | null;
  sparklineSourceVersion: string | null;
  sparklinePointsHash: string;
  sparklineTimeframe: ContractTimeframe;
  sparklineSourceUpdatedAt: string | null;
  sparklineUniquePriceCount: number;
  sparklineUnavailableReason?: string | null;
  sparklineLowInformationReason?: string | null;
  graphDisplayAllowed: boolean;
  lowConfidence?: boolean;
  previewSparkline?: number[];
  previewSparklinePoints?: Array<{ price: number; value: number; timestamp: number }>;
  previewSparklineQuality?: SparklineQuality;
  previewSparklinePointCount?: number;
  previewSparklineIsDerived?: boolean;
  previewGraphQuality?: 'derived_preview' | 'linear_preview' | 'provider_preview' | 'unavailable';
  previewGraphIsDerived?: boolean;
  previewGraphPointCount?: number;
  previewGraphRealSeries?: boolean;
  previewGraphDisplayAllowed?: boolean;
  priceDisplayHint?: QuoteDisplayHint;
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
  cursor?: string;
  query?: string;
  requestId?: string;
};

export type QuoteDisplayHint = {
  quoteCurrency: ContractQuoteCurrency;
  recommendedMaxFractionDigits: number;
  recommendedSignificantDigits: number | null;
  compactNotationAllowed: boolean;
};

export type MarketTickerDiagnostics = {
  requestedExchange: ContractExchange;
  requestedQuoteCurrency: ContractQuoteCurrency;
  supportedQuotes: ContractQuoteCurrency[];
  defaultQuoteCurrency: ContractQuoteCurrency;
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
  previewGraphIsDerived?: boolean;
  previewGraphDerivedCount?: number;
  previewGraphRealSeries?: boolean;
  previewGraphDisplayAllowed?: boolean;
};

export type MarketTickerResponseMeta = {
  exchange: ContractExchange;
  quoteCurrency: ContractQuoteCurrency;
  requestId: string;
  generationHint: string;
  requestedLimit: number;
  returnedCount: number;
  query: string | null;
  sortKey: string;
  sortDirection: SortOrder;
  nextCursor: string | null;
  hasNext: boolean;
  snapshotAt: string;
  serverReceivedAt: string;
  serverRespondedAt: string;
  sparklineTargetPointCount: number;
  sparklineAttachedCount: number;
  sparklineMissingCount: number;
  sparklineUnavailableCount: number;
  sparklineLowInformationCount: number;
  sparklineSummary: {
    targetPointCount: 24;
    providerCandle24: number;
    listSparkline24: number;
    staleListSparkline24: number;
    fallbackListSparkline: number;
    tickerRingBuffer: number;
    graphDisplayAllowed: number;
    lowInformation: number;
    unavailable: number;
    missing: number;
    pointCountDistribution: {
      count0: number;
      count1: number;
      count2to11: number;
      count12to23: number;
      count24: number;
      countOver24: number;
    };
    providerFetchFailed: number;
    providerFetchHttp429: number;
    providerFetch4xx: number;
    providerFetch5xx: number;
    providerLatencyP50Ms: number;
    providerLatencyP95Ms: number;
    requestProviderFetches: number;
    warmupQueued: number;
    attachBudgetMs: number;
    attachBudgetExhausted: boolean;
    avgPointCount: number;
    updatedWithin30s: number;
    updatedWithin60s: number;
    staleOver120s: number;
    p50PointCount: number;
    p95PointCount: number;
    attachMs: number;
    warmup: boolean;
  };
  supportedQuotes: ContractQuoteCurrency[];
  defaultQuoteCurrency: ContractQuoteCurrency;
  quoteDisplayHint: QuoteDisplayHint;
  timing: {
    totalMs: number;
    tickerFetchMs: number;
    sortMs: number;
    cursorMs: number;
    sparklineAttachMs: number;
  };
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
