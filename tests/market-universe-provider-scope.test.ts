import { beforeEach, describe, expect, it, vi } from 'vitest';

const upbitProvider = {
  exchange: 'upbit',
  metadata: {
    displayName: '업비트',
    quoteCurrency: 'KRW',
  },
  supports: vi.fn(() => true),
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
  supports: vi.fn(() => true),
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
    getMarketDataProvider: vi.fn((exchange: string) => (exchange === 'binance' ? binanceProvider : upbitProvider)),
    listMarketDataProviders: vi.fn(() => [upbitProvider, binanceProvider]),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

function createTicker(symbol: string, market: string, rawSymbol: string, price: number) {
  return {
    exchange: 'upbit' as const,
    symbol,
    market,
    baseCurrency: symbol,
    quoteCurrency: 'KRW' as const,
    rawSymbol,
    price,
    change24h: 1.5,
    volume24h: 1000,
    high24h: price + 100,
    low24h: price - 100,
    timestamp: 1712345678000,
  };
}

describe('provider market universe scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('listMarkets returns the provider market universe without trimming registry-unmapped symbols', async () => {
    upbitProvider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradable: true,
      },
      {
        symbol: 'TNSR',
        exchangeSymbol: 'KRW-TNSR',
        market: 'TNSR/KRW',
        baseCurrency: 'TNSR',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-TNSR',
        tradable: true,
      },
    ]);
    binanceProvider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'BTCUSDT',
        market: 'BTC/USDT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        rawSymbol: 'BTCUSDT',
        tradable: true,
      },
    ]);

    const { listMarkets } = await import('../src/domains/market-data/market-data.service');
    const response = await listMarkets('upbit');

    expect(response.items.map((item) => item.symbol)).toEqual(['BTC', 'TNSR']);
    expect(response.items.find((item) => item.symbol === 'TNSR')).toMatchObject({
      exchangeSymbol: 'KRW-TNSR',
      tradable: true,
      registryMapped: false,
      kimchiComparable: false,
      kimchiComparisonReason: 'BINANCE_REFERENCE_MISSING',
    });
    expect(response.meta).toMatchObject({
      sourceOfTruth: 'provider_market_universe',
      providerMarketCount: 2,
      returnedCount: 2,
      registryMappedCount: 1,
      registryUnmappedCount: 1,
      totalAvailableCount: 2,
      droppedSymbols: [],
    });
  });

  it('getTickers uses the provider market universe, keeps kimchiComparable=false symbols, and only drops provider-missing symbols', async () => {
    upbitProvider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradable: true,
      },
      {
        symbol: 'ETH',
        exchangeSymbol: 'KRW-ETH',
        market: 'ETH/KRW',
        baseCurrency: 'ETH',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-ETH',
        tradable: true,
      },
      {
        symbol: 'TNSR',
        exchangeSymbol: 'KRW-TNSR',
        market: 'TNSR/KRW',
        baseCurrency: 'TNSR',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-TNSR',
        tradable: true,
      },
    ]);
    upbitProvider.getTickerSnapshot.mockResolvedValue([
      createTicker('BTC', 'BTC/KRW', 'KRW-BTC', 100),
      createTicker('TNSR', 'TNSR/KRW', 'KRW-TNSR', 10),
    ]);
    binanceProvider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'BTCUSDT',
        market: 'BTC/USDT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        rawSymbol: 'BTCUSDT',
        tradable: true,
      },
    ]);

    const { getTickers } = await import('../src/domains/market-data/market-data.service');
    const response = await getTickers({ exchange: 'upbit', limit: 1 });

    expect(response.items.map((item) => item.symbol)).toEqual(['BTC']);
    expect(response.meta).toMatchObject({
      sourceOfTruth: 'provider_market_universe',
      providerMarketCount: 3,
      returnedCount: 1,
      appliedLimit: 1,
      totalAvailableCount: 2,
      droppedSymbols: [
        {
          exchange: 'upbit',
          symbol: 'ETH',
          reason: 'missing_from_provider_snapshot',
        },
      ],
    });

    const fullResponse = await getTickers({ exchange: 'upbit' });
    expect(fullResponse.items.map((item) => item.symbol)).toEqual(['BTC', 'TNSR']);
    expect(fullResponse.items.find((item) => item.symbol === 'TNSR')).toMatchObject({
      exchangeSymbol: 'KRW-TNSR',
      kimchiComparable: false,
      kimchiComparisonReason: 'BINANCE_REFERENCE_MISSING',
    });
    expect(fullResponse.meta.droppedSymbols).toEqual([
      {
        exchange: 'upbit',
        symbol: 'ETH',
        reason: 'missing_from_provider_snapshot',
      },
    ]);
  });
});
