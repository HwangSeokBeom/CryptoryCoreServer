import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeSensitiveDetails } from '../src/domains/security/credential-security.service';
import { logger } from '../src/utils/logger';
import { CalculatorsService } from '../src/domains/calculators/calculators.service';
import {
  CoinMarketCapProvider,
  CoinMarketCapProviderError,
} from '../src/domains/market-data/providers/coinmarketcap.provider';
import type { UsdtRateCacheEntry } from '../src/domains/calculators/usdt-rate-cache.repository';

function createCacheEntry(overrides: Partial<UsdtRateCacheEntry> = {}): UsdtRateCacheEntry {
  return {
    symbol: 'USDT',
    name: 'Tether USDt',
    convert: 'KRW',
    price: 1374.8,
    updatedAt: '2026-05-03T22:30:00.000Z',
    expiresAt: '2026-05-03T22:35:00.000Z',
    ...overrides,
  };
}

function createService(params: {
  provider?: { getUsdtKrwQuote: ReturnType<typeof vi.fn> };
  cacheEntry?: UsdtRateCacheEntry | null;
  apiKey?: string;
  ttlSeconds?: number;
}) {
  const provider = params.provider ?? {
    getUsdtKrwQuote: vi.fn(async () => ({
      symbol: 'USDT' as const,
      name: 'Tether USDt',
      convert: 'KRW' as const,
      price: 1375.25,
      providerUpdatedAt: '2026-05-03T22:35:00.000Z',
    })),
  };
  const cache = {
    get: vi.fn(async () => params.cacheEntry ?? null),
    set: vi.fn(async () => undefined),
  };
  return {
    provider,
    cache,
    service: new CalculatorsService(provider, cache, {
      apiKey: params.apiKey ?? 'cmc-secret-key',
      ttlSeconds: params.ttlSeconds ?? 300,
    }),
  };
}

describe('CalculatorsService USDT/KRW rate cache behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-03T22:35:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('calls CoinMarketCap provider on cache miss and stores the parsed price', async () => {
    const { service, provider, cache } = createService({ cacheEntry: null });

    const data = await service.getUsdtRate();

    expect(provider.getUsdtKrwQuote).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'USDT',
      name: 'Tether USDt',
      convert: 'KRW',
      price: 1375.25,
      updatedAt: '2026-05-03T22:35:00.000Z',
      expiresAt: '2026-05-03T22:40:00.000Z',
    }), 300);
    expect(data).toMatchObject({
      symbol: 'USDT',
      name: 'Tether USDt',
      convert: 'KRW',
      price: 1375.25,
      source: 'coinmarketcap',
      cacheHit: false,
      reason: null,
    });
  });

  it('returns fresh cache without calling the provider', async () => {
    const { service, provider } = createService({
      cacheEntry: createCacheEntry({ expiresAt: '2026-05-03T22:40:00.000Z' }),
    });

    const data = await service.getUsdtRate();

    expect(provider.getUsdtKrwQuote).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      price: 1374.8,
      source: 'cache',
      cacheHit: true,
      reason: null,
    });
  });

  it('returns stale cache when CoinMarketCap is rate limited', async () => {
    const provider = {
      getUsdtKrwQuote: vi.fn(async () => {
        throw new CoinMarketCapProviderError('coinmarketcap_rate_limited', 'rate limited', 429);
      }),
    };
    const { service } = createService({ provider, cacheEntry: createCacheEntry() });

    const data = await service.getUsdtRate();

    expect(data).toMatchObject({
      price: 1374.8,
      source: 'cache',
      cacheHit: true,
      reason: 'using_stale_cache',
    });
  });

  it('returns stale cache when CoinMarketCap has a 500/network error', async () => {
    const provider = {
      getUsdtKrwQuote: vi.fn(async () => {
        throw new Error('network failed');
      }),
    };
    const { service } = createService({ provider, cacheEntry: createCacheEntry() });

    const data = await service.getUsdtRate();

    expect(data).toMatchObject({
      price: 1374.8,
      source: 'cache',
      cacheHit: true,
      reason: 'using_stale_cache',
    });
  });

  it('returns a null-safe unavailable response when provider fails and stale cache is empty', async () => {
    const provider = {
      getUsdtKrwQuote: vi.fn(async () => {
        throw new CoinMarketCapProviderError('coinmarketcap_unavailable', 'upstream unavailable', 500);
      }),
    };
    const { service } = createService({ provider, cacheEntry: null });

    const data = await service.getUsdtRate();

    expect(data).toEqual({
      symbol: 'USDT',
      name: 'Tether USDt',
      convert: 'KRW',
      price: null,
      source: 'none',
      cacheHit: false,
      updatedAt: null,
      expiresAt: null,
      reason: 'coinmarketcap_unavailable',
    });
  });

  it('keeps the public response contract stable for a successful fresh fetch', async () => {
    const { service } = createService({ cacheEntry: null });

    const data = await service.getUsdtRate();

    expect(Object.keys(data).sort()).toEqual([
      'cacheHit',
      'convert',
      'expiresAt',
      'name',
      'price',
      'reason',
      'source',
      'symbol',
      'updatedAt',
    ]);
    expect(data).toEqual({
      symbol: 'USDT',
      name: 'Tether USDt',
      convert: 'KRW',
      price: 1375.25,
      source: 'coinmarketcap',
      cacheHit: false,
      updatedAt: '2026-05-03T22:35:00.000Z',
      expiresAt: '2026-05-03T22:40:00.000Z',
      reason: null,
    });
  });

  it('returns api-key-missing without touching cache or provider', async () => {
    const { service, provider, cache } = createService({
      apiKey: '',
      cacheEntry: createCacheEntry({ expiresAt: '2026-05-03T22:40:00.000Z' }),
    });

    const data = await service.getUsdtRate();

    expect(cache.get).not.toHaveBeenCalled();
    expect(provider.getUsdtKrwQuote).not.toHaveBeenCalled();
    expect(data).toMatchObject({
      price: null,
      source: 'none',
      cacheHit: false,
      reason: 'coinmarketcap_api_key_missing',
    });
  });
});

