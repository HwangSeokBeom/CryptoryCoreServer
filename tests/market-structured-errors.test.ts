import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const korbitProvider = {
  exchange: 'korbit',
  metadata: {
    displayName: '코빗',
    quoteCurrency: 'KRW',
    capabilities: [],
  },
  listMarkets: vi.fn(),
  getMarketCapabilitySnapshot: vi.fn(),
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

const resolveCandleSnapshot = vi.fn();

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn(() => korbitProvider),
    listMarketDataProviders: vi.fn(() => [korbitProvider]),
    getReferencePriceSource: vi.fn(() => ({
      getReferenceTicker: vi.fn(),
    })),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

vi.mock('../src/domains/charts/candle.snapshot', () => ({
  resolveCandleSnapshot,
}));

async function createApp() {
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

function mockKorbitMarket() {
  korbitProvider.listMarkets.mockResolvedValue([
    {
      symbol: 'BTC',
      exchangeSymbol: 'btc_krw',
      marketId: 'btc_krw',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'btc_krw',
      tradable: true,
    },
  ]);
  korbitProvider.getMarketCapabilitySnapshot.mockResolvedValue({
    websocketTickerSymbols: ['BTC'],
    capabilitySymbols: {
      tickers: ['BTC'],
      orderbook: ['BTC'],
      trades: ['BTC'],
      candles: ['BTC'],
    },
  });
}

describe('structured market data responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKorbitMarket();
    publicMarketDataStore.getOrderbook.mockReturnValue(null);
    publicMarketDataStore.getTrades.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns structured candle unavailable errors with metadata', async () => {
    resolveCandleSnapshot.mockResolvedValueOnce({
      support: 'supported',
      status: 'unavailable',
      interval: '1h',
      reason: 'upstream_503',
      meta: {
        isRenderable: false,
        freshnessState: 'unavailable',
        lastSuccessfulAt: null,
        source: 'fallback',
        fallbackReason: 'upstream_503',
        pointCount: 0,
        renderPriority: 'unavailable',
        refreshPriority: 'normal',
        recommendedClientBehavior: 'cold_placeholder_only',
      },
    });

    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?exchange=korbit&marketId=btc_krw&interval=1h',
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'candles',
      exchange: 'korbit',
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
      retryable: true,
      metadata: {
        marketId: 'btc_krw',
        canonicalSymbol: 'BTC',
        iconUrl: expect.stringContaining('/btc.png'),
      },
    });
    await app.close();
  });

  it('returns structured orderbook unavailable errors when no stale cache exists', async () => {
    korbitProvider.getOrderbookSnapshot.mockRejectedValueOnce(new Error('Korbit orderbook HTTP 503'));

    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/orderbook?exchange=korbit&marketId=btc_krw',
    });

    expect(korbitProvider.getOrderbookSnapshot).toHaveBeenCalledWith('BTC');
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'orderbook',
      exchange: 'korbit',
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
    });
    await app.close();
  });

  it('treats empty trades as a successful empty section', async () => {
    korbitProvider.getRecentTrades.mockResolvedValueOnce([]);

    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/trades?exchange=korbit&marketId=btc_krw&limit=20',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.metadata).toMatchObject({
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
      availability: {
        trades: 'available',
      },
    });
    await app.close();
  });

  it('rejects ambiguous symbol input before calling Korbit upstream', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/orderbook?exchange=korbit&symbol=C',
    });

    expect(korbitProvider.getOrderbookSnapshot).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'orderbook',
      exchange: 'korbit',
      retryable: false,
    });
    await app.close();
  });
});
