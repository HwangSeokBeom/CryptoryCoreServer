import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const redisStore = new Map<string, string>();
const mgetMock = vi.fn(async (keys: string[]) => keys.map((key) => redisStore.get(key) ?? null));
const setMock = vi.fn(async (key: string, value: string) => {
  redisStore.set(key, value);
  return 'OK';
});
const requestMock = vi.fn();
const DEFAULT_PLACEHOLDER_IMAGE_URL = 'https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/generic.png';
const BTC_ICON_URL = 'https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/btc.png';
const POL_ICON_URL = 'https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/matic.png';

vi.mock('../src/config/redis', () => ({
  redis: {
    mget: mgetMock,
    set: setMock,
  },
}));

vi.mock('../src/config/env', () => ({
  env: {
    COINGECKO_API_BASE_URL: 'https://api.coingecko.com/api/v3',
    COINGECKO_API_KEY: undefined,
  },
}));

vi.mock('../src/core/exchange/rest.client', () => ({
  RestClient: class {
    async request<T>(path: string, options?: unknown) {
      return requestMock(path, options) as Promise<T>;
    }

    async requestDetailed<T>(path: string, options?: unknown) {
      const data = await requestMock(path, options) as T;
      return {
        data,
        meta: {
          owner: 'coingecko',
          path,
          requestUrl: `https://api.coingecko.com/api/v3${path}`,
          statusCode: 200,
          responseSnippet: JSON.stringify(Array.isArray(data) ? data.slice(0, 2) : data).slice(0, 240),
        },
      };
    }
  },
}));

