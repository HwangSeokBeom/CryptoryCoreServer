import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomesticExchangeId, ExchangeId } from '../src/core/exchange/exchange.types';

type ProviderMock = {
  exchange: ExchangeId;
  metadata: {
    displayName: string;
    quoteCurrency: 'KRW' | 'USDT';
  };
  supports: ReturnType<typeof vi.fn>;
  listMarkets: ReturnType<typeof vi.fn>;
  getTickerSnapshot: ReturnType<typeof vi.fn>;
  getOrderbookSnapshot: ReturnType<typeof vi.fn>;
  getRecentTrades: ReturnType<typeof vi.fn>;
  getCandles: ReturnType<typeof vi.fn>;
};

function createProvider(exchange: ExchangeId, displayName: string, quoteCurrency: 'KRW' | 'USDT'): ProviderMock {
  return {
    exchange,
    metadata: {
      displayName,
      quoteCurrency,
    },
    supports: vi.fn(() => true),
    listMarkets: vi.fn(),
    getTickerSnapshot: vi.fn(),
    getOrderbookSnapshot: vi.fn(),
    getRecentTrades: vi.fn(),
    getCandles: vi.fn(),
  };
}

const providers = {
  upbit: createProvider('upbit', '업비트', 'KRW'),
  bithumb: createProvider('bithumb', '빗썸', 'KRW'),
  coinone: createProvider('coinone', '코인원', 'KRW'),
  korbit: createProvider('korbit', '코빗', 'KRW'),
  binance: createProvider('binance', '바이낸스', 'USDT'),
};

const getUsdKrwRate = vi.fn();
let mockedNow = 1_712_345_680_000;
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
    getMarketDataProvider: vi.fn((exchange: ExchangeId) => providers[exchange]),
    listMarketDataProviders: vi.fn(() => Object.values(providers)),
    getFxRateProvider: vi.fn(() => ({
      getUsdKrwRate,
    })),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

const getAssetViewsMock = vi.fn(async (lookups: Array<{
  canonicalAssetKey?: string | null;
  symbol?: string | null;
}>) => new Map(
  lookups.map((lookup) => {
    const canonicalAssetKey = (lookup.canonicalAssetKey ?? lookup.symbol ?? '').toUpperCase();
    return [
      canonicalAssetKey,
      {
        canonicalAssetKey,
        assetImageUrl: canonicalAssetKey === 'BTC' ? 'https://assets.example.com/btc.png' : null,
        symbolImageUrl: canonicalAssetKey === 'BTC' ? 'https://assets.example.com/btc.png' : null,
        coingeckoId: canonicalAssetKey === 'BTC' ? 'bitcoin' : null,
      },
    ];
  }),
));

