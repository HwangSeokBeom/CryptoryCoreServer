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
  getOrderbook: vi.fn(() => null),
  getTrades: vi.fn(() => []),
  getCollectorStatuses: vi.fn(() => []),
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

describe('market snapshot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1712345680000);
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
      {
        symbol: 'ETH',
        exchangeSymbol: 'ETHUSDT',
        market: 'ETH/USDT',
        baseCurrency: 'ETH',
        quoteCurrency: 'USDT',
        rawSymbol: 'ETHUSDT',
        tradable: true,
      },
    ]);
    upbitProvider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100000000,
        change24h: 1.5,
        volume24h: 1000,
        high24h: 101000000,
        low24h: 99000000,
        timestamp: 1712345678000,
      },
    ]);
  });

  it('returns listed-only snapshot rows and moves unlisted symbols into partial failures', async () => {
    const { getMarketSnapshot } = await import('../src/domains/market-data/market-data.service');
    const response = await getMarketSnapshot({
      exchange: 'upbit',
      symbols: ['BTC', 'ETH', 'XRP', 'OG'],
    });

    expect(response.status).toBe('partial_success');
    expect(response.items.map((item) => item.symbol)).toEqual(['BTC', 'ETH']);
    expect(response.items.find((item) => item.symbol === 'BTC')).toMatchObject({
      status: 'success',
      price: 100000000,
      source: 'snapshot',
      displayName: '비트코인',
      signedChangeRate: 1.5,
      marketStatus: 'live',
      errorCode: null,
    });
    expect(response.items.find((item) => item.symbol === 'ETH')).toMatchObject({
      status: 'partial',
      marketStatus: 'pending',
      errorCode: 'PARTIAL_DATA',
    });
    expect(response.items.find((item) => item.symbol === 'XRP')).toBeUndefined();
    expect(response.items.find((item) => item.symbol === 'OG')).toBeUndefined();
    expect(response.excludedUnlistedCount).toBe(2);
    expect(response.partialFailures).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'ETH', code: 'PARTIAL_DATA' }),
      expect.objectContaining({ symbol: 'XRP', code: 'UNSUPPORTED_SYMBOL' }),
      expect.objectContaining({ symbol: 'OG', code: 'SYMBOL_MAPPING_NOT_FOUND' }),
    ]));
  });

  it('defaults to a full listed-market snapshot for first paint', async () => {
    const { getMarketSnapshot } = await import('../src/domains/market-data/market-data.service');
    const response = await getMarketSnapshot({
      exchange: 'upbit',
    });

    expect(response.scope).toBe('top');
    expect(response.items.map((item) => item.symbol)).toEqual(['BTC', 'ETH']);
    expect(response.listedCount).toBe(2);
    expect(response.pendingItemCount).toBe(1);
  });

  it('prioritizes representative symbols and trims sparkline payload for visible scope', async () => {
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
        symbol: 'AVAX',
        exchangeSymbol: 'KRW-AVAX',
        market: 'AVAX/KRW',
        baseCurrency: 'AVAX',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-AVAX',
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
      {
        symbol: 'ETH',
        exchangeSymbol: 'ETHUSDT',
        market: 'ETH/USDT',
        baseCurrency: 'ETH',
        quoteCurrency: 'USDT',
        rawSymbol: 'ETHUSDT',
        tradable: true,
      },
      {
        symbol: 'AVAX',
        exchangeSymbol: 'AVAXUSDT',
        market: 'AVAX/USDT',
        baseCurrency: 'AVAX',
        quoteCurrency: 'USDT',
        rawSymbol: 'AVAXUSDT',
        tradable: true,
      },
    ]);
    upbitProvider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100000000,
        change24h: 1.5,
        volume24h: 1000,
        high24h: 101000000,
        low24h: 99000000,
        timestamp: 1712345678000,
      },
      {
        exchange: 'upbit',
        symbol: 'ETH',
        market: 'ETH/KRW',
        baseCurrency: 'ETH',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-ETH',
        price: 5000000,
        change24h: 1.2,
        volume24h: 500,
        high24h: 5200000,
        low24h: 4800000,
        timestamp: 1712345678500,
      },
      {
        exchange: 'upbit',
        symbol: 'AVAX',
        market: 'AVAX/KRW',
        baseCurrency: 'AVAX',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-AVAX',
        price: 42000,
        change24h: 6.8,
        volume24h: 999999,
        high24h: 44000,
        low24h: 39000,
        timestamp: 1712345679000,
      },
    ]);
    publicMarketDataStore.getTickerHistory.mockReturnValue(
      Array.from({ length: 20 }, (_, index) => ({
        price: 100000000 + index * 1000,
        timestamp: 1712345600000 + index * 1000,
      })),
    );

    const {
      getMarketSnapshot,
      listComparableKimchiSymbols,
    } = await import('../src/domains/market-data/market-data.service');
    const snapshot = await getMarketSnapshot({
      exchange: 'upbit',
      scope: 'visible',
      limit: 3,
    });

    expect(snapshot.scope).toBe('visible');
    expect(snapshot.items.map((item) => item.symbol)).toEqual(['BTC', 'ETH', 'AVAX']);
    expect(snapshot.items[0]?.sparklinePoints.length).toBeLessThanOrEqual(12);
    expect(snapshot.items[1]?.sparklinePoints.length).toBeLessThanOrEqual(12);

    const comparable = await listComparableKimchiSymbols({
      exchange: 'upbit',
      limit: 3,
    });

    expect(comparable.items.map((item) => item.symbol)).toEqual(['BTC', 'ETH', 'AVAX']);
    expect(comparable.items[0]).toMatchObject({
      priority: 'top',
      rank: 1,
    });
    expect(comparable.items[1]).toMatchObject({
      priority: 'top',
      rank: 2,
    });
    expect(comparable.items[2]).toMatchObject({
      priority: 'normal',
      rank: 3,
    });
  });
});