describe('CoinMarketCapProvider USDT/KRW quote parsing', () => {
  const fetchMock = vi.fn();
  const apiKey = 'cmc-test-api-key-1234567890';

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('parses a v2 quotes/latest response using data["825"].quote.KRW.price', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      status: { timestamp: '2026-05-03T22:35:00.000Z', error_code: 0 },
      data: {
        825: {
          id: 825,
          name: 'Tether USDt',
          symbol: 'USDT',
          slug: 'tether',
          quote: {
            KRW: {
              price: 1375.25,
              last_updated: '2026-05-03T22:35:00.000Z',
            },
          },
        },
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new CoinMarketCapProvider({
      baseUrl: 'https://pro-api.coinmarketcap.com',
      apiKey,
      timeoutMs: 5000,
      usdtId: 825,
    });

    const quote = await provider.getUsdtKrwQuote();

    expect(quote).toEqual({
      symbol: 'USDT',
      name: 'Tether USDt',
      convert: 'KRW',
      price: 1375.25,
      providerUpdatedAt: '2026-05-03T22:35:00.000Z',
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=825&convert=KRW');
    expect(options.headers['X-CMC_PRO_API_KEY']).toBe(apiKey);
  });

  it('parses a symbol-keyed v2 response array defensively', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      status: { timestamp: '2026-05-03T22:35:00.000Z', error_code: 0 },
      data: {
        USDT: [{
          id: 825,
          name: 'Tether USDt',
          symbol: 'USDT',
          slug: 'tether',
          quote: {
            KRW: {
              price: '1376.50',
              last_updated: '2026-05-03T22:35:00.000Z',
            },
          },
        }],
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new CoinMarketCapProvider({
      baseUrl: 'https://pro-api.coinmarketcap.com',
      apiKey,
      timeoutMs: 5000,
      usdtId: 825,
    });

    await expect(provider.getUsdtKrwQuote()).resolves.toMatchObject({
      price: 1376.5,
    });
  });

  it('throws malformed response for missing KRW price', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      status: { timestamp: '2026-05-03T22:35:00.000Z', error_code: 0 },
      data: [{ id: 825, name: 'Tether USDt', symbol: 'USDT', slug: 'tether', quote: { KRW: {} } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = new CoinMarketCapProvider({
      baseUrl: 'https://pro-api.coinmarketcap.com',
      apiKey,
      timeoutMs: 5000,
      usdtId: 825,
    });

    await expect(provider.getUsdtKrwQuote()).rejects.toMatchObject({
      reason: 'coinmarketcap_price_missing',
    });
  });

  it('maps 429 to rate-limited and does not include the API key in log payloads', async () => {
    fetchMock.mockResolvedValue(new Response('rate limited', { status: 429 }));
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const provider = new CoinMarketCapProvider({
      baseUrl: 'https://pro-api.coinmarketcap.com',
      apiKey,
      timeoutMs: 5000,
      usdtId: 825,
    });

    await expect(provider.getUsdtKrwQuote()).rejects.toMatchObject({
      reason: 'coinmarketcap_rate_limited',
      statusCode: 429,
    });

    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(apiKey);
    expect(sanitizeSensitiveDetails({ apiKey })).toEqual({ apiKey: '[REDACTED]' });
  });
});
