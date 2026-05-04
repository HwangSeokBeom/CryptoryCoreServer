import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import {
  coinMarketCapProvider,
  CoinMarketCapProviderError,
  type CoinMarketCapFailureReason,
  type CoinMarketCapProvider,
} from '../market-data/providers/coinmarketcap.provider';
import {
  usdtRateCacheRepository,
  type UsdtRateCacheEntry,
  type UsdtRateCacheRepository,
} from './usdt-rate-cache.repository';

type UsdtRateSource = 'coinmarketcap' | 'cache' | 'none';
export type UsdtRateReason = CoinMarketCapFailureReason | 'using_stale_cache' | null;

export type UsdtRateResponse = {
  symbol: 'USDT';
  name: string;
  convert: 'KRW';
  price: number | null;
  source: UsdtRateSource;
  cacheHit: boolean;
  updatedAt: string | null;
  expiresAt: string | null;
  reason: UsdtRateReason;
};

function isFresh(entry: UsdtRateCacheEntry | null, nowMs = Date.now()) {
  return Boolean(entry && Date.parse(entry.expiresAt) > nowMs);
}

function fromCache(entry: UsdtRateCacheEntry, reason: UsdtRateReason): UsdtRateResponse {
  return {
    symbol: entry.symbol,
    name: entry.name,
    convert: entry.convert,
    price: entry.price,
    source: 'cache',
    cacheHit: true,
    updatedAt: entry.updatedAt,
    expiresAt: entry.expiresAt,
    reason,
  };
}

function unavailable(reason: Exclude<UsdtRateReason, null>): UsdtRateResponse {
  return {
    symbol: 'USDT',
    name: 'Tether USDt',
    convert: 'KRW',
    price: null,
    source: 'none',
    cacheHit: false,
    updatedAt: null,
    expiresAt: null,
    reason,
  };
}

function classifyUnknownFailure(error: unknown): Exclude<CoinMarketCapFailureReason, 'coinmarketcap_api_key_missing'> {
  if (error instanceof CoinMarketCapProviderError && error.reason !== 'coinmarketcap_api_key_missing') {
    return error.reason;
  }
  return 'coinmarketcap_unavailable';
}

export class CalculatorsService {
  constructor(
    private readonly provider: Pick<CoinMarketCapProvider, 'getUsdtKrwQuote'> = coinMarketCapProvider,
    private readonly cache: Pick<UsdtRateCacheRepository, 'get' | 'set'> = usdtRateCacheRepository,
    private readonly config = {
      apiKey: env.COINMARKETCAP_API_KEY,
      ttlSeconds: env.USDT_RATE_CACHE_TTL_SECONDS,
    },
  ) {}

  async getUsdtRate(): Promise<UsdtRateResponse> {
    if (!this.config.apiKey?.trim()) {
      const data = unavailable('coinmarketcap_api_key_missing');
      logger.debug(
        { domain: 'usdt-rate', cacheHit: data.cacheHit, priceExists: false, source: data.source, reason: data.reason },
        `[USDT_RATE] cacheHit=${data.cacheHit} priceExists=false source=${data.source}`,
      );
      return data;
    }

    const cached = await this.cache.get();
    if (isFresh(cached)) {
      const data = fromCache(cached as UsdtRateCacheEntry, null);
      logger.debug(
        { domain: 'usdt-rate', cacheHit: true, priceExists: true, source: data.source },
        '[USDT_RATE] cacheHit=true priceExists=true source=cache',
      );
      return data;
    }

    try {
      const quote = await this.provider.getUsdtKrwQuote();
      const now = new Date();
      const entry: UsdtRateCacheEntry = {
        symbol: 'USDT',
        name: quote.name,
        convert: 'KRW',
        price: quote.price,
        updatedAt: quote.providerUpdatedAt || now.toISOString(),
        expiresAt: new Date(now.getTime() + Math.max(this.config.ttlSeconds, 1) * 1000).toISOString(),
      };
      await this.cache.set(entry, this.config.ttlSeconds);
      const data: UsdtRateResponse = {
        ...entry,
        source: 'coinmarketcap',
        cacheHit: false,
        reason: null,
      };
      logger.debug(
        { domain: 'usdt-rate', cacheHit: false, priceExists: true, source: data.source },
        '[USDT_RATE] cacheHit=false priceExists=true source=coinmarketcap',
      );
      return data;
    } catch (error) {
      const reason = classifyUnknownFailure(error);
      if (cached) {
        logger.warn(
          { domain: 'coinmarketcap', reason, providerStatus: reason === 'coinmarketcap_rate_limited' ? 'rate_limited' : reason },
          '[CMC] unavailable using stale cache',
        );
        return fromCache(cached, 'using_stale_cache');
      }
      return unavailable(reason);
    }
  }
}

export const calculatorsService = new CalculatorsService();
