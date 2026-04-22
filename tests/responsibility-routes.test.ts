import { afterEach, describe, expect, it, vi } from 'vitest';

const getKimchiPremiumMock = vi.fn(async () => [
  {
    symbol: 'BTC',
    nameKo: '비트코인',
    nameEn: 'Bitcoin',
    domesticVenue: 'upbit',
    binanceUsdtPrice: 70000,
    usdKrwRate: 1350,
    binanceKrwPrice: 94500000,
    domestic: [],
    stale: false,
    timestampSkewMs: 0,
  },
]);
const getKimchiPremiumSnapshotMock = vi.fn(async () => ({
  domesticExchange: 'upbit',
  globalExchange: 'binance',
  items: [
    {
      symbol: 'BTC',
      nameKo: '비트코인',
      nameEn: 'Bitcoin',
      status: 'loaded',
      errorCode: null,
      domesticExchange: 'upbit',
      domesticPrice: 100000000,
      binanceKrwPrice: 94500000,
      premiumPercent: 5,
    },
  ],
  partialFailures: [],
  supportedPairs: ['BTC'],
  status: 'success',
  source: 'derived',
  asOf: 1712345678000,
  freshnessMs: 250,
  stale: false,
  total: 1,
}));
const listComparableKimchiSymbolsMock = vi.fn(async () => ({
  exchange: 'upbit',
  items: [
    {
      marketId: 'KRW-BTC',
      rawSymbol: 'KRW-BTC',
      canonicalSymbol: 'BTC',
      baseAsset: 'BTC',
      quoteAsset: 'KRW',
      symbol: 'BTC',
      displaySymbol: 'BTC/KRW',
      displayName: '비트코인',
      market: 'BTC/KRW',
      exchangeSymbol: 'KRW-BTC',
      price: 100000000,
      marketStatus: 'live',
    },
  ],
  total: 1,
  asOf: 1712345678000,
  freshnessMs: 150,
}));
const getChartCandlesMock = vi.fn(async () => ({
  exchange: 'upbit',
  marketId: 'KRW-BTC',
  rawSymbol: 'KRW-BTC',
  canonicalSymbol: 'BTC',
  baseAsset: 'BTC',
  quoteAsset: 'KRW',
  displaySymbol: 'BTC/KRW',
  koreanName: '비트코인',
  englishName: 'Bitcoin',
  iconUrl: 'https://assets.example.com/btc.png',
  isActive: true,
  capabilities: {
    supportsCandles: true,
    supportsOrderBook: true,
    supportsTrades: true,
  },
  symbol: 'BTC',
  interval: '1m',
  items: [
    {
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      interval: '1m',
      openTime: 1712345640000,
      closeTime: 1712345700000,
      open: 99900000,
      high: 100000000,
      low: 99800000,
      close: 100000000,
      volume: 12,
    },
  ],
  live: {
    channel: 'candles',
    exchange: 'upbit',
    symbol: 'BTC',
    market: 'BTC/KRW',
    baseCurrency: 'BTC',
    quoteCurrency: 'KRW',
    rawSymbol: 'KRW-BTC',
    interval: '1m',
    openTime: 1712345700000,
    closeTime: 1712345760000,
    open: 100000000,
    high: 100100000,
    low: 99950000,
    close: 100050000,
    volume: 1.2,
    asOf: 1712345720000,
    confirmed: false,
    candleStatus: 'live',
    sourceEvent: 'trade',
  },
  liveStatus: 'live',
  asOf: 1712345720000,
  freshnessMs: 100,
  total: 1,
}));
const getMarketSnapshotMock = vi.fn(async () => ({
  exchange: 'upbit',
  scope: 'symbols',
  requestedSymbols: ['BTC'],
  items: [
    {
      exchange: 'upbit',
      exchangeName: '업비트',
      marketId: 'KRW-BTC',
      rawSymbol: 'KRW-BTC',
      canonicalSymbol: 'BTC',
      baseAsset: 'BTC',
      quoteAsset: 'KRW',
      symbol: 'BTC',
      displaySymbol: 'BTC/KRW',
      displayName: '비트코인',
      iconUrl: 'https://assets.example.com/btc.png',
      exchangeSymbol: 'KRW-BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      price: 100000000,
      change24h: 1.2,
      signedChangeRate: 1.2,
      volume24h: 1000,
      sparkline: [99000000, 100000000],
      sparklinePoints: [
        { price: 99000000, timestamp: 1712345600000 },
        { price: 100000000, timestamp: 1712345678000 },
      ],
      sparklineSource: 'history',
      trend: 'up',
      timestamp: 1712345678000,
      asOf: 1712345678000,
      source: 'snapshot',
      freshnessMs: 150,
      stale: false,
      status: 'success',
      marketStatus: 'live',
      errorCode: null,
      errorMessage: null,
      registryMapped: true,
      tradable: true,
      isActive: true,
      capabilities: {
        tickers: true,
        orderbook: true,
        trades: true,
        candles: true,
        supportsCandles: true,
        supportsOrderBook: true,
        supportsTrades: true,
      },
      isChartAvailable: true,
      isOrderBookAvailable: true,
      isTradesAvailable: true,
      unavailableReason: null,
      kimchiComparable: true,
      kimchiComparisonReason: 'COMPARABLE',
    },
  ],
  partialFailures: [],
  status: 'success',
  source: 'snapshot',
  freshnessMs: 150,
  asOf: 1712345678000,
  stale: false,
  total: 1,
  listedCount: 1,
  staleItemCount: 0,
  pendingItemCount: 0,
  excludedUnlistedCount: 0,
}));
const getAssetCoverageAuditMock = vi.fn(async () => ({
  generatedAt: 1712345678000,
  cacheAgeMs: 0,
  cached: false,
  exchanges: ['upbit'],
  summary: [
    {
      exchange: 'upbit',
      totalAssets: 1,
      registryMappedCount: 1,
      canonicalMappedCount: 1,
      imageUrlAvailableCount: 1,
      fallbackKeyAvailableCount: 1,
      unsupportedCount: 0,
      aliasMissingCount: 0,
      canonicalMissingCount: 0,
      assetSlugMissingCount: 0,
      imageUrlMissingCount: 0,
    },
  ],
  totals: {
    totalAssets: 1,
    registryMappedCount: 1,
    canonicalMappedCount: 1,
    imageUrlAvailableCount: 1,
    fallbackKeyAvailableCount: 1,
    unsupportedCount: 0,
    aliasMissingCount: 0,
    canonicalMissingCount: 0,
    assetSlugMissingCount: 0,
    imageUrlMissingCount: 0,
  },
  items: [
    {
      exchange: 'upbit',
      marketId: 'KRW-BTC',
      rawSymbol: 'KRW-BTC',
      normalizedSymbol: 'BTC',
      canonicalSymbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetSlug: 'bitcoin',
      preferredImageSymbol: 'BTC',
      preferredImageSlug: 'bitcoin',
      imageUrl: 'https://assets.example.com/btc.png',
      fallbackKey: 'coingecko:bitcoin',
      stableAssetKey: 'coingecko:bitcoin',
      imageAvailability: 'available',
      imageFailureReason: null,
      imageMissingReason: null,
      imageResolutionSource: 'direct_slug',
      resolutionStage: 'preferred_image',
      assetSupportStatus: 'supported',
      registryMapped: true,
      aliasHit: false,
      matchedBy: 'normalized',
      diagnosticReasons: [],
      exposurePriority: 10000,
      exposureRank: 1,
      representative: true,
      visible: true,
      volumeRank: 1,
      manualCurationRecommended: false,
      fallbackOnly: false,
    },
  ],
  details: [
    {
      exchange: 'upbit',
      summary: {
        exchange: 'upbit',
        totalAssets: 1,
        registryMappedCount: 1,
        canonicalMappedCount: 1,
        imageUrlAvailableCount: 1,
        fallbackKeyAvailableCount: 1,
        unsupportedCount: 0,
        aliasMissingCount: 0,
        canonicalMissingCount: 0,
        assetSlugMissingCount: 0,
        imageUrlMissingCount: 0,
      },
      imageUrlMissingSymbols: [],
      aliasMissingSymbols: [],
      priorityRankedMissingImageCandidates: [],
      manualCurationRecommended: [],
      fallbackOnlyRetained: [],
      curatedResolvedButNotPromoted: [],
      cacheStaleSuspects: [],
      sourceMetadataMissing: [],
    },
  ],
}));

