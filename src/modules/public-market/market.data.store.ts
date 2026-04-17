import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';
import type {
  NormalizedMarketOrderbook,
  NormalizedMarketTicker,
  NormalizedMarketTrade,
  PublicMarketCollectorStatus,
} from './market.types';

const TRADE_CACHE_LIMIT = 100;

function marketKey(exchange: string, symbol: string): string {
  return `${exchange}:${symbol}`;
}

class PublicMarketDataStore {
  private readonly tickers = new Map<string, NormalizedMarketTicker>();
  private readonly orderbooks = new Map<string, NormalizedMarketOrderbook>();
  private readonly trades = new Map<string, NormalizedMarketTrade[]>();
  private readonly collectorStatuses = new Map<string, PublicMarketCollectorStatus>();

  upsertTicker(ticker: NormalizedMarketTicker) {
    const key = marketKey(ticker.exchange, ticker.symbol);
    this.tickers.set(key, ticker);
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
    void this.persist(`market:trades:${key}`, existing, 60);
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

  getOrderbook(exchange: string, symbol: string): NormalizedMarketOrderbook | null {
    return this.orderbooks.get(marketKey(exchange, symbol)) ?? null;
  }

  getTrades(exchange: string, symbol: string, limit = 50): NormalizedMarketTrade[] {
    return (this.trades.get(marketKey(exchange, symbol)) ?? []).slice(0, limit);
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
}

export const publicMarketDataStore = new PublicMarketDataStore();
