import { afterEach, describe, expect, it, vi } from 'vitest';

const ROUTE_CONTRACT_TEST_TIMEOUT_MS = 15000;

vi.mock('../src/domains/trading/trading.service', () => ({
  getOrderChance: vi.fn(),
  createTradingOrder: vi.fn(),
  cancelTradingOrder: vi.fn(),
  getTradingOrder: vi.fn(),
  getOpenOrders: vi.fn(async () => [
    {
      exchange: 'upbit',
      orderId: 'order-1',
      symbol: 'BTC',
      market: 'BTC/KRW',
      side: 'buy',
      type: 'limit',
      status: 'open',
      price: 100000000,
      quantity: 0.01,
      filledQuantity: 0,
      remainingQuantity: 0.01,
      createdAt: 1712345678000,
      updatedAt: 1712345678000,
    },
  ]),
  getRecentFills: vi.fn(async () => [
    {
      exchange: 'upbit',
      fillId: 'fill-1',
      orderId: 'order-1',
      symbol: 'BTC',
      market: 'BTC/KRW',
      side: 'buy',
      price: 100000000,
      quantity: 0.01,
      fee: 1000,
      feeCurrency: 'KRW',
      timestamp: 1712345678000,
    },
  ]),
}));

vi.mock('../src/domains/portfolio/portfolio.service', () => {
  const getPortfolioSnapshot = vi.fn(async () => ({
    exchange: 'upbit',
    balances: [
      { asset: 'KRW', free: 1000000, locked: 0, averageBuyPrice: 0 },
      { asset: 'BTC', free: 0.01, locked: 0, averageBuyPrice: 95000000 },
    ],
    positions: [
      {
        exchange: 'upbit',
        symbol: 'BTC',
        quantity: 0.01,
        free: 0.01,
        locked: 0,
        averageBuyPrice: 95000000,
        currentPrice: 100000000,
        marketValue: 1000000,
        pnlValue: 50000,
        pnlPercent: 5.26,
        timestamp: 1712345678000,
      },
    ],
    totalAssetValue: 2000000,
    totalPnlValue: 50000,
    totalPnlPercent: 2.56,
    timestamp: 1712345678000,
  }));
  const getAssetHistory = vi.fn(async () => [
    {
      id: 'fill-1',
      exchange: 'upbit',
      assetSymbol: 'BTC',
      symbol: 'BTC',
      eventType: 'trade',
      type: 'trade',
      amount: 0.01,
      price: 100000000,
      occurredAt: '2024-04-05T19:34:38.000Z',
      timestamp: 1712345678000,
      source: 'exchange_private_api',
      sourceType: 'fill',
      isSynthetic: false,
      isVerifiedUserEvent: true,
      description: 'BUY 0.01 @ 100000000',
    },
  ]);
  return {
    getPortfolioSnapshot,
    getPortfolioSnapshotRouteResponse: vi.fn(async () => ({
      data: await getPortfolioSnapshot(),
      routeStatus: 'ok',
      privateStreamingStatus: 'live_stream_available',
      pollingFallbackRecommended: false,
    })),
    getAssetHistory,
    getAssetHistoryRouteResponse: vi.fn(async () => ({
      data: await getAssetHistory(),
      routeStatus: 'ok',
      privateStreamingStatus: 'live_stream_available',
      pollingFallbackRecommended: false,
    })),
    getAggregatedPortfolioSummary: vi.fn(async () => ({
    requestedExchanges: ['upbit', 'bithumb'],
    connectedExchanges: ['upbit'],
    partialSuccess: true,
    failures: [
      {
        exchange: 'bithumb',
        code: 'exchange_unavailable',
        message: '거래소 응답이 일시적으로 불안정합니다.',
        details: { upstreamStatus: 503 },
      },
    ],
    totals: {
      estimatedTotalAssetValueKrw: 2000000,
      estimatedTotalPnlValueKrw: 50000,
      estimatedTotalPnlPercent: 2.56,
    },
    exchangeGroups: [
      {
        exchange: 'upbit',
        exchangeName: '업비트',
        quoteCurrency: 'KRW',
        assetCount: 2,
        totalAssetValue: 2000000,
        totalAssetValueKrw: 2000000,
        totalPnlValue: 50000,
        totalPnlValueKrw: 50000,
        fetchedAt: '2026-04-21T00:00:00.000Z',
        assets: [
          {
            exchange: 'upbit',
            exchangeName: '업비트',
            quoteCurrency: 'KRW',
            asset: 'BTC',
            quantity: 0.01,
            availableQuantity: 0.01,
            lockedQuantity: 0,
            averageBuyPrice: 95000000,
            averageBuyPriceKrw: 95000000,
            currentPrice: 100000000,
            currentPriceKrw: 100000000,
            marketValue: 1000000,
            marketValueKrw: 1000000,
            pnlValue: 50000,
            pnlValueKrw: 50000,
            pnlPercent: 5.26,
            isCashAsset: false,
            timestamp: 1712345678000,
          },
        ],
      },
    ],
    assets: [
      {
        exchange: 'upbit',
        exchangeName: '업비트',
        quoteCurrency: 'KRW',
        asset: 'BTC',
        quantity: 0.01,
        availableQuantity: 0.01,
        lockedQuantity: 0,
        averageBuyPrice: 95000000,
        averageBuyPriceKrw: 95000000,
        currentPrice: 100000000,
        currentPriceKrw: 100000000,
        marketValue: 1000000,
        marketValueKrw: 1000000,
        pnlValue: 50000,
        pnlValueKrw: 50000,
        pnlPercent: 5.26,
        isCashAsset: false,
        timestamp: 1712345678000,
      },
    ],
    generatedAt: '2026-04-21T00:00:00.000Z',
    })),
  };
});

async function createAppWithToken() {
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
  return { app, token };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Trading and Portfolio Route Contracts', () => {
  it('GET /trading/open-orders returns canonical orders', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/trading/open-orders?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].orderId).toBe('order-1');
    expect(body.data[0].status).toBe('open');
    await app.close();
  }, ROUTE_CONTRACT_TEST_TIMEOUT_MS);

  it('GET /trading/fills returns canonical fills', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/trading/fills?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].fillId).toBe('fill-1');
    await app.close();
  }, ROUTE_CONTRACT_TEST_TIMEOUT_MS);

  it('GET /portfolio/summary returns canonical portfolio snapshot', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/portfolio/summary?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.exchange).toBe('upbit');
    expect(body.data.totalAssetValue).toBe(2000000);
    await app.close();
  }, ROUTE_CONTRACT_TEST_TIMEOUT_MS);

  it('GET /portfolio/assets returns aggregated asset summary with partial failures', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/portfolio/assets',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.partialSuccess).toBe(true);
    expect(body.data.failures[0].exchange).toBe('bithumb');
    expect(body.data.assets[0].asset).toBe('BTC');
    await app.close();
  }, ROUTE_CONTRACT_TEST_TIMEOUT_MS);

  it('GET /portfolio/history returns verified user events with source metadata', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/portfolio/history?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0]).toMatchObject({
      id: 'fill-1',
      assetSymbol: 'BTC',
      eventType: 'trade',
      sourceType: 'fill',
      isSynthetic: false,
      isVerifiedUserEvent: true,
    });
    await app.close();
  }, ROUTE_CONTRACT_TEST_TIMEOUT_MS);
});
