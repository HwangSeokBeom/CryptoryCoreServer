import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import {
  ExchangeCapabilityError,
  ExchangeMalformedPayloadError,
  ExchangeRateLimitError,
  ExchangeRequestError,
  ExchangeTemporaryUnavailableError,
  ExchangeUnsupportedSymbolError,
} from '../../core/exchange/errors';
import type {
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  ExchangeId,
  MarketStreamChannel,
  StreamSubscription,
} from '../../core/exchange/exchange.types';
import { getExchangeConfig } from '../../config/exchange.config';
import { publicMarketDataStore } from '../../modules/public-market/market.data.store';
import { marketEventBus } from '../../modules/public-market/market.event-bus';
import {
  getPollingFallbackIntervalMs,
  getRepresentativeSymbolsForExchange,
  getStreamingSilenceThresholdMs,
} from './market-priority';
import { logger } from '../../utils/logger';
import type { PublicMarketCapabilityState, PublicMarketCollectorStatus } from '../../modules/public-market/market.types';

const STREAM_EXCHANGES: ExchangeId[] = ['upbit', 'bithumb', 'coinone', 'korbit', 'binance'];
const CAPABILITIES = ['stream', 'ticker', 'orderbook', 'trades'] as const;
type PublicCapability = (typeof CAPABILITIES)[number];

type CapabilityFailureKind =
  | 'active'
  | 'blocked'
  | 'unsupported'
  | 'malformed'
  | 'temporarily_unavailable'
  | 'rate_limited'
  | 'cancelled';

type ExchangeRuntimeStatus = PublicMarketCollectorStatus & {
  capabilities: Record<PublicCapability, PublicMarketCapabilityState>;
};

function persistTicker(ticker: CanonicalTickerSnapshot) {
  publicMarketDataStore.upsertTicker({
    channel: 'tickers',
    exchange: ticker.exchange,
    marketId: ticker.marketId,
    canonicalSymbol: ticker.canonicalSymbol,
    baseAsset: ticker.baseAsset,
    quoteAsset: ticker.quoteAsset,
    displaySymbol: ticker.displaySymbol,
    koreanName: ticker.koreanName,
    englishName: ticker.englishName,
    iconUrl: ticker.iconUrl,
    isActive: ticker.isActive,
    capabilities: ticker.capabilities,
    symbol: ticker.symbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  });
  marketEventBus.emitTicker({
    channel: 'tickers',
    exchange: ticker.exchange,
    marketId: ticker.marketId,
    canonicalSymbol: ticker.canonicalSymbol,
    baseAsset: ticker.baseAsset,
    quoteAsset: ticker.quoteAsset,
    displaySymbol: ticker.displaySymbol,
    koreanName: ticker.koreanName,
    englishName: ticker.englishName,
    iconUrl: ticker.iconUrl,
    isActive: ticker.isActive,
    capabilities: ticker.capabilities,
    symbol: ticker.symbol,
    market: ticker.market,
    baseCurrency: ticker.baseCurrency,
    quoteCurrency: ticker.quoteCurrency,
    rawSymbol: ticker.rawSymbol,
    price: ticker.price,
    change24h: ticker.change24h,
    volume24h: ticker.volume24h,
    high24h: ticker.high24h,
    low24h: ticker.low24h,
    timestamp: ticker.timestamp,
  });
}

