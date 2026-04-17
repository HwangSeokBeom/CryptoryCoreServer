import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    listMarketDataProviders: () => [],
    getMarketDataProvider: () => ({
      getTickerSnapshot: vi.fn(async () => [
        {
          exchange: 'upbit',
          symbol: 'BTC',
          market: 'BTC/KRW',
          baseCurrency: 'BTC',
          quoteCurrency: 'KRW',
          rawSymbol: 'KRW-BTC',
          price: 100000000,
          change24h: 0,
          volume24h: 0,
          high24h: 0,
          low24h: 0,
          timestamp: 1712340000000,
        },
      ]),
      getOrderbookSnapshot: vi.fn(),
      getRecentTrades: vi.fn(),
      getCandles: vi.fn(),
    }),
    getFxRateProvider: () => ({
      getUsdKrwRate: vi.fn(async () => ({
        pair: 'USD/KRW',
        rate: 1350,
        timestamp: 1712340000000,
        staleAt: 1712340300000,
        provider: 'test-fx',
      })),
    }),
    getReferencePriceSource: () => ({
      getReferenceTicker: vi.fn(async () => ({
        exchange: 'binance',
        symbol: 'BTC',
        market: 'BTC/USDT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        rawSymbol: 'BTCUSDT',
        price: 70000,
        change24h: 0,
        volume24h: 0,
        high24h: 0,
        low24h: 0,
        timestamp: 1712340000000,
      })),
    }),
  },
}));

describe('Stale Data Guard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks stale market snapshots when source timestamp exceeds threshold', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712340400000);
    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const [ticker] = await getTickers({ exchange: 'upbit', symbol: 'BTC' });

    expect(ticker.sourceTimestamp).toBe(1712340000000);
    expect(ticker.stale).toBe(true);
    expect(ticker.staleAgeMs).toBe(400000);
  });

  it('marks kimchi premium as stale when source skew or age exceeds threshold', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712340400000);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.fxStale).toBe(true);
    expect(entry.referenceStale).toBe(true);
    expect(entry.stale).toBe(true);
  });
});
