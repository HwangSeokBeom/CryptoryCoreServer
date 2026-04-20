import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  getCandles: vi.fn(),
};

const publicMarketDataStore = {
  upsertCandle: vi.fn(),
  getCandle: vi.fn(() => null),
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn(() => provider),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

describe('chart service', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_730_000);
    provider.getCandles.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        interval: '1m',
        openTime: 1_712_345_560_000,
        closeTime: 1_712_345_620_000,
        open: 99_000_000,
        high: 99_500_000,
        low: 98_900_000,
        close: 99_200_000,
        volume: 10,
      },
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        interval: '1m',
        openTime: 1_712_345_620_000,
        closeTime: 1_712_345_680_000,
        open: 99_200_000,
        high: 99_700_000,
        low: 99_100_000,
        close: 99_600_000,
        volume: 12,
      },
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        interval: '1m',
        openTime: 1_712_345_680_000,
        closeTime: 1_712_345_740_000,
        open: 99_600_000,
        high: 100_000_000,
        low: 99_500_000,
        close: 99_900_000,
        volume: 1.5,
      },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { stopChartLiveService } = await import('../src/domains/charts/chart.service');
    stopChartLiveService();
  });

  it('returns settled history and splits the current candle into a live payload', async () => {
    const { getChartCandles } = await import('../src/domains/charts/chart.service');
    const response = await getChartCandles({
      exchange: 'upbit',
      symbol: 'BTC',
      interval: '1m',
      limit: 2,
    });

    expect(response.items).toHaveLength(2);
    expect(response.items[0]?.openTime).toBe(1_712_345_560_000);
    expect(response.live).toMatchObject({
      interval: '1m',
      openTime: 1_712_345_680_000,
      close: 99_900_000,
      sourceEvent: 'seed',
    });
    expect(response.liveStatus).toBe('live');
    expect(publicMarketDataStore.upsertCandle).toHaveBeenCalled();
  });

  it('normalizes uppercase interval aliases before calling the provider', async () => {
    provider.getCandles.mockResolvedValueOnce([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        interval: '1h',
        openTime: 1_712_342_400_000,
        closeTime: 1_712_346_000_000,
        open: 99_000_000,
        high: 100_000_000,
        low: 98_500_000,
        close: 99_700_000,
        volume: 12,
      },
    ]);

    const { getChartCandles } = await import('../src/domains/charts/chart.service');
    const response = await getChartCandles({
      exchange: 'upbit',
      symbol: 'BTC',
      interval: '1H',
      limit: 2,
    });

    expect(provider.getCandles).toHaveBeenCalledWith('BTC', '1h', 3);
    expect(response.interval).toBe('1h');
    expect(response.support).toBe('supported');
  });

  it('returns stale cached candles when the provider refresh fails after the cache expires', async () => {
    const { getChartCandles } = await import('../src/domains/charts/chart.service');

    const first = await getChartCandles({
      exchange: 'upbit',
      symbol: 'BTC',
      interval: '1m',
      limit: 2,
    });
    expect(first.status).toBe('loaded');

    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_736_500);
    provider.getCandles.mockRejectedValueOnce(new Error('upstream timed out'));

    const second = await getChartCandles({
      exchange: 'upbit',
      symbol: 'BTC',
      interval: '1m',
      limit: 2,
    });

    expect(second.status).toBe('stale');
    expect(second.source).toBe('stale_cache');
    expect(second.staleCacheUsed).toBe(true);
    expect(second.items).toHaveLength(2);
  });
});
