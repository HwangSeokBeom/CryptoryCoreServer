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
  }, 10000);

  it('builds exchange coverage audit entries with deterministic fallback keys', async () => {
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
        symbol: '???',
        exchangeSymbol: '???',
        market: '???/KRW',
        baseCurrency: '???',
        quoteCurrency: 'KRW',
        rawSymbol: '???',
        tradable: true,
      },
    ]);
    binanceProvider.listMarkets.mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/USDT', rawSymbol: 'BTCUSDT' },
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
    binanceProvider.getTickerSnapshot.mockResolvedValue([
      {
        exchange: 'binance',
        symbol: 'BTC',
        market: 'BTC/USDT',
        baseCurrency: 'BTC',
        quoteCurrency: 'USDT',
        rawSymbol: 'BTCUSDT',
        price: 70000,
        change24h: 1.1,
        volume24h: 2000,
        high24h: 71000,
        low24h: 69000,
        timestamp: 1712345678000,
      },
    ]);

    const { getAssetCoverageAudit } = await import('../src/domains/market-data/market-data.service');
    const response = await getAssetCoverageAudit({ exchange: 'upbit', refresh: true });

    expect(response.summary[0]).toMatchObject({
      exchange: 'upbit',
      totalAssets: 2,
      canonicalMappedCount: 1,
      fallbackKeyAvailableCount: 2,
      unsupportedCount: 1,
      canonicalMissingCount: 1,
    });
    expect(response.items.find((item) => item.marketId === 'KRW-BTC')).toMatchObject({
      fallbackKey: 'coingecko:bitcoin',
      assetSupportStatus: 'supported',
      preferredImageSymbol: 'BTC',
    });
    expect(response.items.find((item) => item.marketId === '???')).toMatchObject({
      canonicalAssetKey: null,
      assetSupportStatus: 'unsupported',
      diagnosticReasons: expect.arrayContaining(['canonical_missing', 'unsupported_asset', 'image_url_missing']),
      fallbackKey: 'unresolved:upbit:raw-3f3f3f',
      stableAssetKey: 'unresolved:upbit:raw-3f3f3f',
      manualCurationRecommended: false,
    });
    expect(response.details[0]).toMatchObject({
      exchange: 'upbit',
      priorityRankedMissingImageCandidates: [
        expect.objectContaining({
          marketId: '???',
          fallbackOnly: true,
        }),
      ],
      manualCurationRecommended: [],
    });
  }, 10000);
});
