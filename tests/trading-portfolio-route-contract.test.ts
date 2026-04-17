import { afterEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../src/domains/portfolio/portfolio.service', () => ({
  getPortfolioSnapshot: vi.fn(async () => ({
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
  })),
  getAssetHistory: vi.fn(async () => [
    {
      exchange: 'upbit',
      symbol: 'BTC',
      type: 'trade',
      amount: 0.01,
      timestamp: 1712345678000,
      description: 'BUY 0.01 @ 100000000',
    },
  ]),
}));

async function createAppWithToken() {
  vi.resetModules();
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
  });

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
  });

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
  });
});