vi.mock('../src/domains/market-data/market-data.service', () => ({
  getAssetCoverageAudit: getAssetCoverageAuditMock,
  listMarkets: vi.fn(async () => []),
  listComparableKimchiSymbols: listComparableKimchiSymbolsMock,
  listSymbolSupport: vi.fn(async () => ({
    exchange: 'upbit',
    quoteCurrency: 'KRW',
    baseExchange: 'binance',
    total: 1,
    items: [
      {
        exchange: 'upbit',
        marketId: 'KRW-BTC',
        rawSymbol: 'KRW-BTC',
        canonicalSymbol: 'BTC',
        baseAsset: 'BTC',
        quoteAsset: 'KRW',
        displaySymbol: 'BTC/KRW',
        koreanName: '비트코인',
        englishName: 'Bitcoin',
        iconUrl: 'https://assets.example.com/btc.png',
        isActive: true,
        capabilities: {
          supportsCandles: true,
          supportsOrderBook: true,
          supportsTrades: true,
        },
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        market: 'BTC/KRW',
        quoteCurrency: 'KRW',
        tradable: true,
        kimchiComparable: true,
        kimchiComparisonReason: 'COMPARABLE',
      },
    ],
  })),
  getMarketSnapshot: getMarketSnapshotMock,
  getTickers: vi.fn(async () => [
    {
      exchange: 'upbit',
      marketId: 'KRW-BTC',
      rawSymbol: 'KRW-BTC',
      canonicalSymbol: 'BTC',
      baseAsset: 'BTC',
      quoteAsset: 'KRW',
      displaySymbol: 'BTC/KRW',
      koreanName: '비트코인',
      englishName: 'Bitcoin',
      iconUrl: 'https://assets.example.com/btc.png',
      isActive: true,
      capabilities: {
        supportsCandles: true,
        supportsOrderBook: true,
        supportsTrades: true,
      },
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      imageUrl: 'https://assets.example.com/btc.png',
      hasImage: true,
      assetImageUrl: 'https://assets.example.com/btc.png',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      price: 100000000,
      change24h: 1.2,
      volume24h: 1000,
      high24h: 101000000,
      low24h: 99000000,
      timestamp: 1712345678000,
    },
  ]),
  getOrderbook: vi.fn(),
  getTrades: vi.fn(),
  getCandles: vi.fn(),
  getReferenceTicker: vi.fn(),
}));

