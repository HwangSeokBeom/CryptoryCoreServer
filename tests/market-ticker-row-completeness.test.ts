import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/utils/logger';

const provider = {
  exchange: 'upbit',
  metadata: {
    displayName: '업비트',
    quoteCurrency: 'KRW',
  },
  listMarkets: vi.fn(),
  getTickerSnapshot: vi.fn(),
  getOrderbookSnapshot: vi.fn(),
  getRecentTrades: vi.fn(),
  getCandles: vi.fn(),
};

const publicMarketDataStore = {
  getTicker: vi.fn(() => null),
  getTickers: vi.fn(() => []),
  getTickerHistory: vi.fn(() => []),
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn(() => provider),
    listMarketDataProviders: vi.fn(() => [provider]),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

describe('market ticker row completeness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('includes volume and a fallback sparkline when history is unavailable', async () => {
    provider.listMarkets.mockResolvedValue([{ symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' }]);
    provider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100,
        change24h: 10,
        volume24h: 12345,
        high24h: 110,
        low24h: 90,
        timestamp: 1712345678000,
      },
    ]);

    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const response = await getTickers({ exchange: 'upbit', symbol: 'BTC' });
    const [ticker] = response.items;

    expect(ticker.volume24h).toBe(12345);
    expect(ticker.current).toBe(100);
    expect(ticker.percent).toBe(10);
    expect(ticker.previousPrice24h).toBeCloseTo(90.9090909);
    expect(ticker.sparklineSource).toBe('derived_change24h');
    expect(ticker.sparkline).toHaveLength(2);
    expect(ticker.sparklinePoints[0].timestamp).toBe(1712259278000);
    expect(ticker.sparklinePoints[0].price).toBeCloseTo(90.9090909);
    expect(ticker.sparklinePoints[1]).toEqual({ price: 100, timestamp: 1712345678000 });
    expect(ticker.dataMode).toBe('snapshot');
    expect(ticker.cacheAgeMs).not.toBeNull();
  });

  it('logs count differences and separates not-listed from upstream-missing symbols', async () => {
    provider.listMarkets.mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
    ]);
    provider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100,
        change24h: 10,
        volume24h: 12345,
        high24h: 110,
        low24h: 90,
        timestamp: 1712345678000,
      },
    ]);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const response = await getTickers({ exchange: 'upbit' });
    const tickers = response.items;

    expect(tickers.map((ticker) => ticker.symbol)).toEqual(['BTC']);
    const logCall = infoSpy.mock.calls.find(([, message]) => message === 'Resolved market ticker request');

    expect(logCall?.[0]).toMatchObject({
      operation: 'tickers',
      exchange: 'upbit',
      returnedSymbols: ['BTC'],
    });
    expect(logCall?.[0]).toMatchObject({
      droppedSymbols: expect.arrayContaining([
        { symbol: 'ETH', reason: 'missing_from_provider_snapshot' },
      ]),
      totalAvailableCount: 2,
    });
  });

  it('returns canonicalAssetKey, hasImage, and imageUrl consistently for aliased assets', async () => {
    provider.listMarkets.mockResolvedValue([{ symbol: 'RNDR', market: 'RNDR/KRW', rawSymbol: 'KRW-RNDR' }]);
    provider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'RNDR',
        market: 'RNDR/KRW',
        baseCurrency: 'RNDR',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-RNDR',
        price: 10,
        change24h: 1.5,
        volume24h: 9876,
        high24h: 11,
        low24h: 9,
        timestamp: 1712345678000,
      },
    ]);

    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const response = await getTickers({ exchange: 'upbit', symbol: 'RNDR' });
    const [ticker] = response.items;

    expect(ticker.canonicalAssetKey).toBe('RENDER');
    expect(ticker.hasImage).toBe(true);
    expect(ticker.imageAvailability).toBe('fallback');
    expect(ticker.fallbackType).toBe('symbol_alias');
    expect(ticker.imageUrl).toBeTruthy();
    expect(ticker.imageURL).toBe(ticker.imageUrl);
    expect(ticker.assetImageUrl).toBe(ticker.imageUrl);
  });

  it('keeps unresolved default placeholders as image misses with client-aligned log keys', async () => {
    provider.listMarkets.mockResolvedValue([{ symbol: 'FAKE', market: 'FAKE/KRW', rawSymbol: 'KRW-FAKE' }]);
    provider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'FAKE',
        market: 'FAKE/KRW',
        baseCurrency: 'FAKE',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-FAKE',
        price: 10,
        change24h: 1.5,
        volume24h: 9876,
        high24h: 11,
        low24h: 9,
        timestamp: 1712345678000,
      },
    ]);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const response = await getTickers({ exchange: 'upbit', symbol: 'FAKE' });
    const [ticker] = response.items;

    expect(ticker.canonicalAssetKey).toBe('FAKE');
    expect(ticker.hasImage).toBe(false);
    expect(ticker.imageAvailability).toBe('pending');
    expect(ticker.imageFailureReason).toBe('missing_metadata');
    expect(ticker.imageMissingReason).toBe('missing_curated_mapping');
    expect(ticker.imageUrl).toBeNull();
    expect(ticker.imageURL).toBeNull();
    expect(ticker.assetImageUrl).toBeNull();

    const imageMissLog = infoSpy.mock.calls.find(([payload]) =>
      typeof payload === 'object'
      && payload !== null
      && 'action' in payload
      && payload.action === 'image_miss'
      && 'symbol' in payload
      && payload.symbol === 'FAKE');
    expect(imageMissLog?.[0]).toMatchObject({
      exchange: 'upbit',
      symbol: 'FAKE',
      clientSymbolKey: 'upbit:FAKE',
      canonicalAssetKey: 'FAKE',
      reason: 'missing_curated_mapping',
    });

    const coverageLog = infoSpy.mock.calls.find(([payload]) =>
      typeof payload === 'object'
      && payload !== null
      && 'action' in payload
      && payload.action === 'coverage_summary'
      && 'exchange' in payload
      && payload.exchange === 'upbit');
    expect(coverageLog?.[0]).toMatchObject({
      totalCount: 1,
      withImageCount: 0,
      coverage: 0,
      falseReasonStats: {
        missing_curated_mapping: 1,
      },
    });
  });
});
