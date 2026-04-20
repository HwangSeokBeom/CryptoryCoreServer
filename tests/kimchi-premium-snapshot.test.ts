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
          : exchange === 'upbit'
            ? [
                {
                  symbol: 'BTC',
                  market: 'BTC/KRW',
                  baseCurrency: 'BTC',
                  quoteCurrency: 'KRW',
                  rawSymbol: 'KRW-BTC',
                  exchangeSymbol: 'KRW-BTC',
                  tradable: true,
                },
              ]
            : []),
      getTickerSnapshot: providerSnapshots[exchange],
    }),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore: {
    getTicker: vi.fn(() => null),
    getTickerHistory: vi.fn(() => []),
  },
}));

function createTicker(params: {
  exchange: 'binance' | 'upbit';
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

describe('kimchi premium snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
    getUsdKrwRate.mockRejectedValue(new Error('fx down'));
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
    providerSnapshots.upbit.mockResolvedValue([
      createTicker({
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100000000,
        timestamp: 1712345679000,
      }),
    ]);
    providerSnapshots.bithumb.mockResolvedValue([]);
    providerSnapshots.coinone.mockResolvedValue([]);
    providerSnapshots.korbit.mockResolvedValue([]);
  });

  it('returns partial success when one pair is usable and another symbol fails mapping/support resolution', async () => {
    const { getKimchiPremiumSnapshot } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const response = await getKimchiPremiumSnapshot(['BTC', 'OG'], { venues: ['upbit'] });

    expect(response.status).toBe('partial_success');
    expect(response.supportedPairs).toEqual(['BTC']);
    expect(response.items.find((entry) => entry.symbol === 'BTC')).toMatchObject({
      status: 'partial',
      errorCode: 'FX_RATE_UNAVAILABLE',
      domesticPrice: 100000000,
      binanceUsdtPrice: 70000,
      premiumPercent: null,
      stableStatus: 'partial',
      hasUsableDomesticPrice: true,
      hasUsableReferencePrice: true,
      hasUsableFxRate: false,
      displayHint: 'keep_last_good',
    });
    expect(response.items.find((entry) => entry.symbol === 'OG')).toMatchObject({
      status: 'unavailable',
      errorCode: 'SYMBOL_MAPPING_NOT_FOUND',
    });
    expect(response.partialFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'BTC', code: 'FX_RATE_UNAVAILABLE', exchange: 'fx' }),
      expect.objectContaining({ symbol: 'OG', code: 'SYMBOL_MAPPING_NOT_FOUND' }),
    ]));
  });
});
