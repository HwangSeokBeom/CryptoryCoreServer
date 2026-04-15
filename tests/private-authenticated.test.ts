import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/private-account/private-account.service', () => ({
  getPrivateBalances: vi.fn(async () => ({
    exchange: 'upbit',
    cash: { asset: 'KRW', free: 1000000, locked: 0 },
    assets: [],
  })),
  getPrivateHoldings: vi.fn(async () => []),
  getPrivatePortfolio: vi.fn(async () => [{ symbol: 'BTC', quantity: 0.1 }]),
  getPrivatePortfolioSummary: vi.fn(async () => ({
    totalAsset: 1500000,
    cash: 1000000,
    totalPnl: 500000,
    totalPnlPercent: 50,
  })),
  getPrivateOrders: vi.fn(async () => []),
  getPrivateOpenOrders: vi.fn(async () => []),
  getPrivateFills: vi.fn(async () => []),
}));

vi.mock('../src/modules/private-account/exchange-connections.service', () => ({
  listExchangeConnections: vi.fn(async () => []),
  createExchangeConnection: vi.fn(async () => ({
    id: 'conn-1',
    exchange: 'upbit',
    exchangeName: '업비트',
    label: 'Primary Upbit',
    apiKeyMasked: 'abc***xyz',
    hasSecretKey: true,
    hasPassphrase: false,
    validation: {
      status: 'placeholder',
      mode: 'placeholder',
      canUsePrivateApi: false,
      message: 'Credentials stored for upbit, but a live private adapter is not implemented yet.',
      checkedAt: '2026-04-15T00:00:00.000Z',
    },
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
  })),
  updateExchangeConnection: vi.fn(async () => ({
    id: 'conn-1',
    exchange: 'upbit',
    exchangeName: '업비트',
    label: 'Updated Upbit',
    apiKeyMasked: 'abc***xyz',
    hasSecretKey: true,
    hasPassphrase: false,
    validation: {
      status: 'placeholder',
      mode: 'placeholder',
      canUsePrivateApi: false,
      message: 'Credentials stored for upbit, but a live private adapter is not implemented yet.',
      checkedAt: '2026-04-15T00:05:00.000Z',
    },
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:05:00.000Z',
  })),
  removeExchangeConnection: vi.fn(async () => ({
    exchange: 'upbit',
    exchangeName: '업비트',
    removedAt: '2026-04-15T00:10:00.000Z',
  })),
}));

vi.mock('../src/modules/orders/orders.service', () => ({
  createOrder: vi.fn(async (_userId: string, input: any) => ({
    order: {
      id: 'order-1',
      symbol: input.symbol,
      exchange: input.exchange,
      side: input.side,
      type: input.type,
      price: 100,
      quantity: input.quantity,
      total: 100 * input.quantity,
      createdAt: new Date('2026-04-14T00:00:00.000Z'),
    },
  })),
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

describe('Private Authenticated Routes', () => {
  it('GET /api/v1/private/exchange-connections returns a fixed list schema', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/private/exchange-connections',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items).toEqual([]);
    expect(body.data.total).toBe(0);
    await app.close();
  });

  it('GET /api/v1/private/portfolio returns data for authenticated user', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/private/portfolio',
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].symbol).toBe('BTC');
    await app.close();
  });

  it('POST /api/v1/private/orders creates an order for authenticated user', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/private/orders',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        symbol: 'BTC',
        exchange: 'upbit',
        side: 'buy',
        type: 'market',
        quantity: 0.01,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.order.symbol).toBe('BTC');
    await app.close();
  });

  it('POST /api/v1/private/exchange-connections creates a validated connection payload', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/private/exchange-connections',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        exchange: 'upbit',
        label: 'Primary Upbit',
        apiKey: 'test-api-key',
        secretKey: 'test-secret-key',
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.exchange).toBe('upbit');
    expect(body.data.validation.status).toBe('placeholder');
    await app.close();
  });

  it('PATCH /api/v1/private/exchange-connections/:exchange updates a connection', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/v1/private/exchange-connections/upbit',
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: {
        label: 'Updated Upbit',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.label).toBe('Updated Upbit');
    expect(body.data.validation.checkedAt).toBe('2026-04-15T00:05:00.000Z');
    await app.close();
  });
});
