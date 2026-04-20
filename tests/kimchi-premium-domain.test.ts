import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DomesticExchangeId } from '../src/core/exchange/exchange.types';

const domesticPriceByExchange: Record<DomesticExchangeId, number> = {
  upbit: 100000000,
  bithumb: 99900000,
  coinone: 99800000,
  korbit: 99700000,
};

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
    getMarketDataProvider: (exchange: string) => ({
      listMarkets: vi.fn(async () =>
        exchange === 'binance'
          ? [
              {
                symbol: 'BTC',
                market: 'BTC/USDT',
                baseCurrency: 'BTC',
                quoteCurrency: 'USDT',
                rawSymbol: 'BTCUSDT',
                exchangeSymbol: 'BTCUSDT',
                tradable: true,
              },
            ]
          : [
              {
                symbol: 'BTC',
                market: 'BTC/KRW',
                baseCurrency: 'BTC',
                quoteCurrency: 'KRW',
                rawSymbol: exchange === 'korbit' ? 'btc_krw' : `KRW-BTC`,
                exchangeSymbol: exchange === 'korbit' ? 'btc_krw' : `KRW-BTC`,
                tradable: true,
              },
            ]),
      getTickerSnapshot: vi.fn(async () =>
        exchange === 'binance'
          ? [
              {
                exchange,
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
              },
            ]
          : [
              {
                exchange,
                symbol: 'BTC',
                market: 'BTC/KRW',
                baseCurrency: 'BTC',
                quoteCurrency: 'KRW',
                rawSymbol: 'KRW-BTC',
                price: domesticPriceByExchange[exchange as DomesticExchangeId],
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
    vi.resetModules();
  });

  it('computes Binance reference KRW and domestic premium', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.binanceUsdtPrice).toBe(70000);
    expect(entry.binancePrice).toBe(70000);
    expect(entry.usdKrwRate).toBe(1350);
    expect(entry.binanceKrwPrice).toBe(94500000);
    expect(entry.premiumAmountKRW).toBe(5500000);
    expect(entry.updatedAt).toBe(1712345679000);
    expect(entry.sparkline).toHaveLength(1);
    expect(entry.sparklineSource).toBe('current_sample');
    expect(entry.sparklineStatus).toBe('insufficientData');
    expect(entry.sparklinePointCount).toBe(1);
    expect(entry.domestic[0].premiumPercent).toBeCloseTo(((100000000 - 94500000) / 94500000) * 100);
    expect(entry.stale).toBe(false);
    expect(entry.timestampSkewMs).toBe(1000);
  });

  it('selects the requested domestic venue for upbit, bithumb, coinone, and korbit', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    for (const venue of Object.keys(domesticPriceByExchange) as DomesticExchangeId[]) {
      const [entry] = await getKimchiPremium(['BTC'], { venues: [venue] });

      expect(entry.domesticVenue).toBe(venue);
      expect(entry.domesticExchange).toBe(venue);
      expect(entry.domestic).toHaveLength(1);
      expect(entry.domestic[0].exchange).toBe(venue);
      expect(entry.domesticPrice).toBe(domesticPriceByExchange[venue]);
      expect(entry.status).toBe('loaded');
    }
  });

  it('keeps unsupported symbols as partial failures without rejecting the whole response', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const entries = await getKimchiPremium(['BTC', 'NOTREAL']);

    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.symbol === 'BTC')).toMatchObject({
      status: 'loaded',
      errorCode: null,
    });
    expect(entries.find((entry) => entry.symbol === 'NOTREAL')).toMatchObject({
      status: 'unavailable',
      errorCode: 'SYMBOL_MAPPING_NOT_FOUND',
      domesticPrice: null,
      premiumPercent: null,
    });
  });
});
