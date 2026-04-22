import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/public-market/public-market.service', () => ({
  listPublicMarkets: vi.fn(() => []),
  searchPublicMarkets: vi.fn(() => []),
  getPublicTickers: vi.fn(async () => [
    {
      channel: 'tickers',
      exchange: 'upbit',
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
      imageDebug: {
        canonicalSymbol: 'BTC',
        assetSlug: 'bitcoin',
        preferredImageSlug: 'bitcoin',
        imageResolutionSource: 'direct_slug',
        imageMissingReason: null,
      },
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      price: 100000000,
      change24h: 1.25,
      volume24h: 1234,
      high24h: 101000000,
      low24h: 98000000,
      timestamp: 1712345678000,
    },
  ]),
  getPublicOrderbook: vi.fn(async () => ({
    channel: 'orderbook',
    exchange: 'upbit',
    symbol: 'BTC',
    market: 'BTC/KRW',
    baseCurrency: 'BTC',
    quoteCurrency: 'KRW',
    rawSymbol: 'KRW-BTC',
    bestAsk: 100010000,
    bestBid: 99990000,
    asks: [{ price: 100010000, qty: 0.2 }],
    bids: [{ price: 99990000, qty: 0.3 }],
    timestamp: 1712345678000,
  })),
  getPublicTrades: vi.fn(() => [
    {
      channel: 'trades',
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      tradeId: 'trade-1',
      side: 'buy',
      price: 100000000,
      quantity: 0.01,
      timestamp: 1712345678000,
    },
  ]),
  getPublicCandles: vi.fn(async () => [
    {
      time: 1712345320000,
      open: 99000000,
      high: 101000000,
      low: 98500000,
      close: 100000000,
      volume: 321,
    },
  ]),
  getPublicCandlesWithMeta: vi.fn(async () => ({
    items: [
      {
        time: 1712345320000,
        open: 99000000,
        high: 101000000,
        low: 98500000,
        close: 100000000,
        volume: 321,
      },
    ],
    meta: {
      isRenderable: true,
      freshnessState: 'live',
      lastSuccessfulAt: 1712345678000,
      source: 'memory',
      fallbackReason: null,
      pointCount: 1,
      renderPriority: 'cached',
      refreshPriority: 'visible',
      recommendedClientBehavior: 'first_paint_ok',
    },
  })),
  getPublicKimchiPremium: vi.fn(async () => [
    {
      symbol: 'BTC',
      canonicalAssetKey: 'BTC',
      assetImageUrl: 'https://assets.example.com/btc.png',
      nameKo: '비트코인',
      nameEn: 'Bitcoin',
      binanceKrwPrice: 99500000,
      premiums: [
        {
          exchange: 'upbit',
          exchangeName: '업비트',
          domesticPrice: 100000000,
          premiumPercent: 0.5,
        },
      ],
    },
  ]),
}));

async function createApp() {
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Public REST Contracts', () => {
  it('GET /api/v1/public/tickers returns the fixed ticker schema', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/tickers?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items[0].exchange).toBe('upbit');
    expect(body.data.items[0].exchangeName).toBe('업비트');
    expect(body.data.items[0].marketId).toBe('KRW-BTC');
    expect(body.data.items[0].canonicalSymbol).toBe('BTC');
    expect(body.data.items[0].displaySymbol).toBe('BTC/KRW');
    expect(body.data.items[0].canonicalAssetKey).toBe('BTC');
    expect(body.data.items[0].assetImageUrl).toBe('https://assets.example.com/btc.png');
    expect(body.data.items[0].imageFallbackKey).toBe('symbol:BTC');
    expect(body.data.items[0].fallbackKey).toBe('symbol:BTC');
    expect(body.data.items[0].imageLookupKey).toBe('symbol:BTC');
    expect(body.data.total).toBe(1);
    await app.close();
  }, 20000);

  it('GET /api/v1/public/tickers accepts image provenance fields on debug requests', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/tickers?exchange=upbit&symbol=BTC&debug=1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.items[0].imageDebug).toMatchObject({
      canonicalSymbol: 'BTC',
      assetSlug: 'bitcoin',
      preferredImageSlug: 'bitcoin',
      imageResolutionSource: 'direct_slug',
    });
    await app.close();
  }, 15000);

  it('GET /api/v1/public/orderbook returns the fixed orderbook schema', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/orderbook?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.marketId).toBe('KRW-BTC');
    expect(body.data.displaySymbol).toBe('BTC/KRW');
    expect(body.data.bestAsk).toBe(100010000);
    expect(body.data.asks[0].quantity).toBe(0.2);
    await app.close();
  });

  it('GET /api/v1/public/trades returns the fixed trades schema', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/trades?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.marketId).toBe('KRW-BTC');
    expect(body.data.displaySymbol).toBe('BTC/KRW');
    expect(body.data.items[0].notional).toBe(1000000);
    expect(body.data.market).toBe('BTC/KRW');
    await app.close();
  });

  it('GET /api/v1/public/candles returns the fixed candles schema', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/candles?exchange=upbit&symbol=BTC&period=1h&limit=1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.marketId).toBe('KRW-BTC');
    expect(body.data.canonicalSymbol).toBe('BTC');
    expect(body.data.displaySymbol).toBe('BTC/KRW');
    expect(body.data.interval).toBe('1h');
    expect(body.data.items[0].close).toBe(100000000);
    expect(body.data.meta.freshnessState).toBe('live');
    expect(body.data.meta.recommendedClientBehavior).toBe('first_paint_ok');
    await app.close();
  });

  it('GET /api/v1/public/kimchi-premium returns the fixed kimchi premium schema', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/kimchi-premium?symbols=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.baseExchange).toBe('binance');
    expect(body.data.items[0].canonicalAssetKey).toBe('BTC');
    expect(body.data.items[0].assetImageUrl).toBe('https://assets.example.com/btc.png');
    expect(body.data.items[0].domestic[0].priceKrw).toBe(100000000);
    await app.close();
  });
});