function persistOrderbook(orderbook: CanonicalOrderbookSnapshot) {
  publicMarketDataStore.upsertOrderbook({
    channel: 'orderbook',
    exchange: orderbook.exchange,
    marketId: orderbook.marketId,
    canonicalSymbol: orderbook.canonicalSymbol,
    baseAsset: orderbook.baseAsset,
    quoteAsset: orderbook.quoteAsset,
    displaySymbol: orderbook.displaySymbol,
    koreanName: orderbook.koreanName,
    englishName: orderbook.englishName,
    iconUrl: orderbook.iconUrl,
    isActive: orderbook.isActive,
    capabilities: orderbook.capabilities,
    symbol: orderbook.symbol,
    market: orderbook.market,
    baseCurrency: orderbook.baseCurrency,
    quoteCurrency: orderbook.quoteCurrency,
    rawSymbol: orderbook.rawSymbol,
    asks: orderbook.asks.map((level) => ({ price: level.price, qty: level.quantity })),
    bids: orderbook.bids.map((level) => ({ price: level.price, qty: level.quantity })),
    bestAsk: orderbook.bestAsk,
    bestBid: orderbook.bestBid,
    timestamp: orderbook.timestamp,
  });
  marketEventBus.emitOrderbook({
    channel: 'orderbook',
    exchange: orderbook.exchange,
    marketId: orderbook.marketId,
    canonicalSymbol: orderbook.canonicalSymbol,
    baseAsset: orderbook.baseAsset,
    quoteAsset: orderbook.quoteAsset,
    displaySymbol: orderbook.displaySymbol,
    koreanName: orderbook.koreanName,
    englishName: orderbook.englishName,
    iconUrl: orderbook.iconUrl,
    isActive: orderbook.isActive,
    capabilities: orderbook.capabilities,
    symbol: orderbook.symbol,
    market: orderbook.market,
    baseCurrency: orderbook.baseCurrency,
    quoteCurrency: orderbook.quoteCurrency,
    rawSymbol: orderbook.rawSymbol,
    asks: orderbook.asks.map((level) => ({ price: level.price, qty: level.quantity })),
    bids: orderbook.bids.map((level) => ({ price: level.price, qty: level.quantity })),
    bestAsk: orderbook.bestAsk,
    bestBid: orderbook.bestBid,
    timestamp: orderbook.timestamp,
  });
}

function persistTrade(trade: CanonicalTrade) {
  if (trade.timestamp === null) {
    logger.warn(
      {
        domain: 'market-streaming',
        exchange: trade.exchange,
        marketId: trade.marketId,
        symbol: trade.symbol,
        tradeId: trade.tradeId,
      },
      'Dropping trade event with invalid normalized timestamp',
    );
    return;
  }

  publicMarketDataStore.appendTrade({
    channel: 'trades',
    exchange: trade.exchange,
    marketId: trade.marketId,
    canonicalSymbol: trade.canonicalSymbol,
    baseAsset: trade.baseAsset,
    quoteAsset: trade.quoteAsset,
    displaySymbol: trade.displaySymbol,
    koreanName: trade.koreanName,
    englishName: trade.englishName,
    iconUrl: trade.iconUrl,
    isActive: trade.isActive,
    capabilities: trade.capabilities,
    symbol: trade.symbol,
    market: trade.market,
    baseCurrency: trade.baseCurrency,
    quoteCurrency: trade.quoteCurrency,
    rawSymbol: trade.rawSymbol,
    tradeId: trade.tradeId,
    price: trade.price,
    quantity: trade.quantity,
    side: trade.side,
    timestamp: trade.timestamp,
    executedAt: trade.executedAt,
  });
  marketEventBus.emitTrade({
    channel: 'trades',
    exchange: trade.exchange,
    marketId: trade.marketId,
    canonicalSymbol: trade.canonicalSymbol,
    baseAsset: trade.baseAsset,
    quoteAsset: trade.quoteAsset,
    displaySymbol: trade.displaySymbol,
    koreanName: trade.koreanName,
    englishName: trade.englishName,
    iconUrl: trade.iconUrl,
    isActive: trade.isActive,
    capabilities: trade.capabilities,
    symbol: trade.symbol,
    market: trade.market,
    baseCurrency: trade.baseCurrency,
    quoteCurrency: trade.quoteCurrency,
    rawSymbol: trade.rawSymbol,
    tradeId: trade.tradeId,
    price: trade.price,
    quantity: trade.quantity,
    side: trade.side,
    timestamp: trade.timestamp,
    executedAt: trade.executedAt,
  });
}