vi.mock('../src/domains/charts/chart.service', () => ({
  getChartCandles: getChartCandlesMock,
}));

vi.mock('../src/domains/kimchi-premium/kimchi-premium.service', () => ({
  getKimchiPremium: getKimchiPremiumMock,
  getKimchiPremiumSnapshot: getKimchiPremiumSnapshotMock,
  isSupportedKimchiVenue: (venue: string) => ['upbit', 'bithumb', 'coinone', 'korbit'].includes(venue),
}));

async function createApp() {
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Responsibility Routes', () => {
  it('GET /market/tickers works without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/tickers?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].exchange).toBe('upbit');
    expect(body.data[0].marketId).toBe('KRW-BTC');
    expect(body.data[0]).toMatchObject({
      canonicalAssetKey: 'BTC',
      hasImage: true,
      imageUrl: 'https://assets.example.com/btc.png',
    });
    await app.close();
  }, 15000);

  it('GET /market/tickers accepts marketId filters without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/tickers?exchange=upbit&marketId=KRW-BTC',
    });

    expect(res.statusCode).toBe(200);
    expect(getMarketSnapshotMock).not.toHaveBeenCalled();
    await app.close();
  }, 10000);

  it('GET /market/snapshot returns snapshot-first canonical data without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/snapshot?exchange=upbit&symbols=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      status: 'success',
      items: [
        {
          symbol: 'BTC',
          price: 100000000,
          status: 'success',
        },
      ],
    });
    expect(getMarketSnapshotMock).toHaveBeenCalledWith({
      exchange: 'upbit',
      scope: undefined,
      symbols: ['BTC'],
      limit: undefined,
    });
    await app.close();
  }, 10000);

  it('GET /market/symbols returns symbol support metadata without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/symbols?exchange=upbit',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items[0]).toMatchObject({
      symbol: 'BTC',
      marketId: 'KRW-BTC',
      tradable: true,
      kimchiComparable: true,
    });
    await app.close();
  });

  it('GET /market/symbols/audit returns coverage diagnostics without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/symbols/audit?exchange=upbit&refresh=1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.summary[0]).toMatchObject({
      exchange: 'upbit',
      totalAssets: 1,
      canonicalMappedCount: 1,
      fallbackKeyAvailableCount: 1,
    });
    expect(body.data.items[0]).toMatchObject({
      exchange: 'upbit',
      marketId: 'KRW-BTC',
      fallbackKey: 'coingecko:bitcoin',
      stableAssetKey: 'coingecko:bitcoin',
    });
    expect(body.data.details[0]).toMatchObject({
      exchange: 'upbit',
      priorityRankedMissingImageCandidates: [],
    });
    expect(getAssetCoverageAuditMock).toHaveBeenCalledWith({
      exchange: 'upbit',
      refresh: true,
    });
    await app.close();
  });

  it('GET /charts/candles returns canonical history plus live candle without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/charts/candles?exchange=upbit&symbol=BTC&interval=1m&limit=200',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      marketId: 'KRW-BTC',
      symbol: 'BTC',
      canonicalSymbol: 'BTC',
      displaySymbol: 'BTC/KRW',
      interval: '1m',
      liveStatus: 'live',
    });
    expect(getChartCandlesMock).toHaveBeenCalledWith({
      exchange: 'upbit',
      symbol: 'BTC',
      marketId: undefined,
      interval: '1m',
      limit: 200,
    });
    await app.close();
  });

  it('GET /kimchi-premium works without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium?symbols=BTC&venue=bithumb',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].binanceKrwPrice).toBe(94500000);
    expect(getKimchiPremiumMock).toHaveBeenCalledWith(['BTC'], { venues: ['bithumb'], quoteCurrency: 'KRW' });
    await app.close();
  });

  it('GET /kimchi-premium/snapshot returns snapshot-first kimchi premium data without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium/snapshot?symbols=BTC&domesticExchange=upbit',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      domesticExchange: 'upbit',
      globalExchange: 'binance',
      status: 'success',
      supportedPairs: ['BTC'],
    });
    expect(getKimchiPremiumSnapshotMock).toHaveBeenCalledWith(['BTC'], {
      venues: ['upbit'],
      quoteCurrency: 'KRW',
    });
    await app.close();
  });

  it('GET /kimchi-premium/comparable-symbols returns canonical comparable symbols without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium/comparable-symbols?exchange=upbit',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items[0]).toMatchObject({
      symbol: 'BTC',
      displayName: '비트코인',
    });
    expect(listComparableKimchiSymbolsMock).toHaveBeenCalledWith({
      exchange: 'upbit',
      limit: undefined,
    });
    await app.close();
  });

  it('GET /kimchi-premium without symbols returns structured invalid-request details', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium',
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.details).toMatchObject({
      code: 'INVALID_REQUEST',
      field: 'symbols',
      reason: 'REQUIRED',
      acceptedFormat: 'comma-separated canonical symbols',
    });
    await app.close();
  });

  it('GET /kimchi-premium normalizes whitespace, lowercase, and duplicate symbols', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium?symbols=btc,%20ETH,btc&exchange=coinone',
    });

    expect(res.statusCode).toBe(200);
    expect(getKimchiPremiumMock).toHaveBeenCalledWith(['BTC', 'ETH'], {
      venues: ['coinone'],
      quoteCurrency: 'KRW',
    });
    await app.close();
  });

  it('GET /trading/chance requires auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/trading/chance?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
