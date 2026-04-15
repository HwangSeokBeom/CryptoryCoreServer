import type {
  AssetHistoryRecord,
  CancelOrderRequest,
  CanonicalCandle,
  CanonicalFill,
  CanonicalOrder,
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  CreateOrderRequest,
  ExchangeCapability,
  ExchangeId,
  ExchangeMetadata,
  FxRate,
  OrderChance,
  PortfolioSnapshot,
  StreamSubscription,
  UserExchangeCredentials,
  MarketStreamChannel,
  MarketStreamEventMap,
} from './exchange.types';

export interface ProviderContext {
  credentials?: UserExchangeCredentials;
}

export interface ExchangeProviderBase {
  readonly exchange: ExchangeId;
  readonly metadata: ExchangeMetadata;
  supports(capability: ExchangeCapability): boolean;
}

export interface ExchangeMarketDataProvider extends ExchangeProviderBase {
  listMarkets(): Promise<Array<{ symbol: string; market: string; rawSymbol: string }>>;
  getTickerSnapshot(symbols?: string[]): Promise<CanonicalTickerSnapshot[]>;
  getOrderbookSnapshot(symbol: string, depth?: number): Promise<CanonicalOrderbookSnapshot>;
  getRecentTrades(symbol: string, limit?: number): Promise<CanonicalTrade[]>;
  getCandles(symbol: string, interval: string, limit?: number): Promise<CanonicalCandle[]>;
}

export interface MarketStreamSink {
  onTicker?(payload: CanonicalTickerSnapshot): Promise<void> | void;
  onOrderbook?(payload: CanonicalOrderbookSnapshot): Promise<void> | void;
  onTrade?(payload: CanonicalTrade): Promise<void> | void;
  onCandle?(payload: CanonicalCandle): Promise<void> | void;
  onReconnect?(subscription: StreamSubscription): Promise<void> | void;
}

export interface ExchangeStreamingProvider extends ExchangeProviderBase {
  startPublicStream(subscriptions: StreamSubscription[], sink: MarketStreamSink): Promise<void>;
  stopPublicStream(): Promise<void>;
}

export interface ExchangeTradingProvider extends ExchangeProviderBase {
  getOrderChance?(symbol: string, context: ProviderContext): Promise<OrderChance>;
  createOrder?(request: CreateOrderRequest, context: ProviderContext): Promise<CanonicalOrder>;
  cancelOrder?(request: CancelOrderRequest, context: ProviderContext): Promise<CanonicalOrder>;
  getOrder?(orderId: string, symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder>;
  listOpenOrders?(symbol: string | undefined, context: ProviderContext): Promise<CanonicalOrder[]>;
  listFills?(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<CanonicalFill[]>;
}

export interface ExchangePortfolioProvider extends ExchangeProviderBase {
  getPortfolioSnapshot(context: ProviderContext): Promise<PortfolioSnapshot>;
  getAssetHistory?(symbol: string | undefined, limit: number | undefined, context: ProviderContext): Promise<AssetHistoryRecord[]>;
}

export interface GlobalReferencePriceSource {
  getReferenceTicker(symbol: string): Promise<CanonicalTickerSnapshot | null>;
}

export interface FxRateProvider {
  getUsdKrwRate(): Promise<FxRate>;
}

export interface StreamStateSnapshot<TChannel extends MarketStreamChannel = MarketStreamChannel> {
  channel: TChannel;
  items: MarketStreamEventMap[TChannel][];
}
