import { beforeEach, describe, expect, it, vi } from 'vitest';

const upbitProvider = {
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

const binanceProvider = {
  exchange: 'binance',
  metadata: {
    displayName: '바이낸스',
    quoteCurrency: 'USDT',
  },
  listMarkets: vi.fn(),
  getTickerSnapshot: vi.fn(),
  getOrderbookSnapshot: vi.fn(),
  getRecentTrades: vi.fn(),
  getCandles: vi.fn(),
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn((exchange: string) => (exchange === 'binance' ? binanceProvider : upbitProvider)),
    listMarketDataProviders: vi.fn(() => [upbitProvider, binanceProvider]),
  },
}));

describe('market symbol support metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports tradable and kimchi-comparable symbols for a domestic venue', async () => {
    upbitProvider.listMarkets.mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
    ]);
    binanceProvider.listMarkets.mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/USDT', rawSymbol: 'BTCUSDT' },
    ]);

    const { listSymbolSupport } = await import('../src/domains/market-data/market-data.service');
    const response = await listSymbolSupport('upbit');

    expect(response.exchange).toBe('upbit');
    expect(response.quoteCurrency).toBe('KRW');
    expect(response.total).toBe(2);
    expect(response.items.find((item) => item.symbol === 'BTC')).toMatchObject({
      exchangeSymbol: 'KRW-BTC',
      baseCurrency: 'BTC',
      tradable: true,
      kimchiComparable: true,
      kimchiComparisonReason: 'COMPARABLE',
    });
    expect(response.items.find((item) => item.symbol === 'ETH')).toMatchObject({
      exchangeSymbol: 'KRW-ETH',
      baseCurrency: 'ETH',
      tradable: true,
      kimchiComparable: false,
      kimchiComparisonReason: 'BINANCE_REFERENCE_MISSING',
    });
    expect(response.items.find((item) => item.symbol === 'XRP')).toBeUndefined();
  });
});
