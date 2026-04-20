import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUsdKrwRate = vi.fn();
const providerSnapshots = {
  binance: vi.fn(),
  upbit: vi.fn(),
  bithumb: vi.fn(),
  coinone: vi.fn(),
  korbit: vi.fn(),
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getFxRateProvider: () => ({
      getUsdKrwRate,
    }),
    getMarketDataProvider: (exchange: keyof typeof providerSnapshots) => ({
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
                rawSymbol: `KRW-BTC`,
                exchangeSymbol: `KRW-BTC`,
                tradable: true,
              },
            ]),
      getTickerSnapshot: providerSnapshots[exchange],
    }),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore: {
    getTicker: vi.fn(() => null),
  },
}));

function createTicker(params: {
  exchange: 'binance' | 'upbit' | 'bithumb' | 'coinone' | 'korbit';
  symbol: string;
  market: string;
  quoteCurrency: 'KRW' | 'USDT';
  rawSymbol: string;
  price: number;
  timestamp: number;
}) {
  return {
    exchange: params.exchange,
    symbol: params.symbol,
    market: params.market,
    baseCurrency: params.symbol,
    quoteCurrency: params.quoteCurrency,
    rawSymbol: params.rawSymbol,
    price: params.price,
    change24h: 0,
    volume24h: 0,
    high24h: 0,
    low24h: 0,
    timestamp: params.timestamp,
  };
}

describe('Kimchi premium settled statuses', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('settles rows as partial when domestic price is missing but reference is ready', async () => {
    getUsdKrwRate.mockResolvedValue({
      pair: 'USD/KRW',
      rate: 1350,
      timestamp: 1712345678000,
      staleAt: 1712345978000,
      provider: 'test-fx',
    });
    providerSnapshots.binance.mockResolvedValue([
      createTicker({
        exchange: 'binance',
        symbol: 'BTC',
        market: 'BTC/USDT',
        quoteCurrency: 'USDT',
        rawSymbol: 'BTCUSDT',
        price: 70000,
        timestamp: 1712345678000,
      }),
    ]);
    providerSnapshots.upbit.mockResolvedValue([]);
    providerSnapshots.bithumb.mockResolvedValue([]);
    providerSnapshots.coinone.mockResolvedValue([]);
    providerSnapshots.korbit.mockResolvedValue([]);

    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.status).toBe('partial');
    expect(entry.failureStage).toBe('domestic_ticker');
    expect(entry.binanceKrwPrice).toBe(94500000);
    expect(entry.domesticPrice).toBeNull();
    expect(entry.premiumPercent).toBeNull();
    expect(entry.missingFields).toEqual(['domesticPrice', 'premiumPercent']);
  });

  it('settles rows as unavailable when no reference or domestic ticker can be resolved', async () => {
    getUsdKrwRate.mockResolvedValue({
      pair: 'USD/KRW',
      rate: 1350,
      timestamp: 1712345678000,
      staleAt: 1712345978000,
      provider: 'test-fx',
    });
    providerSnapshots.binance.mockResolvedValue([]);
    providerSnapshots.upbit.mockResolvedValue([]);
    providerSnapshots.bithumb.mockResolvedValue([]);
    providerSnapshots.coinone.mockResolvedValue([]);
    providerSnapshots.korbit.mockResolvedValue([]);

    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.status).toBe('unavailable');
    expect(entry.failureStage).toBe('reference_ticker');
    expect(entry.binanceKrwPrice).toBeNull();
    expect(entry.domesticPrice).toBeNull();
    expect(entry.missingFields).toEqual(['convertedReferencePrice', 'domesticPrice', 'premiumPercent', 'referencePrice']);
  });

  it('settles rows as failed when upstream providers error and no fallback data exists', async () => {
    getUsdKrwRate.mockRejectedValue(new Error('fx down'));
    providerSnapshots.binance.mockRejectedValue(new Error('binance down'));
    providerSnapshots.upbit.mockRejectedValue(new Error('upbit down'));
    providerSnapshots.bithumb.mockRejectedValue(new Error('bithumb down'));
    providerSnapshots.coinone.mockRejectedValue(new Error('coinone down'));
    providerSnapshots.korbit.mockRejectedValue(new Error('korbit down'));

    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC']);

    expect(entry.status).toBe('failed');
    expect(entry.failureStage).toBe('reference_ticker');
    expect(entry.binanceKrwPrice).toBeNull();
    expect(entry.domesticPrice).toBeNull();
    expect(entry.missingFields).toEqual(['convertedReferencePrice', 'domesticPrice', 'premiumPercent', 'referencePrice', 'usdKrwRate']);
  });
});
