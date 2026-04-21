import { COINS } from '../../config/constants';
import { getExchangeConfig } from '../../config/exchange.config';
import { resolveExchangeInterval } from '../../core/exchange/interval.mapper';
import type {
  CanonicalCandle,
  ExchangeMarketDescriptor,
  MarketCapabilitySnapshot,
  CanonicalOrderbookSnapshot,
  CanonicalTickerSnapshot,
  CanonicalTrade,
  StreamSubscription,
} from '../../core/exchange/exchange.types';
import type {
  ExchangeMarketDataProvider,
  ExchangeStreamingProvider,
  GlobalReferencePriceSource,
  MarketStreamSink,
} from '../../core/exchange/provider.interfaces';
import { buildStreamSubscriptionPlan } from '../../core/exchange/stream-subscription.plan';
import { toCanonicalMarket, toCanonicalSymbol, toExchangeSymbol } from '../../core/exchange/symbol.mapper';
import { WebSocketClientManager, type WebSocketReconnectMetadata } from '../../core/exchange/websocket.client-manager';
import { logger } from '../../utils/logger';
import { BaseExchangeProvider } from './base-exchange.provider';
import {
  normalizeExchangeTimestampFromCandidates,
  safeNumber,
  sortAsks,
  sortBids,
  toIsoTimestamp,
} from './provider-utils';

const DEFAULT_SYMBOLS = COINS.map((coin) => coin.symbol);
const MARKET_CACHE_TTL_MS = 60_000;
const MARKET_STALE_TTL_MS = 5 * 60_000;
const TICKER_CACHE_TTL_MS = 2_000;
const TICKER_STALE_TTL_MS = 30_000;

function normalizeRequestedSymbols(symbols?: string[]) {
  return Array.from(new Set((symbols ?? []).map(toCanonicalSymbol)));
}

function toSortedSymbols(symbols: Iterable<string>) {
  return Array.from(new Set(symbols)).sort((left, right) => left.localeCompare(right));
}

