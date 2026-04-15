import { ExchangeCapabilityError } from './errors';
import type {
  ExchangeCapability,
  ExchangeId,
} from './exchange.types';
import type {
  ExchangeMarketDataProvider,
  ExchangePortfolioProvider,
  ExchangeStreamingProvider,
  ExchangeTradingProvider,
  FxRateProvider,
  GlobalReferencePriceSource,
} from './provider.interfaces';

export class ExchangeProviderRegistry {
  private readonly marketDataProviders = new Map<ExchangeId, ExchangeMarketDataProvider>();
  private readonly streamingProviders = new Map<ExchangeId, ExchangeStreamingProvider>();
  private readonly tradingProviders = new Map<ExchangeId, ExchangeTradingProvider>();
  private readonly portfolioProviders = new Map<ExchangeId, ExchangePortfolioProvider>();
  private referencePriceSource: GlobalReferencePriceSource | null = null;
  private fxRateProvider: FxRateProvider | null = null;

  registerMarketDataProvider(provider: ExchangeMarketDataProvider) {
    this.marketDataProviders.set(provider.exchange, provider);
    return this;
  }

  registerStreamingProvider(provider: ExchangeStreamingProvider) {
    this.streamingProviders.set(provider.exchange, provider);
    return this;
  }

  registerTradingProvider(provider: ExchangeTradingProvider) {
    this.tradingProviders.set(provider.exchange, provider);
    return this;
  }

  registerPortfolioProvider(provider: ExchangePortfolioProvider) {
    this.portfolioProviders.set(provider.exchange, provider);
    return this;
  }

  registerReferencePriceSource(provider: GlobalReferencePriceSource) {
    this.referencePriceSource = provider;
    return this;
  }

  registerFxRateProvider(provider: FxRateProvider) {
    this.fxRateProvider = provider;
    return this;
  }

  getMarketDataProvider(exchange: ExchangeId) {
    return this.requireProvider(this.marketDataProviders, exchange, 'market:ticker');
  }

  getStreamingProvider(exchange: ExchangeId) {
    return this.requireProvider(this.streamingProviders, exchange, 'stream:public:ticker');
  }

  getTradingProvider(exchange: ExchangeId) {
    return this.requireProvider(this.tradingProviders, exchange, 'trading:create-order');
  }

  getPortfolioProvider(exchange: ExchangeId) {
    return this.requireProvider(this.portfolioProviders, exchange, 'portfolio:balances');
  }

  getReferencePriceSource() {
    if (!this.referencePriceSource) {
      throw new Error('Global reference price source is not registered');
    }
    return this.referencePriceSource;
  }

  getFxRateProvider() {
    if (!this.fxRateProvider) {
      throw new Error('FX rate provider is not registered');
    }
    return this.fxRateProvider;
  }

  listMarketDataProviders() {
    return Array.from(this.marketDataProviders.values());
  }

  private requireProvider<T extends { exchange: ExchangeId; supports(capability: ExchangeCapability): boolean }>(
    providers: Map<ExchangeId, T>,
    exchange: ExchangeId,
    capability: ExchangeCapability,
  ) {
    const provider = providers.get(exchange);
    if (!provider) {
      throw new ExchangeCapabilityError(exchange, capability, `Provider ${exchange} is not registered`);
    }
    return provider;
  }
}
