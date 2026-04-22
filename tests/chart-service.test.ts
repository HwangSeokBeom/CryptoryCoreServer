import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  listMarkets: vi.fn(),
  getMarketCapabilitySnapshot: vi.fn(),
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
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        marketId: 'KRW-BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['BTC'],
      capabilitySymbols: {
        tickers: ['BTC'],
        orderbook: ['BTC'],
        trades: ['BTC'],
        candles: ['BTC'],
      },
    });
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

    expect(provider.getCandles).toHaveBeenCalledWith('BTC', '1h', 60);
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

  it('resolves pair-like Korbit stablecoin symbols to the listed market key for detail charts', async () => {
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'USDT',
        exchangeSymbol: 'usdt_krw',
        marketId: 'usdt_krw',
        market: 'USDT/KRW',
        baseCurrency: 'USDT',
        quoteCurrency: 'KRW',
        rawSymbol: 'usdt_krw',
        tradable: true,
      },
      {
        symbol: 'XRP',
        exchangeSymbol: 'xrp_krw',
        marketId: 'xrp_krw',
        market: 'XRP/KRW',
        baseCurrency: 'XRP',
        quoteCurrency: 'KRW',
        rawSymbol: 'xrp_krw',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['USDT', 'XRP'],
      capabilitySymbols: {
        tickers: ['USDT', 'XRP'],
        orderbook: ['USDT', 'XRP'],
        trades: ['USDT', 'XRP'],
        candles: ['USDT', 'XRP'],
      },
    });
    provider.getCandles.mockResolvedValueOnce([
      {
        exchange: 'korbit',
        symbol: 'USDT',
        market: 'USDT/KRW',
        baseCurrency: 'USDT',
        quoteCurrency: 'KRW',
        rawSymbol: 'usdt_krw',
        interval: '1h',
        openTime: 1_712_338_800_000,
        closeTime: 1_712_342_400_000,
        open: 1450,
        high: 1452,
        low: 1448,
        close: 1451,
        volume: 1000,
      },
      {
        exchange: 'korbit',
        symbol: 'USDT',
        market: 'USDT/KRW',
        baseCurrency: 'USDT',
        quoteCurrency: 'KRW',
        rawSymbol: 'usdt_krw',
        interval: '1h',
        openTime: 1_712_342_400_000,
        closeTime: 1_712_346_000_000,
        open: 1451,
        high: 1454,
        low: 1450,
        close: 1453,
        volume: 900,
      },
      {
        exchange: 'korbit',
        symbol: 'USDT',
        market: 'USDT/KRW',
        baseCurrency: 'USDT',
        quoteCurrency: 'KRW',
        rawSymbol: 'usdt_krw',
        interval: '1h',
        openTime: 1_712_346_000_000,
        closeTime: 1_712_349_600_000,
        open: 1453,
        high: 1455,
        low: 1452,
        close: 1454,
        volume: 1100,
      },
    ]);

    const { getChartCandles } = await import('../src/domains/charts/chart.service');
    const response = await getChartCandles({
      exchange: 'korbit',
      symbol: 'USDT_KRW',
      interval: '1h',
      limit: 2,
    });

    expect(provider.getCandles).toHaveBeenCalledWith('USDT', '1h', 60);
    expect(response.marketId).toBe('usdt_krw');
    expect(response.canonicalSymbol).toBe('USDT');
    expect(response.graphSupported).toBe(true);
    expect(response.meta.isRenderable).toBe(true);
  });
});
