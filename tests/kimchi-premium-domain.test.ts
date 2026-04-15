import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getFxRateProvider: () => ({
      getUsdKrwRate: vi.fn(async () => ({
        pair: 'USD/KRW',
        rate: 1350,
        timestamp: 1712345678000,
        staleAt: 1712345978000,
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
        timestamp: 1712345678000,
      })),
    }),
    getMarketDataProvider: (exchange: string) => ({
      getTickerSnapshot: vi.fn(async () => [
        {
          exchange,
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
          timestamp: 1712345679000,
        },
      ]),
    }),
  },
}));

describe('Kimchi Premium Domain', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('computes Binance reference KRW and domestic premium', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.binanceUsdtPrice).toBe(70000);
    expect(entry.usdKrwRate).toBe(1350);
    expect(entry.binanceKrwPrice).toBe(94500000);
    expect(entry.domestic[0].premiumPercent).toBeCloseTo(((100000000 - 94500000) / 94500000) * 100);
    expect(entry.stale).toBe(false);
    expect(entry.timestampSkewMs).toBe(1000);
  });
});