describe('asset metadata service', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-20T00:00:00.000Z'));
    vi.resetModules();
    redisStore.clear();
    mgetMock.mockClear();
    setMock.mockClear();
    requestMock.mockReset();
  });

  afterEach(async () => {
    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.resetForTests();
    vi.useRealTimers();
  });

  it('returns persistent cache hits without triggering CoinGecko lookups', async () => {
    const now = Date.now();
    redisStore.set(
      'asset:metadata:v1:BTC',
      JSON.stringify({
        canonicalAssetKey: 'BTC',
        coingeckoId: 'bitcoin',
        imageUrl: 'https://assets.example.com/btc.png',
        symbol: 'BTC',
        name: 'Bitcoin',
        updatedAt: now,
        source: 'curated',
        confidence: 'high',
        isNegativeCache: false,
        staleAt: now + 60_000,
        usableUntil: now + 300_000,
      }),
    );

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    const views = await assetMetadataService.getAssetViews([
      { exchange: 'upbit', symbol: 'BTC', displayName: 'Bitcoin' },
    ]);

    expect(views.get('BTC')).toMatchObject({
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
      coingeckoId: 'bitcoin',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('lazy-resolves image metadata in the background and reuses it on the next read', async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/markets') {
        return [{
          id: 'bitcoin',
          symbol: 'btc',
          name: 'Bitcoin',
          image: 'https://assets.example.com/btc.png',
        }];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    const first = await assetMetadataService.getAssetViews([
      { exchange: 'upbit', symbol: 'BTC', displayName: 'Bitcoin' },
    ]);
    expect(first.get('BTC')).toMatchObject({
      canonicalAssetKey: 'BTC',
      assetImageUrl: BTC_ICON_URL,
      coingeckoId: 'bitcoin',
      fallbackHit: true,
    });

    await vi.advanceTimersByTimeAsync(100);

    const second = await assetMetadataService.getAssetViews([
      { exchange: 'upbit', symbol: 'BTC', displayName: 'Bitcoin' },
    ]);
    expect(second.get('BTC')).toMatchObject({
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
      coingeckoId: 'bitcoin',
    });
    expect(requestMock).toHaveBeenCalledWith('/coins/markets', expect.any(Object));
  });

  it('stores a placeholder fallback for ambiguous or missing mappings and avoids repeated market lookups', async () => {
    requestMock.mockResolvedValue([
      { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin' },
      { id: 'ethereum', symbol: 'eth', name: 'Ethereum' },
    ]);

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    const first = await assetMetadataService.getAssetViews([
      { exchange: 'upbit', symbol: 'FAKE', displayName: 'Fake Coin' },
    ]);
    expect(first.get('FAKE')).toMatchObject({
      canonicalAssetKey: 'FAKE',
      assetImageUrl: DEFAULT_PLACEHOLDER_IMAGE_URL,
      fallbackType: 'default_placeholder',
    });

    await vi.advanceTimersByTimeAsync(100);

    const second = await assetMetadataService.getAssetViews([
      { exchange: 'upbit', symbol: 'FAKE', displayName: 'Fake Coin' },
    ]);
    expect(second.get('FAKE')).toMatchObject({
      canonicalAssetKey: 'FAKE',
      assetImageUrl: DEFAULT_PLACEHOLDER_IMAGE_URL,
      coingeckoId: null,
      failureReason: 'alias_not_found',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenLastCalledWith('/coins/list', expect.any(Object));
  });

  it('resolves representative assets through curated CoinGecko ids without a coin list lookup', async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/markets') {
        return [
          { id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: 'https://assets.example.com/btc.png' },
          { id: 'ethereum', symbol: 'eth', name: 'Ethereum', image: 'https://assets.example.com/eth.png' },
          { id: 'ripple', symbol: 'xrp', name: 'XRP', image: 'https://assets.example.com/xrp.png' },
          { id: 'cardano', symbol: 'ada', name: 'Cardano', image: 'https://assets.example.com/ada.png' },
          { id: 'solana', symbol: 'sol', name: 'Solana', image: 'https://assets.example.com/sol.png' },
          { id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', image: 'https://assets.example.com/doge.png' },
          { id: 'tether', symbol: 'usdt', name: 'Tether', image: 'https://assets.example.com/usdt.png' },
        ];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    await assetMetadataService.getAssetViews([
      { symbol: 'BTC', displayName: 'Bitcoin' },
      { symbol: 'ETH', displayName: 'Ethereum' },
      { symbol: 'XRP', displayName: 'XRP' },
      { symbol: 'ADA', displayName: 'Cardano' },
      { symbol: 'SOL', displayName: 'Solana' },
      { symbol: 'DOGE', displayName: 'Dogecoin' },
      { symbol: 'USDT', displayName: 'Tether' },
    ]);

    await vi.advanceTimersByTimeAsync(100);

    const views = await assetMetadataService.getAssetViews([
      { symbol: 'BTC' },
      { symbol: 'ETH' },
      { symbol: 'XRP' },
      { symbol: 'ADA' },
      { symbol: 'SOL' },
      { symbol: 'DOGE' },
      { symbol: 'USDT' },
    ]);

    expect(views.get('BTC')?.assetImageUrl).toBe('https://assets.example.com/btc.png');
    expect(views.get('ETH')?.assetImageUrl).toBe('https://assets.example.com/eth.png');
    expect(views.get('XRP')?.assetImageUrl).toBe('https://assets.example.com/xrp.png');
    expect(views.get('ADA')?.assetImageUrl).toBe('https://assets.example.com/ada.png');
    expect(views.get('SOL')?.assetImageUrl).toBe('https://assets.example.com/sol.png');
    expect(views.get('DOGE')?.assetImageUrl).toBe('https://assets.example.com/doge.png');
    expect(views.get('USDT')?.assetImageUrl).toBe('https://assets.example.com/usdt.png');
    expect(requestMock.mock.calls.some(([path]) => path === '/coins/list')).toBe(false);
  });

  it('does not let an incoming null image overwrite an existing resolved image', async () => {
    const now = Date.now();
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/markets') {
        return [{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', image: null }];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.primeForTests([
      {
        canonicalAssetKey: 'BTC',
        coingeckoId: 'bitcoin',
        imageUrl: 'https://assets.example.com/btc.png',
        symbol: 'BTC',
        name: 'Bitcoin',
        updatedAt: now - 60_000,
        source: 'curated',
        confidence: 'high',
        isNegativeCache: false,
        staleAt: now - 1,
        usableUntil: now + 300_000,
      },
    ]);
    assetMetadataService.start();

    const first = await assetMetadataService.getAssetViews([{ symbol: 'BTC', displayName: 'Bitcoin' }]);
    expect(first.get('BTC')?.assetImageUrl).toBe('https://assets.example.com/btc.png');

    await vi.advanceTimersByTimeAsync(100);

    const second = await assetMetadataService.getAssetViews([{ symbol: 'BTC', displayName: 'Bitcoin' }]);
    expect(second.get('BTC')).toMatchObject({
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
      coingeckoId: 'bitcoin',
    });
  });

  it('keeps symbol collisions null-safe when CoinGecko candidates are ambiguous', async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/list') {
        return [
          { id: 'alpha-beta-coin', symbol: 'abc', name: 'Alpha Beta Coin' },
          { id: 'another-blockchain-coin', symbol: 'abc', name: 'Another Blockchain Coin' },
        ];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    await assetMetadataService.getAssetViews([{ symbol: 'ABC', displayName: 'Ambiguous Coin' }]);
    await vi.advanceTimersByTimeAsync(100);

    const view = await assetMetadataService.getAssetViews([{ symbol: 'ABC', displayName: 'Ambiguous Coin' }]);

    expect(view.get('ABC')).toMatchObject({
      canonicalAssetKey: 'ABC',
      assetImageUrl: DEFAULT_PLACEHOLDER_IMAGE_URL,
      coingeckoId: null,
      failureReason: 'alias_not_found',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenLastCalledWith('/coins/list', expect.any(Object));
  });

  it('falls back to a placeholder image when CoinGecko coin list fetch fails', async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/list') {
        const error = new Error('coingecko request failed with HTTP 404');
        Object.assign(error, {
          exchange: 'coingecko',
          statusCode: 404,
          requestUrl: 'https://api.coingecko.com/api/v3/coins/list',
          responseBody: 'not found',
        });
        throw error;
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    const first = await assetMetadataService.getAssetViews([{ symbol: 'NEWT', displayName: 'New Token' }]);
    expect(first.get('NEWT')).toMatchObject({
      canonicalAssetKey: 'NEWT',
      assetImageUrl: DEFAULT_PLACEHOLDER_IMAGE_URL,
      fallbackType: 'default_placeholder',
    });

    await vi.advanceTimersByTimeAsync(100);

    const second = await assetMetadataService.getAssetViews([{ symbol: 'NEWT', displayName: 'New Token' }]);
    expect(second.get('NEWT')).toMatchObject({
      canonicalAssetKey: 'NEWT',
      assetImageUrl: DEFAULT_PLACEHOLDER_IMAGE_URL,
      failureReason: 'coingecko_fetch_failed',
    });
  });

  it('uses the local alias table for POL before remote market enrichment completes', async () => {
    requestMock.mockImplementation(async (path: string) => {
      if (path === '/coins/markets') {
        return [{
          id: 'polygon-ecosystem-token',
          symbol: 'pol',
          name: 'POL (ex-MATIC)',
          image: 'https://assets.example.com/pol.png',
        }];
      }
      throw new Error(`Unexpected path ${path}`);
    });

    const { assetMetadataService } = await import('../src/domains/assets/asset-metadata.service');
    assetMetadataService.start();

    const first = await assetMetadataService.getAssetViews([{ symbol: 'POL', displayName: 'POL (ex-MATIC)' }]);
    expect(first.get('POL')).toMatchObject({
      canonicalAssetKey: 'POL',
      assetImageUrl: POL_ICON_URL,
      coingeckoId: 'polygon-ecosystem-token',
      fallbackType: 'symbol_alias',
    });

    await vi.advanceTimersByTimeAsync(100);

    const second = await assetMetadataService.getAssetViews([{ symbol: 'POL', displayName: 'POL (ex-MATIC)' }]);
    expect(second.get('POL')).toMatchObject({
      canonicalAssetKey: 'POL',
      assetImageUrl: 'https://assets.example.com/pol.png',
      coingeckoId: 'polygon-ecosystem-token',
    });
  });
});