vi.mock('../src/domains/assets/asset-metadata.service', () => ({
  assetMetadataService: {
    getAssetViews: getAssetViewsMock,
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

function createMarket(symbol: string, exchange: ExchangeId) {
  const exchangeSymbol = exchange === 'binance'
    ? `${symbol}USDT`
    : exchange === 'korbit'
      ? `${symbol.toLowerCase()}_krw`
      : exchange === 'coinone'
        ? symbol
        : `KRW-${symbol}`;

  return {
    symbol,
    exchangeSymbol,
    market: exchange === 'binance' ? `${symbol}/USDT` : `${symbol}/KRW`,
    baseCurrency: symbol,
    quoteCurrency: exchange === 'binance' ? 'USDT' : 'KRW',
    rawSymbol: exchangeSymbol,
    tradable: true,
  };
}

function createTicker(params: {
  exchange: ExchangeId;
  symbol: string;
  price: number;
  timestamp?: number;
  change24h?: number;
  volume24h?: number;
}) {
  return {
    exchange: params.exchange,
    symbol: params.symbol,
    market: params.exchange === 'binance' ? `${params.symbol}/USDT` : `${params.symbol}/KRW`,
    baseCurrency: params.symbol,
    quoteCurrency: params.exchange === 'binance' ? 'USDT' : 'KRW',
    rawSymbol:
      params.exchange === 'binance'
        ? `${params.symbol}USDT`
        : params.exchange === 'korbit'
          ? `${params.symbol.toLowerCase()}_krw`
          : params.exchange === 'coinone'
            ? params.symbol
            : `KRW-${params.symbol}`,
    price: params.price,
    change24h: params.change24h ?? 1.5,
    volume24h: params.volume24h ?? 1_000_000,
    high24h: params.price * 1.02,
    low24h: params.price * 0.98,
    timestamp: params.timestamp ?? 1_712_345_678_000,
  };
}

describe('Structured Market and Kimchi APIs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getAssetViewsMock.mockClear();
    mockedNow = 1_712_345_680_000;
    vi.spyOn(Date, 'now').mockImplementation(() => mockedNow);

    providers.upbit.listMarkets.mockResolvedValue(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE'].map((symbol) => createMarket(symbol, 'upbit')));
    providers.bithumb.listMarkets.mockResolvedValue(['BTC', 'ETH', 'XRP', 'DOGE'].map((symbol) => createMarket(symbol, 'bithumb')));
    providers.coinone.listMarkets.mockResolvedValue(['BTC', 'ETH', 'XRP'].map((symbol) => createMarket(symbol, 'coinone')));
    providers.korbit.listMarkets.mockResolvedValue(['BTC', 'ETH', 'XRP'].map((symbol) => createMarket(symbol, 'korbit')));
    providers.binance.listMarkets.mockResolvedValue(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE'].map((symbol) => createMarket(symbol, 'binance')));

    providers.upbit.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? []).map((symbol) => createTicker({
        exchange: 'upbit',
        symbol,
        price: symbol === 'BTC' ? 100_000_000 : 5_000_000,
        volume24h: symbol === 'BTC' ? 10_000_000 : 5_000_000,
      })));
    providers.bithumb.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? []).map((symbol) => createTicker({
        exchange: 'bithumb',
        symbol,
        price: symbol === 'BTC' ? 99_900_000 : 4_900_000,
        volume24h: symbol === 'BTC' ? 8_000_000 : 4_000_000,
      })));
    providers.coinone.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? []).map((symbol) => createTicker({
        exchange: 'coinone',
        symbol,
        price: symbol === 'BTC' ? 99_800_000 : 4_800_000,
      })));
    providers.korbit.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? []).map((symbol) => createTicker({
        exchange: 'korbit',
        symbol,
        price: symbol === 'BTC' ? 99_700_000 : 4_700_000,
      })));
    providers.binance.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? []).map((symbol) => createTicker({
        exchange: 'binance',
        symbol,
        price: symbol === 'BTC' ? 70_000 : 3_500,
      })));

    getUsdKrwRate.mockResolvedValue({
      pair: 'USD/KRW',
      rate: 1_350,
      timestamp: 1_712_345_678_000,
      staleAt: 1_712_345_708_000,
      provider: 'test-fx',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles 290-symbol sparkline requests as partial success instead of rejecting the batch', async () => {
    const { getMarketSparkline } = await import('../src/domains/market-data/market-data.service');
    const symbols = ['BTC', ...Array.from({ length: 289 }, (_, index) => `NOTREAL${index}`)];

    const response = await getMarketSparkline({
      exchange: 'upbit',
      symbols,
      debug: true,
    });

    expect(response.partial).toBe(true);
    expect(response.skippedSymbolCount).toBe(289);
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      symbol: 'BTC',
      displayStatus: 'fresh',
    });
    expect(response.debug?.requestedSymbolCount).toBe(290);
  });

  it('reuses stale sparkline cache for small fast-path requests and exposes stability metadata', async () => {
    const { getMarketSparkline } = await import('../src/domains/market-data/market-data.service');

    const first = await getMarketSparkline({
      exchange: 'upbit',
      symbols: ['BTC'],
      debug: true,
    });

    mockedNow += 2_500;

    const second = await getMarketSparkline({
      exchange: 'upbit',
      symbols: ['BTC'],
      debug: true,
    });

    expect(first.items[0]?.sparkline?.length).toBeGreaterThanOrEqual(2);
    expect(second.source).toBe('stale_cache');
    expect(second.freshness).toBe('slightly_delayed');
    expect(second.generatedAt).toBe(mockedNow);
    expect(second.missingSymbols).toEqual([]);
    expect(second.usableSymbols).toEqual(['BTC']);
    expect(second.usableStaleSymbols).toEqual(['BTC']);
    expect(second.symbolMeta).toEqual([
      expect.objectContaining({
        symbol: 'BTC',
        source: 'stale_cache',
        isRenderable: true,
        usable: true,
        renderPriority: 'stale',
        pointCount: 2,
        lastSuccessfulGraphAt: expect.any(String),
        graphLatencyBucket: 'delayed',
        freshnessBucket: 'slightly_delayed',
        fallbackReason: 'stale_cache',
      }),
    ]);
    expect(second.cache).toMatchObject({
      hit: 0,
      stale: 1,
      miss: 0,
      backgroundRefreshScheduled: true,
    });
  });

  it('keeps unavailable graphs distinct from stale-but-renderable graphs', async () => {
    const { getMarketSparkline } = await import('../src/domains/market-data/market-data.service');

    providers.upbit.listMarkets.mockResolvedValue(['BTC', 'ETH'].map((symbol) => createMarket(symbol, 'upbit')));
    providers.upbit.getTickerSnapshot.mockImplementation(async (symbols?: string[]) =>
      (symbols ?? [])
        .filter((symbol) => symbol === 'BTC')
        .map((symbol) => createTicker({
          exchange: 'upbit',
          symbol,
          price: 100_000_000,
          volume24h: 10_000_000,
        })));

    const staleSeed = await getMarketSparkline({
      exchange: 'upbit',
      symbols: ['BTC'],
      debug: true,
    });
    expect(staleSeed.symbolMeta?.[0]).toMatchObject({
      symbol: 'BTC',
      isRenderable: true,
      renderPriority: 'live',
    });

    const unavailable = await getMarketSparkline({
      exchange: 'upbit',
      symbols: ['ETH'],
      debug: true,
    });

    expect(unavailable.items[0]).toMatchObject({
      symbol: 'ETH',
      sparkline: null,
    });
    expect(unavailable.symbolMeta).toEqual([
      expect.objectContaining({
        symbol: 'ETH',
        isRenderable: false,
        renderPriority: 'unavailable',
        pointCount: 0,
      }),
    ]);
  });

  it('keeps mapped kimchi rows even when unsupported symbols are mixed in', async () => {
    const { getKimchiPremiumSparkline } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    const response = await getKimchiPremiumSparkline({
      exchange: 'upbit',
      symbols: ['BTC', 'OG'],
      debug: true,
    });

    expect(response.partial).toBe(true);
    expect(response.items.map((item) => item.symbol)).toEqual(['BTC']);
    expect(response.skippedSymbolCount).toBe(1);
    expect(response.debug?.skippedSymbols).toEqual([
      expect.objectContaining({ symbol: 'OG' }),
    ]);
  });

  it('loads overview with representative-sized provider fetches for first paint', async () => {
    const { getMarketOverview } = await import('../src/domains/market-data/market-data.service');

    const response = await getMarketOverview({
      exchange: 'upbit',
      limit: 4,
      debug: true,
    });

    expect(response.items).toHaveLength(4);
    expect(response.page.limit).toBe(4);
    expect(providers.upbit.getTickerSnapshot).toHaveBeenCalledTimes(1);
    expect(providers.upbit.getTickerSnapshot.mock.calls[0][0]).toHaveLength(4);
    expect(response.debug?.firstPaintElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns market list rows even when sparkline history is missing', async () => {
    const { getMarketList } = await import('../src/domains/market-data/market-data.service');

    const response = await getMarketList({
      exchange: 'upbit',
      limit: 2,
    });

    expect(response.items[0]).toMatchObject({
      symbol: 'BTC',
      currentPrice: 100_000_000,
      sparkline: null,
      sparklinePointCount: null,
    });
  });

  it('keeps assetImageUrl projected across market, kimchi, public, and legacy-facing responses', async () => {
    const {
      getBaseMarketSnapshot,
      getMarketList,
      getMarketOverview,
      listComparableKimchiSymbols,
    } = await import('../src/domains/market-data/market-data.service');
    const { getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');
    const { getPublicKimchiPremium, getPublicTickers } = await import('../src/modules/public-market/public-market.service');

    publicMarketDataStore.getTickers.mockReturnValueOnce([
      {
        channel: 'tickers',
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        timestamp: 1_712_345_678_000,
        price: 100_000_000,
        change24h: 1.5,
        volume24h: 1_000_000,
        high24h: 102_000_000,
        low24h: 98_000_000,
      },
    ]);

    const overview = await getMarketOverview({
      exchange: 'upbit',
      limit: 1,
    });
    const marketList = await getMarketList({
      exchange: 'upbit',
      limit: 1,
    });
    const baseSnapshot = await getBaseMarketSnapshot({
      exchange: 'upbit',
      symbols: ['BTC'],
      scope: 'symbols',
    });
    const comparable = await listComparableKimchiSymbols({
      exchange: 'upbit',
      limit: 1,
    });
    const kimchi = await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 1,
    });
    const publicTickers = await getPublicTickers({
      exchange: 'upbit',
      symbol: 'BTC',
    });
    const publicKimchi = await getPublicKimchiPremium(['BTC'], { venues: ['upbit'] });

    expect(overview.items[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(marketList.items[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(baseSnapshot.items[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(comparable.items[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(kimchi.items[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(publicTickers[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(publicKimchi[0]).toMatchObject({
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
    });
    expect(getAssetViewsMock).toHaveBeenCalled();
  });

  it('keeps sourceExchange isolated when switching market exchanges', async () => {
    const { getMarketOverview } = await import('../src/domains/market-data/market-data.service');

    const upbit = await getMarketOverview({ exchange: 'upbit', limit: 1 });
    const bithumb = await getMarketOverview({ exchange: 'bithumb', limit: 1 });

    expect(upbit.selectedExchange).toBe('upbit');
    expect(upbit.items[0]?.sourceExchange).toBe('upbit');
    expect(upbit.items[0]?.currentPrice).toBe(100_000_000);

    expect(bithumb.selectedExchange).toBe('bithumb');
    expect(bithumb.sourceExchange).toBe('bithumb');
    expect(bithumb.items[0]?.sourceExchange).toBe('bithumb');
    expect(bithumb.items[0]?.currentPrice).toBe(99_900_000);
  });

  it('does not over-reuse stale kimchi snapshots when the selected exchange changes', async () => {
    const { getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    const upbit = await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 1,
      debug: true,
    });
    const bithumb = await getKimchiPremiumRepresentatives({
      exchange: 'bithumb',
      limit: 1,
      debug: true,
    });

    expect(upbit.selectedExchange).toBe('upbit');
    expect(bithumb.selectedExchange).toBe('bithumb');
    expect(bithumb.sourceExchange).toBe('bithumb');
    expect(bithumb.items[0]?.sourceExchange).toBe('bithumb');
    expect(bithumb.debug?.staleReused).toBe(false);
    expect(providers.bithumb.getTickerSnapshot).toHaveBeenCalled();
  });

  it('reuses the representative kimchi cache for repeated first-screen requests', async () => {
    const { getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });
    const cached = await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });

    expect(providers.upbit.getTickerSnapshot).toHaveBeenCalledTimes(1);
    expect(providers.binance.getTickerSnapshot).toHaveBeenCalledTimes(1);
    expect(cached.meta).toMatchObject({
      representativeReady: true,
      hasUsableRepresentativeData: true,
      representativeCount: 2,
      representativeSource: 'fresh_cache',
      representativeFreshnessBucket: 'fresh',
      recommendedUiState: 'ready',
      recommendedInitialBadge: 'ready',
      representative: expect.objectContaining({
        ready: true,
        hasUsableData: true,
        source: 'fresh_cache',
        recommendedInitialBadge: 'ready',
      }),
    });
  });

  it('keeps stale representative cache usable for first-click readiness', async () => {
    const { getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });

    mockedNow += 10_000;

    const stale = await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });

    expect(stale.meta).toMatchObject({
      representativeReady: true,
      hasUsableRepresentativeData: true,
      representativeSource: 'stale_cache',
      representativeFreshnessBucket: 'slightly_delayed',
      recommendedInitialBadge: 'ready',
      fullHydrationPending: true,
      representative: expect.objectContaining({
        ready: true,
        hasUsableData: true,
        source: 'stale_cache',
        freshnessBucket: 'slightly_delayed',
        recommendedInitialBadge: 'ready',
      }),
      fullHydration: expect.objectContaining({
        pending: true,
        uiHint: 'background_hydration_only',
      }),
    });
  });

  it('returns kimchi batch metadata for patch-friendly hydration decisions', async () => {
    const { getKimchiPremiumBatch } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    const response = await getKimchiPremiumBatch({
      symbols: ['BTC', 'ETH'],
      venues: ['upbit'],
    });

    expect(response.meta).toMatchObject({
      requestedCount: 2,
      normalizedCount: 2,
      acceptedCount: 2,
      hydratedCount: 2,
      rejectedCount: 0,
      unsupportedCount: 0,
      unavailableCount: 0,
      staleCount: 0,
      pendingEstimate: 0,
      hydrationPhase: 'representative_fast_path',
      representativeHint: true,
      representativeReady: true,
      hasUsableRepresentativeData: true,
      representativeCount: 2,
      representativeFreshness: 'fresh',
      representativeFreshnessBucket: 'fresh',
      representativeSource: 'provider_fetch',
      recommendedUiState: 'ready',
      recommendedInitialBadge: 'ready',
      fullHydrationPending: false,
      cacheSource: 'derived',
      freshness: 'fresh',
      freshnessBucket: 'fresh',
      batchFreshnessBucket: 'fresh',
      uiHint: 'ready',
      representative: expect.objectContaining({
        ready: true,
        hasUsableData: true,
        source: 'provider_fetch',
        freshnessBucket: 'fresh',
        recommendedInitialBadge: 'ready',
      }),
      fullHydration: expect.objectContaining({
        pending: false,
        phase: 'representative_fast_path',
        freshnessBucket: 'fresh',
        uiHint: 'ready',
      }),
    });
  });

  it('keeps representative fast-path payload lighter than full batch hydration', async () => {
    const { getKimchiPremiumBatch, getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    const representatives = await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });
    const batch = await getKimchiPremiumBatch({
      symbols: ['BTC', 'XRP'],
      venues: ['upbit'],
    });

    const representativeBytes = Buffer.byteLength(JSON.stringify(representatives));
    const batchBytes = Buffer.byteLength(JSON.stringify(batch));

    expect(representativeBytes).toBeLessThan(batchBytes);
  });

  it('keeps representativeReady from the representative cache even when a later batch is degraded', async () => {
    const { getKimchiPremiumBatch, getKimchiPremiumRepresentatives } = await import('../src/domains/kimchi-premium/kimchi-premium.service');

    await getKimchiPremiumRepresentatives({
      exchange: 'upbit',
      limit: 2,
    });

    providers.upbit.getTickerSnapshot.mockResolvedValue([]);

    const response = await getKimchiPremiumBatch({
      symbols: ['BTC', 'ETH'],
      venues: ['upbit'],
    });

    expect(response.meta).toMatchObject({
      representativeReady: true,
      hasUsableRepresentativeData: true,
      representativeCount: 2,
      representativeSource: 'fresh_cache',
      recommendedInitialBadge: 'ready',
      recommendedUiState: 'ready',
      fullHydrationPending: true,
      uiHint: 'background_hydration_only',
      representative: expect.objectContaining({
        ready: true,
        hasUsableData: true,
        source: 'fresh_cache',
        recommendedInitialBadge: 'ready',
      }),
      fullHydration: expect.objectContaining({
        pending: true,
        uiHint: 'background_hydration_only',
      }),
    });
    expect(response.unavailableSymbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'BTC' }),
      expect.objectContaining({ symbol: 'ETH' }),
    ]));
  });
});
