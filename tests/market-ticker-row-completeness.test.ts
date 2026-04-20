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
});
