import { redis } from '../../config/redis';
import { fxConfig } from '../../config/exchange.config';
import type { FxRate } from '../../core/exchange/exchange.types';
import type { FxRateProvider } from '../../core/exchange/provider.interfaces';
import { RestClient } from '../../core/exchange/rest.client';
import { logger } from '../../utils/logger';

const CACHE_KEY = 'fx:usd-krw';

export class ExchangeRateHostProvider implements FxRateProvider {
  private readonly client = new RestClient('fx', fxConfig.baseUrl);
  private memoryCache: FxRate = {
    pair: 'USD/KRW',
    rate: fxConfig.fallbackRate,
    timestamp: Date.now(),
    staleAt: Date.now() + fxConfig.staleThresholdMs,
    provider: 'fallback',
  };

  async getUsdKrwRate(): Promise<FxRate> {
    const cached = await this.readCachedRate();
    if (cached && cached.staleAt > Date.now()) {
      logger.debug(
        {
          domain: 'fx',
          provider: cached.provider,
          pair: cached.pair,
          cacheOutcome: 'hit',
          timestamp: cached.timestamp,
          staleAt: cached.staleAt,
        },
        'USD/KRW rate cache hit',
      );
      return cached;
    }

    try {
      const startedAt = Date.now();
      logger.debug({ domain: 'fx', provider: 'exchangerate.host', pair: 'USD/KRW', event: 'fetch_start' }, 'USD/KRW rate fetch start');
      const response = await this.client.request<any>('/latest', {
        query: {
          base: 'USD',
          symbols: 'KRW',
          ...(fxConfig.apiKey ? { access_key: fxConfig.apiKey } : {}),
        },
      });

      const rate = Number(response.rates?.KRW ?? response.quotes?.USDKRW ?? 0);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error('Invalid FX rate payload');
      }

      const fxRate: FxRate = {
        pair: 'USD/KRW',
        rate,
        timestamp: Date.now(),
        staleAt: Date.now() + fxConfig.staleThresholdMs,
        provider: 'exchangerate.host',
      };

      this.memoryCache = fxRate;
      await redis.set(CACHE_KEY, JSON.stringify(fxRate), 'EX', Math.max(Math.floor(fxConfig.staleThresholdMs / 1000), 60));
      logger.debug(
        {
          domain: 'fx',
          provider: fxRate.provider,
          pair: fxRate.pair,
          event: 'fetch_end',
          latencyMs: Date.now() - startedAt,
          timestamp: fxRate.timestamp,
        },
        'USD/KRW rate fetch end',
      );
      return fxRate;
    } catch (error) {
      logger.warn(
        {
          domain: 'fx',
          provider: this.memoryCache.provider,
          pair: this.memoryCache.pair,
          fallbackTimestamp: this.memoryCache.timestamp,
          err: error,
        },
        'Failed to refresh USD/KRW rate, using cached fallback',
      );
      return this.memoryCache;
    }
  }

  private async readCachedRate() {
    try {
      const cached = await redis.get(CACHE_KEY);
      if (!cached) return this.memoryCache;
      const parsed = JSON.parse(cached) as FxRate;
      this.memoryCache = parsed;
      return parsed;
    } catch {
      return this.memoryCache;
    }
  }
}