export class BinanceProvider
  extends BaseExchangeProvider
  implements ExchangeMarketDataProvider, ExchangeStreamingProvider, GlobalReferencePriceSource
{
  private streamManager: WebSocketClientManager | null = null;
  private activeSubscriptions: StreamSubscription[] = [];
  private supportedStreamSymbols = new Set<string>();

  constructor() {
    super('binance');
  }

  async listMarkets(): Promise<ExchangeMarketDescriptor[]> {
    return this.withRequestCache<ExchangeMarketDescriptor[]>({
      operation: 'markets',
      key: 'usdt',
      ttlMs: MARKET_CACHE_TTL_MS,
      staleTtlMs: MARKET_STALE_TTL_MS,
      loader: async () => {
        const response = await this.restClient.request<any>('/api/v3/exchangeInfo');
        const symbols = Array.isArray(response.symbols) ? response.symbols : [];
        return symbols
          .filter((item: any) => String(item.quoteAsset ?? '').toUpperCase() === 'USDT')
          .map((item: any): ExchangeMarketDescriptor => {
            const symbol = String(item.baseAsset).toUpperCase();
            return {
              symbol,
              exchangeSymbol: String(item.symbol),
              marketId: String(item.symbol),
              market: `${symbol}/USDT`,
              baseCurrency: symbol,
              quoteCurrency: 'USDT',
              rawSymbol: String(item.symbol),
              tradable: String(item.status ?? '').toUpperCase() === 'TRADING',
            };
          })
          .filter((item: ExchangeMarketDescriptor) => item.tradable);
      },
      responseItemCount: (items) => items.length,
    });
  }

  async getMarketCapabilitySnapshot(markets?: ExchangeMarketDescriptor[]): Promise<MarketCapabilitySnapshot> {
    const marketUniverse = toSortedSymbols((markets ?? await this.listMarkets()).map((market) => market.symbol));
    return {
      websocketTickerSymbols: this.supportedStreamSymbols.size > 0 ? toSortedSymbols(this.supportedStreamSymbols) : marketUniverse,
      capabilitySymbols: {
        tickers: marketUniverse,
        orderbook: marketUniverse,
        trades: marketUniverse,
        candles: marketUniverse,
      },
    };
  }

  async getTickerSnapshot(symbols?: string[]): Promise<CanonicalTickerSnapshot[]> {
    const listedMarkets = await this.listMarkets();
    const marketUniverse = toSortedSymbols(listedMarkets.map((market) => market.symbol));
    const requestedSymbols = normalizeRequestedSymbols(symbols);
    const effectiveRequestedSymbols = requestedSymbols.length > 0 ? requestedSymbols : marketUniverse;
    const requestedSet = new Set(effectiveRequestedSymbols);
    const marketSymbols = new Set<string>(marketUniverse);
    const cacheKey = requestedSymbols.length > 0 ? `usdt:${effectiveRequestedSymbols.join(',')}` : 'usdt:all';
    const snapshots = await this.withRequestCache({
      operation: 'tickers',
      key: cacheKey,
      ttlMs: TICKER_CACHE_TTL_MS,
      staleTtlMs: TICKER_STALE_TTL_MS,
      requestedMarketCount: effectiveRequestedSymbols.length,
      normalizedSymbolCount: effectiveRequestedSymbols.length,
      loader: async () => {
        const requestSymbols = effectiveRequestedSymbols.map((symbol: string) => toExchangeSymbol(this.exchange, symbol));
        const response = await this.restClient.request<any[]>('/api/v3/ticker/24hr', {
          query: {
            symbols: JSON.stringify(requestSymbols),
          },
        });

        return response.map((ticker) => ({
          ...toCanonicalMarket(this.exchange, String(ticker.symbol).replace(/USDT$/i, '')),
          price: safeNumber(ticker.lastPrice),
          change24h: safeNumber(ticker.priceChangePercent),
          volume24h: safeNumber(ticker.quoteVolume),
          high24h: safeNumber(ticker.highPrice),
          low24h: safeNumber(ticker.lowPrice),
          timestamp: Date.now(),
        }));
      },
      responseItemCount: (items) => items.length,
      symbolDiff: {
        requestedSymbols: effectiveRequestedSymbols,
        resolvedSymbols: (items) => items.map((item) => item.symbol),
        droppedReason: (symbol) =>
          marketSymbols.has(symbol) ? 'missing_from_exchange_ticker_response' : 'not_listed_on_exchange_market_universe',
      },
    });

    const filtered = snapshots.filter((ticker) => requestedSet.has(ticker.symbol));
    const capabilitySnapshot = await this.getMarketCapabilitySnapshot(listedMarkets);
    this.logResolvedMarketUniverse({
      operation: 'tickers',
      requestedSymbols: effectiveRequestedSymbols,
      returnedSymbols: toSortedSymbols(filtered.map((ticker) => ticker.symbol)),
      droppedReason: (symbol) => (marketSymbols.has(symbol) ? 'missing_upstream_ticker' : 'unsupported_on_exchange'),
      universe: {
        registrySymbols: DEFAULT_SYMBOLS,
        marketSymbols: marketUniverse,
        ...capabilitySnapshot,
      },
    });

    return filtered;
  }

  async getReferenceTicker(symbol: string): Promise<CanonicalTickerSnapshot | null> {
    const [ticker] = await this.getTickerSnapshot([symbol]);
    return ticker ?? null;
  }

  async getOrderbookSnapshot(symbol: string, depth = 15): Promise<CanonicalOrderbookSnapshot> {
    const canonical = toCanonicalSymbol(symbol);
    const market = toCanonicalMarket(this.exchange, canonical);
    const response = await this.restClient.request<any>('/api/v3/depth', {
      query: {
        symbol: toExchangeSymbol(this.exchange, canonical),
        limit: Math.min(depth, 1000),
      },
    });
    const asks = sortAsks(
      (response.asks ?? []).map((ask: any) => ({
        price: safeNumber(ask[0]),
        quantity: safeNumber(ask[1]),
      })),
      depth,
    );
    const bids = sortBids(
      (response.bids ?? []).map((bid: any) => ({
        price: safeNumber(bid[0]),
        quantity: safeNumber(bid[1]),
      })),
      depth,
    );

    return {
      ...market,
      asks,
      bids,
      bestAsk: asks[0]?.price ?? 0,
      bestBid: bids[0]?.price ?? 0,
      spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
      timestamp: Date.now(),
    };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<CanonicalTrade[]> {
    const canonical = toCanonicalSymbol(symbol);
    const rawSymbol = toExchangeSymbol(this.exchange, canonical);
    const response = await this.restClient.request<any[]>('/api/v3/trades', {
      query: {
        symbol: rawSymbol,
        limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return response.map((trade) => {
      const price = safeNumber(trade.price);
      const quantity = safeNumber(trade.qty);
      const normalizedTimestamp = normalizeExchangeTimestampFromCandidates([trade.time], { assumeTimezone: 'UTC' });
      if (normalizedTimestamp.timestamp === null) {
        logger.warn(
          { domain: 'market-routes', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
          `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
        );
      }
      return {
        ...market,
        tradeId: String(trade.id),
        side: trade.isBuyerMaker ? 'sell' : 'buy',
        price,
        quantity,
        notional: price * quantity,
        timestamp: normalizedTimestamp.timestamp,
        executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
      };
    });
  }

  async getCandles(symbol: string, interval: string, limit = 60): Promise<CanonicalCandle[]> {
    const canonical = toCanonicalSymbol(symbol);
    const resolved = resolveExchangeInterval(this.exchange, interval);
    if (!resolved) {
      return [];
    }
    const candles = await this.restClient.request<any[]>('/api/v3/klines', {
      query: {
        symbol: toExchangeSymbol(this.exchange, canonical),
        interval: resolved.exchangeInterval,
        limit,
      },
    });
    const market = toCanonicalMarket(this.exchange, canonical);

    return candles.map((candle) => ({
      ...market,
      interval: resolved.resolvedInterval,
      openTime: safeNumber(candle[0]),
      closeTime: safeNumber(candle[6]),
      open: safeNumber(candle[1]),
      high: safeNumber(candle[2]),
      low: safeNumber(candle[3]),
      close: safeNumber(candle[4]),
      volume: safeNumber(candle[5]),
    }));
  }

  async startPublicStream(subscriptions: StreamSubscription[], sink: MarketStreamSink) {
    this.activeSubscriptions = subscriptions.filter((subscription) => subscription.exchange === this.exchange);
    if (this.activeSubscriptions.length === 0) return;

    await this.refreshSupportedStreamSymbols();
    const initialPlan = await this.buildActiveStreamPlan();
    this.logStreamPlan('start', initialPlan);
    if (initialPlan.totalResolvedSymbols === 0) {
      logger.warn(
        { domain: 'market-streaming', exchange: this.exchange, skippedResyncSymbols: initialPlan.skippedSymbols },
        'Skipping Binance public stream start because no symbols resolved',
      );
      return;
    }

    const streams = this.buildStreamNames(initialPlan);
    this.streamManager = new WebSocketClientManager({
      name: 'binance-public',
      url: `${getExchangeConfig(this.exchange).publicWebSocketUrl}?streams=${streams.join('/')}`,
      onOpen: async () => {},
      onMessage: async (raw) => {
        const payload = JSON.parse(raw.toString());
        const wrapped = payload.data ?? payload;
        const stream = String(payload.stream ?? '');
        const streamSymbol = stream.split('@')[0]?.toUpperCase();
        const rawSymbol = String(wrapped.s ?? streamSymbol ?? '');
        const symbol = toCanonicalSymbol(rawSymbol.replace(/USDT$/i, ''));
        const market = toCanonicalMarket(this.exchange, symbol);
        const timestamp = safeNumber(wrapped.E ?? wrapped.T ?? Date.now());
        const type = wrapped.e ?? (stream.includes('@depth') ? 'depth' : '');

        if (type === '24hrTicker' && sink.onTicker) {
          await sink.onTicker({
            ...market,
            price: safeNumber(wrapped.c),
            change24h: safeNumber(wrapped.P),
            volume24h: safeNumber(wrapped.q),
            high24h: safeNumber(wrapped.h),
            low24h: safeNumber(wrapped.l),
            timestamp,
          });
          return;
        }

        if (type === 'depth' && sink.onOrderbook) {
          const asks = sortAsks(
            (wrapped.asks ?? []).map((ask: any) => ({
              price: safeNumber(ask[0]),
              quantity: safeNumber(ask[1]),
            })),
          );
          const bids = sortBids(
            (wrapped.bids ?? []).map((bid: any) => ({
              price: safeNumber(bid[0]),
              quantity: safeNumber(bid[1]),
            })),
          );

          await sink.onOrderbook({
            ...market,
            asks,
            bids,
            bestAsk: asks[0]?.price ?? 0,
            bestBid: bids[0]?.price ?? 0,
            spread: Math.max((asks[0]?.price ?? 0) - (bids[0]?.price ?? 0), 0),
            timestamp,
          });
          return;
        }

        if ((type === 'trade' || type === 'aggTrade') && sink.onTrade) {
          const price = safeNumber(wrapped.p);
          const quantity = safeNumber(wrapped.q);
          const normalizedTimestamp = normalizeExchangeTimestampFromCandidates(
            [wrapped.T, wrapped.E, wrapped.time],
            { assumeTimezone: 'UTC' },
          );
          if (normalizedTimestamp.timestamp === null) {
            logger.warn(
              { domain: 'market-streaming', exchange: this.exchange, rawTimestamp: normalizedTimestamp.raw, reason: normalizedTimestamp.reason },
              `[TradeTimestampAPI] exchange=${this.exchange} invalidTimestamp raw=${String(normalizedTimestamp.raw)} reason=${normalizedTimestamp.reason ?? 'unknown'}`,
            );
            return;
          }
          await sink.onTrade({
            ...market,
            tradeId: String(wrapped.t ?? wrapped.a ?? `${rawSymbol}:${normalizedTimestamp.timestamp}`),
            side: wrapped.m ? 'sell' : 'buy',
            price,
            quantity,
            notional: price * quantity,
            timestamp: normalizedTimestamp.timestamp,
            executedAt: toIsoTimestamp(normalizedTimestamp.timestamp),
          });
        }
      },
      onReconnect: async (ctx) => {
        await this.resyncSnapshots(sink, 'reconnect', ctx.getReconnectMetadata() ?? undefined);
      },
    });

    await this.streamManager.start();
    await this.resyncSnapshots(sink, 'initial');
  }

  async stopPublicStream() {
    await this.streamManager?.stop();
    this.streamManager = null;
  }

  private async refreshSupportedStreamSymbols() {
    this.supportedStreamSymbols = new Set<string>((await this.listMarkets()).map((market: { symbol: string }) => market.symbol));
  }

  private async buildActiveStreamPlan() {
    if (this.supportedStreamSymbols.size === 0) {
      await this.refreshSupportedStreamSymbols();
    }

    return buildStreamSubscriptionPlan({
      subscriptions: this.activeSubscriptions,
      supportedSymbolsByChannel: {
        tickers: this.supportedStreamSymbols,
        orderbook: this.supportedStreamSymbols,
        trades: this.supportedStreamSymbols,
        candles: this.supportedStreamSymbols,
      },
    });
  }

  private buildStreamNames(plan: Awaited<ReturnType<BinanceProvider['buildActiveStreamPlan']>>) {
    const streams: string[] = [];

    for (const symbol of plan.resolvedByChannel.tickers) {
      streams.push(`${symbol.toLowerCase()}usdt@ticker`);
    }
    for (const symbol of plan.resolvedByChannel.orderbook) {
      streams.push(`${symbol.toLowerCase()}usdt@depth20@100ms`);
    }
    for (const symbol of plan.resolvedByChannel.trades) {
      streams.push(`${symbol.toLowerCase()}usdt@trade`);
    }

    return streams;
  }

  private logStreamPlan(
    phase: 'start' | 'initial' | 'reconnect',
    plan: Awaited<ReturnType<BinanceProvider['buildActiveStreamPlan']>>,
    reconnectMetadata?: WebSocketReconnectMetadata,
  ) {
    logger.info(
      {
        domain: 'market-streaming',
        exchange: this.exchange,
        phase,
        reconnectReason: reconnectMetadata,
        activeSubscriptionCount: plan.activeSubscriptionCount,
        resyncScope: plan.activeChannels.map((channel) => ({
          channel,
          symbolCount: plan.resolvedByChannel[channel].length,
        })),
        skippedResyncSymbols: plan.skippedSymbols,
      },
      phase === 'start' ? 'Prepared Binance public stream plan' : 'Prepared Binance public resync plan',
    );
  }

  private async resyncSnapshots(
    sink: MarketStreamSink,
    phase: 'initial' | 'reconnect',
    reconnectMetadata?: WebSocketReconnectMetadata,
  ) {
    const plan = await this.buildActiveStreamPlan();
    this.logStreamPlan(phase, plan, reconnectMetadata);

    if (phase === 'reconnect' && sink.onReconnect) {
      for (const channel of plan.activeChannels) {
        await sink.onReconnect({
          exchange: this.exchange,
          channel,
          symbols: plan.resolvedByChannel[channel],
        });
      }
    }

    if (sink.onTicker && plan.resolvedByChannel.tickers.length > 0) {
      const tickers = await this.getTickerSnapshot(plan.resolvedByChannel.tickers);
      for (const ticker of tickers) await sink.onTicker(ticker);
    }

    if (sink.onOrderbook && plan.resolvedByChannel.orderbook.length > 0) {
      for (const symbol of plan.resolvedByChannel.orderbook) {
        await sink.onOrderbook(await this.getOrderbookSnapshot(symbol));
      }
    }

    if (sink.onTrade && plan.resolvedByChannel.trades.length > 0) {
      for (const symbol of plan.resolvedByChannel.trades) {
        const trades = await this.getRecentTrades(symbol, 20);
        for (const trade of trades.reverse()) await sink.onTrade(trade);
      }
    }
  }
}
