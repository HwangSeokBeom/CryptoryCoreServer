import { redis } from '../../config/redis';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { marketIngestHealth } from '../../domains/market-data/market.ingest-health';
import { marketTrendProjectionStore } from '../../domains/market-data/market-trend.projection';
import { logger } from '../../utils/logger';
import type {
  NormalizedMarketCandle,
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
  PublicMarketCollectorStatus,
} from './market.types';

const TRADE_CACHE_LIMIT = 100;
const TICKER_HISTORY_LIMIT = 120;

function marketKey(exchange: string, symbol: string, interval?: string): string {
  return interval ? `${exchange}:${symbol}:${interval}` : `${exchange}:${symbol}`;
}

class PublicMarketDataStore {
  private readonly tickers = new Map<string, NormalizedMarketTicker>();
  private readonly tickerHistory = new Map<string, Array<{ price: number; timestamp: number }>>();
  private readonly orderbooks = new Map<string, NormalizedMarketOrderbook>();
  private readonly trades = new Map<string, NormalizedMarketTrade[]>();
  private readonly candles = new Map<string, NormalizedMarketCandle>();
  private readonly collectorStatuses = new Map<string, PublicMarketCollectorStatus>();

  upsertTicker(ticker: NormalizedMarketTicker) {
    const key = marketKey(ticker.exchange, ticker.symbol);
    this.tickers.set(key, ticker);
    this.appendTickerHistory(key, ticker.price, ticker.timestamp);
    marketIngestHealth.noteTickerReceived(ticker.exchange as ExchangeId, ticker.timestamp);
    marketTrendProjectionStore.recordTicker(ticker);
    void this.persist(`market:ticker:${key}`, ticker, 120);
  }

  upsertOrderbook(orderbook: NormalizedMarketOrderbook) {
    const key = marketKey(orderbook.exchange, orderbook.symbol);
    this.orderbooks.set(key, orderbook);
    void this.persist(`market:orderbook:${key}`, orderbook, 60);
  }

  appendTrade(trade: NormalizedMarketTrade) {
    const key = marketKey(trade.exchange, trade.symbol);
    const existing = this.trades.get(key) ?? [];
    existing.unshift(trade);
    if (existing.length > TRADE_CACHE_LIMIT) {
      existing.length = TRADE_CACHE_LIMIT;
    }
    this.trades.set(key, existing);
    this.refreshTickerFromTrade(trade);
    marketIngestHealth.noteTradeReceived(trade.exchange as ExchangeId, trade.timestamp);
    marketTrendProjectionStore.recordTrade(trade);
    void this.persist(`market:trades:${key}`, existing, 60);
  }

  upsertCandle(candle: NormalizedMarketCandle) {
    const key = marketKey(candle.exchange, candle.symbol, candle.interval);
    this.candles.set(key, candle);
    void this.persist(`market:candle:${key}`, candle, 120);
  }

  setCollectorStatus(status: PublicMarketCollectorStatus) {
    this.collectorStatuses.set(status.exchange, status);
    void this.persist(`market:status:${status.exchange}`, status, 120);
  }

  getTicker(exchange: string, symbol: string): NormalizedMarketTicker | null {
    return this.tickers.get(marketKey(exchange, symbol)) ?? null;
  }

  getTickers(exchange?: string, symbol?: string): NormalizedMarketTicker[] {
    return Array.from(this.tickers.values())
      .filter((ticker) => {
        if (exchange && ticker.exchange !== exchange) return false;
        if (symbol && ticker.symbol !== symbol) return false;
        return true;
      })
      .sort((left, right) => left.symbol.localeCompare(right.symbol));
  }

  getTickerHistory(exchange: string, symbol: string): Array<{ price: number; timestamp: number }> {
    return [...(this.tickerHistory.get(marketKey(exchange, symbol)) ?? [])];
  }

  getOrderbook(exchange: string, symbol: string): NormalizedMarketOrderbook | null {
    return this.orderbooks.get(marketKey(exchange, symbol)) ?? null;
  }

  getTrades(exchange: string, symbol: string, limit = 50): NormalizedMarketTrade[] {
    return (this.trades.get(marketKey(exchange, symbol)) ?? []).slice(0, limit);
  }

  getCandle(exchange: string, symbol: string, interval: string): NormalizedMarketCandle | null {
    return this.candles.get(marketKey(exchange, symbol, interval)) ?? null;
  }

  getCollectorStatuses(): PublicMarketCollectorStatus[] {
    return Array.from(this.collectorStatuses.values()).sort((left, right) =>
      left.exchange.localeCompare(right.exchange),
    );
  }

  private async persist(key: string, value: unknown, ttlSeconds: number) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (err) {
      logger.debug({ err, key }, 'Failed to persist public market cache to redis');
    }
  }

  private appendTickerHistory(key: string, price: number, timestamp: number) {
    const history = this.tickerHistory.get(key) ?? [];
    const last = history[history.length - 1];
    if (!last || last.price !== price || last.timestamp !== timestamp) {
      history.push({ price, timestamp });
      if (history.length > TICKER_HISTORY_LIMIT) {
        history.splice(0, history.length - TICKER_HISTORY_LIMIT);
      }
      this.tickerHistory.set(key, history);
      return;
    }

    last.timestamp = Math.max(last.timestamp, timestamp);
  }

  private refreshTickerFromTrade(trade: NormalizedMarketTrade) {
    const key = marketKey(trade.exchange, trade.symbol);
    const existingTicker = this.tickers.get(key);
    if (!existingTicker || trade.timestamp < existingTicker.timestamp) {
      return;
    }

    const updatedTicker: NormalizedMarketTicker = {
      ...existingTicker,
      price: trade.price,
      timestamp: trade.timestamp,
    };

    this.tickers.set(key, updatedTicker);
    this.appendTickerHistory(key, updatedTicker.price, updatedTicker.timestamp);
    void this.persist(`market:ticker:${key}`, updatedTicker, 120);
  }
}

export const publicMarketDataStore = new PublicMarketDataStore();
