import { redis } from '../../config/redis';
import { logger } from '../../utils/logger';

export type UsdtRateCacheEntry = {
  symbol: 'USDT';
  name: string;
  convert: 'KRW';
  price: number;
  updatedAt: string;
  expiresAt: string;
};

const CACHE_KEY = 'calculators:usdt-rate:KRW';

function isUsableCacheEntry(value: unknown): value is UsdtRateCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as UsdtRateCacheEntry;
  return entry.symbol === 'USDT'
    && entry.convert === 'KRW'
    && typeof entry.name === 'string'
    && typeof entry.price === 'number'
    && Number.isFinite(entry.price)
    && typeof entry.updatedAt === 'string'
    && typeof entry.expiresAt === 'string';
}

export class UsdtRateCacheRepository {
  private memoryCache: UsdtRateCacheEntry | null = null;

  async get(): Promise<UsdtRateCacheEntry | null> {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (isUsableCacheEntry(parsed)) {
          this.memoryCache = parsed;
          return parsed;
        }
      }
    } catch (error) {
      logger.warn({ domain: 'usdt-rate-cache', err: error }, 'Failed to read USDT rate from Redis cache');
    }

    return this.memoryCache;
  }

  async set(entry: UsdtRateCacheEntry, _ttlSeconds: number) {
    this.memoryCache = entry;
    try {
      await redis.set(CACHE_KEY, JSON.stringify(entry));
    } catch (error) {
      logger.warn({ domain: 'usdt-rate-cache', err: error }, 'Failed to write USDT rate to Redis cache');
    }
  }

  resetForTests() {
    this.memoryCache = null;
  }
}

export const usdtRateCacheRepository = new UsdtRateCacheRepository();
