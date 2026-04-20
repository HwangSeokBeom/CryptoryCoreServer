import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomesticExchangeId, ExchangeId } from '../src/core/exchange/exchange.types';

const getUsdKrwRate = vi.fn();
const providerSnapshots: Record<ExchangeId, ReturnType<typeof vi.fn>> = {
  binance: vi.fn(),
  upbit: vi.fn(),
  bithumb: vi.fn(),
  coinone: vi.fn(),
  korbit: vi.fn(),
};

const domesticPrices: Record<DomesticExchangeId, number> = {
  upbit: 100000000,
  bithumb: 99900000,
  coinone: 99800000,
  korbit: 99700000,
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getFxRateProvider: () => ({
      getUsdKrwRate,
    }),
    getMarketDataProvider: (exchange: ExchangeId) => ({
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
  exchange: ExchangeId;
  price: number;
  timestamp: number;
}) {
  return {
    exchange: params.exchange,
    symbol: 'BTC',
    market: params.exchange === 'binance' ? 'BTC/USDT' : 'BTC/KRW',
    baseCurrency: 'BTC',
    quoteCurrency: params.exchange === 'binance' ? 'USDT' : 'KRW',
    rawSymbol: params.exchange === 'binance' ? 'BTCUSDT' : 'KRW-BTC',
    price: params.price,
    change24h: 0,
    volume24h: 0,
    high24h: 0,
    low24h: 0,
    timestamp: params.timestamp,
  };
}

function setupFreshMocks(now: number) {
  getUsdKrwRate.mockResolvedValue({
    pair: 'USD/KRW',
    rate: 1350,
    timestamp: now - 1000,
    staleAt: now + 300000,
    provider: 'test-fx',
  });
  providerSnapshots.binance.mockResolvedValue([
    createTicker({ exchange: 'binance', price: 70000, timestamp: now - 1000 }),
  ]);
  (Object.keys(domesticPrices) as DomesticExchangeId[]).forEach((exchange) => {
    providerSnapshots[exchange].mockResolvedValue([
      createTicker({ exchange, price: domesticPrices[exchange], timestamp: now - 500 }),
    ]);
  });
}

describe('kimchi premium freshness and degraded responses', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setupFreshMocks(1712345680000);
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
  });

  it('marks fully current domestic, global, and FX inputs as fresh', async () => {
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC'], { venues: ['upbit'] });

    expect(entry.status).toBe('loaded');
    expect(entry.freshnessState).toBe('fresh');
    expect(entry.freshnessReason).toBe('all_sources_fresh');
    expect(entry.domesticPriceTimestamp).toBe(1712345679500);
    expect(entry.globalPriceTimestamp).toBe(1712345679000);
    expect(entry.fxRateTimestamp).toBe(1712345679000);
    expect(entry.computedAt).toBe(1712345680000);
  });

  it('keeps the card computable when the global reference is slightly stale', async () => {
    providerSnapshots.binance.mockResolvedValue([
      createTicker({ exchange: 'binance', price: 70000, timestamp: 1712345680000 - 6000 }),
    ]);
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC'], { venues: ['upbit'] });

    expect(entry.premiumPercent).toBeTypeOf('number');
    expect(entry.freshnessState).toBe('slightly_stale');
    expect(entry.freshnessReason).toContain('global_price_delayed');
    expect(entry.status).toBe('loaded');
  });

  it('returns a partial degraded card when Coinone ticker loading times out', async () => {
    providerSnapshots.coinone.mockRejectedValue(new Error('coinone ticker snapshot timed out after 1800ms'));
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC'], { venues: ['coinone'] });

    expect(entry.selectedExchange).toBe('coinone');
    expect(entry.sourceExchange).toBeNull();
    expect(entry.status).toBe('partial');
    expect(entry.freshnessState).toBe('partial');
    expect(entry.errorCode).toBe('EXCHANGE_TEMPORARILY_UNAVAILABLE');
    expect(entry.binanceKrwPrice).toBe(94500000);
    expect(entry.stableStatus).toBe('partial');
    expect(entry.hasUsableReferencePrice).toBe(true);
    expect(entry.hasUsableFxRate).toBe(true);
    expect(entry.hasUsableDomesticPrice).toBe(false);
    expect(entry.displayHint).toBe('keep_last_good');
  });

  it('distinguishes cold start unavailable from stale usable last-known-good data', async () => {
    providerSnapshots.binance.mockRejectedValueOnce(new Error('binance down'));
    providerSnapshots.upbit.mockRejectedValueOnce(new Error('upbit down'));
    getUsdKrwRate.mockRejectedValueOnce(new Error('fx down'));

    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [cold] = await getKimchiPremium(['BTC'], { venues: ['upbit'], requestKind: 'visible' });

    expect(cold.stableStatus).toBe('unavailable');
    expect(cold.hasUsableDomesticPrice).toBe(false);
    expect(cold.hasUsableReferencePrice).toBe(false);
    expect(cold.hasUsableFxRate).toBe(false);
    expect(cold.displayHint).toBe('unavailable_cold');

    setupFreshMocks(1712345680000);
    const [fresh] = await getKimchiPremium(['BTC'], { venues: ['upbit'], requestKind: 'representative' });
    expect(fresh.status).toBe('loaded');
    expect(fresh.stableStatus).toBe('ready');

    providerSnapshots.binance.mockRejectedValueOnce(new Error('binance HTTP 503'));
    providerSnapshots.upbit.mockRejectedValueOnce(new Error('upbit HTTP 503'));
    getUsdKrwRate.mockRejectedValueOnce(new Error('fx timed out'));

    const [stale] = await getKimchiPremium(['BTC'], { venues: ['upbit'], requestKind: 'batch' });

    expect(stale.status).toBe('stale');
    expect(stale.stableStatus).toBe('stale');
    expect(stale.displayHint).toBe('keep_last_good');
    expect(stale.hasUsableDomesticPrice).toBe(true);
    expect(stale.hasUsableReferencePrice).toBe(true);
    expect(stale.hasUsableFxRate).toBe(true);
    expect(stale.freshnessReason).toContain('last_good_retained');
  });

  it('does not let a delayed Bithumb request contaminate or block an Upbit selection', async () => {
    providerSnapshots.bithumb.mockImplementation(() => new Promise(() => undefined));
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC'], { venues: ['upbit'] });

    expect(providerSnapshots.bithumb).not.toHaveBeenCalled();
    expect(entry.selectedExchange).toBe('upbit');
    expect(entry.sourceExchange).toBe('upbit');
    expect(entry.domesticPrice).toBe(domesticPrices.upbit);
  });

  it('exposes insufficientData when the Kimchi sparkline has too few points', async () => {
    const { getKimchiPremium } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const [entry] = await getKimchiPremium(['BTC'], { venues: ['bithumb'] });

    expect(entry.sourceExchange).toBe('bithumb');
    expect(entry.sparklineValueType).toBe('premium_percent');
    expect(entry.sparklineStatus).toBe('insufficientData');
    expect(entry.sparklinePointCount).toBe(1);
    expect(entry.rangeMin).toBe(entry.rangeMax);
  });
});