function createCapabilityState(): PublicMarketCapabilityState {
  return {
    state: 'active',
    failureCount: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    suppressedUntil: null,
  };
}

function createExchangeRuntimeStatus(exchange: ExchangeId): ExchangeRuntimeStatus {
  return {
    exchange,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastMessageAt: null,
    lastError: null,
    mode: 'streaming',
    stale: false,
    failureCount: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    capabilities: {
      stream: createCapabilityState(),
      ticker: createCapabilityState(),
      orderbook: createCapabilityState(),
      trades: createCapabilityState(),
    },
  };
}

function sanitizeErrorSnippet(value: string | undefined) {
  if (!value) return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

function classifyCapabilityError(error: unknown): {
  kind: Exclude<CapabilityFailureKind, 'active'>;
  statusCode?: number;
  reason: string;
  retry: boolean;
} {
  if (error instanceof ExchangeUnsupportedSymbolError) {
    return {
      kind: 'unsupported',
      statusCode: error.statusCode,
      reason: error.message,
      retry: false,
    };
  }

  if (error instanceof ExchangeMalformedPayloadError) {
    return {
      kind: 'malformed',
      statusCode: error.statusCode,
      reason: error.message,
      retry: false,
    };
  }

  if (error instanceof ExchangeRateLimitError) {
    return {
      kind: 'rate_limited',
      statusCode: error.statusCode,
      reason: error.message,
      retry: true,
    };
  }

  if (error instanceof ExchangeTemporaryUnavailableError) {
    return {
      kind: 'temporarily_unavailable',
      statusCode: error.statusCode,
      reason: error.message,
      retry: true,
    };
  }

  if (error instanceof ExchangeCapabilityError) {
    return {
      kind: 'unsupported',
      reason: error.message,
      retry: false,
    };
  }

  if (error instanceof ExchangeRequestError) {
    const responseBody = sanitizeErrorSnippet(error.responseBody);
    const reason = `${error.message}${responseBody ? ` body=${responseBody}` : ''}`;
    if (error.statusCode === 403 && /cloudflare|attention required|access denied/i.test(error.responseBody ?? '')) {
      return { kind: 'blocked', statusCode: error.statusCode, reason, retry: false };
    }
    if (error.statusCode === 429) {
      return { kind: 'rate_limited', statusCode: error.statusCode, reason, retry: true };
    }
    if ([400, 404, 405, 410, 422].includes(error.statusCode)) {
      return { kind: 'unsupported', statusCode: error.statusCode, reason, retry: false };
    }
    if ([408, 409, 425, 500, 502, 503, 504].includes(error.statusCode)) {
      return { kind: 'temporarily_unavailable', statusCode: error.statusCode, reason, retry: true };
    }
    if (/html|<!doctype|payload/i.test(error.responseBody ?? '')) {
      return { kind: 'malformed', statusCode: error.statusCode, reason, retry: false };
    }
    return { kind: 'temporarily_unavailable', statusCode: error.statusCode, reason, retry: true };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (/abort|cancelled|canceled/i.test(message)) {
    return { kind: 'cancelled', reason: message, retry: false };
  }
  if (/\b429\b|too[_\s-]?many[_\s-]?requests|rate limit/i.test(message)) {
    return { kind: 'rate_limited', reason: message, retry: true };
  }
  if (/temporarily unavailable|service unavailable|timeout|timed out|econnreset|socket hang up/i.test(message)) {
    return { kind: 'temporarily_unavailable', reason: message, retry: true };
  }
  if (/malformed payload|payload shape|cannot read properties|unexpected token|asks|bids/i.test(message)) {
    return { kind: 'malformed', reason: message, retry: false };
  }
  return { kind: 'temporarily_unavailable', reason: message, retry: true };
}

function getSuppressMs(kind: Exclude<CapabilityFailureKind, 'active'>, failureCount: number) {
  switch (kind) {
    case 'blocked':
      return 5 * 60_000;
    case 'unsupported':
      return 2 * 60_000;
    case 'malformed':
      return 90_000;
    case 'rate_limited':
      return Math.min(10_000 * Math.max(failureCount, 1), 60_000);
    case 'cancelled':
      return 15_000;
    case 'temporarily_unavailable':
      return Math.min(15_000 * 2 ** Math.max(failureCount - 1, 0), 5 * 60_000);
  }
}

class MarketStreamingOrchestrator {
  private started = false;
  private readonly pollingTimers = new Map<ExchangeId, NodeJS.Timeout>();
  private readonly runtimeStatuses = new Map<ExchangeId, ExchangeRuntimeStatus>();
  private publicSubscriptions: StreamSubscription[] = [];
  private healthMonitorTimer: NodeJS.Timeout | null = null;

  async start() {
    if (this.started) return;
    this.started = true;

    const subscriptionResults = await Promise.all(
      STREAM_EXCHANGES.map(async (exchange) => {
        try {
          const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
          const markets = await provider.listMarkets();
          const symbols = markets.filter((market) => market.tradable !== false).map((market) => market.symbol);
          return {
            exchange,
            symbols,
          };
        } catch (error) {
          logger.warn(
            { domain: 'market-streaming', exchange, capability: 'markets', err: error },
            'Failed to resolve provider market universe for streaming bootstrap',
          );
          return {
            exchange,
            symbols: [],
          };
        }
      }),
    );
    this.publicSubscriptions = subscriptionResults.flatMap(({ exchange, symbols }) => {
      const representativeSymbols = getRepresentativeSymbolsForExchange(symbols);
      return [
        {
          exchange,
          channel: 'tickers' as const,
          symbols,
        },
        {
          exchange,
          channel: 'trades' as const,
          symbols: representativeSymbols,
        },
      ].filter((subscription) => subscription.symbols.length > 0);
    });

    await Promise.all(
      STREAM_EXCHANGES.map(async (exchange) => {
        const config = getExchangeConfig(exchange);
        try {
          if (!config.publicStreamingEnabled) {
            this.setMode(exchange, 'polling', false, 'public streaming disabled');
            this.startPollingFallback(exchange);
            return;
          }
          const provider = exchangeProviderRegistry.getStreamingProvider(exchange);
          await provider.startPublicStream(this.publicSubscriptions, {
            onTicker: async (payload) => {
              this.noteCapabilitySuccess(exchange, 'ticker');
              persistTicker(payload);
            },
            onOrderbook: async (payload) => {
              this.noteCapabilitySuccess(exchange, 'orderbook');
              persistOrderbook(payload);
            },
            onTrade: async (payload) => {
              this.noteCapabilitySuccess(exchange, 'trades');
              persistTrade(payload);
            },
            onReconnect: async (subscription) => {
              logger.info(
                {
                  domain: 'market-streaming',
                  exchange: subscription.exchange,
                  channel: subscription.channel,
                  symbolCount: subscription.symbols.length,
                },
                'Resyncing public market snapshot after reconnect',
              );
            },
          });
          this.setMode(exchange, 'streaming', true, null);
          this.noteCapabilitySuccess(exchange, 'stream');
        } catch (error) {
          this.noteCapabilityFailure(exchange, 'stream', {
            capability: 'stream',
            endpoint: 'startPublicStream',
            error,
          });
          if (config.pollingFallbackEnabled) {
            this.setMode(exchange, 'polling', false, error instanceof Error ? error.message : String(error));
            this.startPollingFallback(exchange);
          }
        }
      }),
    );

    this.startHealthMonitor();
  }

  async stop() {
    if (!this.started) return;
    this.started = false;

    await Promise.all(
      STREAM_EXCHANGES.map(async (exchange) => {
        try {
          const provider = exchangeProviderRegistry.getStreamingProvider(exchange);
          await provider.stopPublicStream();
        } catch (error) {
          logger.warn({ domain: 'market-streaming', exchange, err: error }, 'Failed to stop public market stream');
        }
      }),
    );

    for (const timer of this.pollingTimers.values()) {
      clearInterval(timer);
    }
    this.pollingTimers.clear();

    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
      this.healthMonitorTimer = null;
    }
  }

  private startPollingFallback(exchange: ExchangeId) {
    if (this.pollingTimers.has(exchange)) {
      return;
    }

    const run = async () => {
      try {
        const provider = exchangeProviderRegistry.getMarketDataProvider(exchange);
        const tickerSymbols = this.getSubscribedSymbols(exchange, 'tickers');
        const orderbookSymbols = this.getSubscribedSymbols(exchange, 'orderbook');
        const tradeSymbols = this.getSubscribedSymbols(exchange, 'trades');
        this.setMode(exchange, 'polling', false, null);

        if (tickerSymbols.length > 0 && !this.isCapabilitySuppressed(exchange, 'ticker')) {
          try {
            const tickers = await provider.getTickerSnapshot(tickerSymbols);
            tickers.forEach((ticker) => {
              persistTicker(ticker);
            });
            this.noteCapabilitySuccess(exchange, 'ticker');
          } catch (error) {
            this.noteCapabilityFailure(exchange, 'ticker', {
              capability: 'ticker',
              endpoint: 'getTickerSnapshot',
              error,
            });
          }
        }

        if (orderbookSymbols.length > 0 && !this.isCapabilitySuppressed(exchange, 'orderbook')) {
          for (const symbol of orderbookSymbols) {
            try {
              persistOrderbook(await provider.getOrderbookSnapshot(symbol));
              this.noteCapabilitySuccess(exchange, 'orderbook');
            } catch (error) {
              this.noteCapabilityFailure(exchange, 'orderbook', {
                capability: 'orderbook',
                symbol,
                endpoint: 'getOrderbookSnapshot',
                error,
              });
              break;
            }
          }
        }

        if (tradeSymbols.length > 0 && !this.isCapabilitySuppressed(exchange, 'trades')) {
          for (const symbol of tradeSymbols) {
            try {
              const trades = await provider.getRecentTrades(symbol, 20);
              trades.reverse().forEach(persistTrade);
              if (trades.length > 0) {
                this.noteCapabilitySuccess(exchange, 'trades');
              }
            } catch (error) {
              this.noteCapabilityFailure(exchange, 'trades', {
                capability: 'trades',
                symbol,
                endpoint: 'getRecentTrades',
                error,
              });
              break;
            }
          }
        }
      } catch (error) {
        logger.warn({ domain: 'market-streaming', exchange, err: error }, 'Polling fallback refresh failed');
      }
    };

    void run();
    const timer = setInterval(() => {
      void run();
    }, getPollingFallbackIntervalMs(exchange));
    this.pollingTimers.set(exchange, timer);
    logger.warn({ domain: 'market-streaming', exchange }, 'Public stream polling fallback enabled');
  }

  private getSubscribedSymbols(exchange: ExchangeId, channel: MarketStreamChannel) {
    return Array.from(
      new Set(
        this.publicSubscriptions
          .filter((subscription) => subscription.exchange === exchange && subscription.channel === channel)
          .flatMap((subscription) => subscription.symbols),
      ),
    );
  }

  private getRuntimeStatus(exchange: ExchangeId) {
    const existing = this.runtimeStatuses.get(exchange);
    if (existing) {
      return existing;
    }

    const created = createExchangeRuntimeStatus(exchange);
    this.runtimeStatuses.set(exchange, created);
    return created;
  }

  private publishRuntimeStatus(exchange: ExchangeId) {
    const status = this.getRuntimeStatus(exchange);
    const failingCapabilities = Object.values(status.capabilities).filter((capability) => capability.state !== 'active');
    status.stale = failingCapabilities.length > 0;
    status.failureCount = failingCapabilities.reduce((sum, capability) => sum + capability.failureCount, 0);
    status.lastFailureAt = failingCapabilities
      .map((capability) => capability.lastFailureAt ?? 0)
      .reduce((max, value) => Math.max(max, value), 0) || null;
    status.lastFailureReason = failingCapabilities
      .map((capability) => capability.lastFailureReason)
      .find(Boolean) ?? null;
    publicMarketDataStore.setCollectorStatus(status);
    marketEventBus.emitStatus(status);
  }

  private setMode(exchange: ExchangeId, mode: 'streaming' | 'polling', connected: boolean, lastError: string | null) {
    const status = this.getRuntimeStatus(exchange);
    status.mode = mode;
    status.connected = connected;
    status.lastConnectedAt = connected ? Date.now() : status.lastConnectedAt;
    status.lastError = lastError;
    this.publishRuntimeStatus(exchange);
  }

  private noteCapabilitySuccess(exchange: ExchangeId, capability: PublicCapability) {
    const status = this.getRuntimeStatus(exchange);
    const target = status.capabilities[capability];
    target.state = 'active';
    target.failureCount = 0;
    target.lastSuccessAt = Date.now();
    target.lastFailureReason = null;
    target.lastFailureAt = null;
    target.suppressedUntil = null;
    status.lastMessageAt = target.lastSuccessAt;
    if (capability === 'stream') {
      status.connected = true;
      status.lastConnectedAt = target.lastSuccessAt;
    }
    this.publishRuntimeStatus(exchange);
  }

  private noteCapabilityFailure(
    exchange: ExchangeId,
    capability: PublicCapability,
    params: { capability: PublicCapability; symbol?: string; endpoint: string; error: unknown },
  ) {
    const status = this.getRuntimeStatus(exchange);
    const target = status.capabilities[capability];
    const classification = classifyCapabilityError(params.error);
    target.failureCount += 1;
    target.lastFailureAt = Date.now();
    target.lastFailureReason = classification.reason;
    target.state = classification.kind;
    target.suppressedUntil = Date.now() + getSuppressMs(classification.kind, target.failureCount);
    status.lastError = classification.reason;
    if (capability === 'stream') {
      status.connected = false;
    }
    this.publishRuntimeStatus(exchange);
    logger.warn(
      {
        domain: 'market-streaming',
        exchange,
        symbol: params.symbol,
        endpoint: params.endpoint,
        capability,
        upstreamStatus: classification.statusCode,
        retry: classification.retry,
        failureKind: classification.kind,
        suppressMs: target.suppressedUntil ? Math.max(target.suppressedUntil - Date.now(), 0) : 0,
        err: params.error,
      },
      'Public market capability failed',
    );
  }

  private isCapabilitySuppressed(exchange: ExchangeId, capability: PublicCapability) {
    const suppressedUntil = this.getRuntimeStatus(exchange).capabilities[capability].suppressedUntil;
    return typeof suppressedUntil === 'number' && suppressedUntil > Date.now();
  }

  private startHealthMonitor() {
    if (this.healthMonitorTimer) {
      clearInterval(this.healthMonitorTimer);
    }

    this.healthMonitorTimer = setInterval(() => {
      for (const exchange of STREAM_EXCHANGES) {
        const status = this.runtimeStatuses.get(exchange);
        if (!status || status.mode !== 'streaming' || !status.lastMessageAt) {
          continue;
        }

        const silenceThresholdMs = getStreamingSilenceThresholdMs(exchange);
        const silenceMs = Math.max(Date.now() - status.lastMessageAt, 0);
        if (silenceMs <= silenceThresholdMs) {
          continue;
        }

        logger.warn(
          {
            domain: 'market-streaming',
            exchange,
            mode: status.mode,
            connected: status.connected,
            lastMessageAt: status.lastMessageAt,
            silenceMs,
            silenceThresholdMs,
          },
          'Detected silent public stream; enabling polling fallback',
        );

        if (getExchangeConfig(exchange).pollingFallbackEnabled) {
          this.startPollingFallback(exchange);
        }
      }
    }, 5_000);
  }
}

export const marketStreamingOrchestrator = new MarketStreamingOrchestrator();
