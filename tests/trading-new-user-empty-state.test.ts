import { afterEach, describe, expect, it, vi } from 'vitest';

async function createAppWithToken() {
  vi.resetModules();
  const { AppError } = await import('../src/utils/errors');
  vi.doMock('../src/domains/trading/trading.service', () => ({
    getOrderChance: vi.fn(),
    createTradingOrder: vi.fn(),
    cancelTradingOrder: vi.fn(),
    getTradingOrder: vi.fn(),
    getOpenOrders: vi.fn(async () => {
      throw new AppError(409, 'upbit exchange connection is not connected', {
        exchange: 'upbit',
        reason: 'missing_connection',
      }, 'exchange_not_connected');
    }),
    getRecentFills: vi.fn(async () => {
      throw new AppError(409, 'upbit exchange connection is not connected', {
        exchange: 'upbit',
        reason: 'missing_connection',
      }, 'exchange_not_connected');
    }),
  }));

  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'new-apple-user', email: 'apple_placeholder@example.com', authProvider: 'apple' });
  return { app, token };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.doUnmock('../src/domains/trading/trading.service');
});

describe('new user trading empty state routes', () => {
  it('GET /trading/open-orders returns a 200 empty state when no exchange is connected', async () => {
    const { app, token } = await createAppWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trading/open-orders?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      data: [],
      status: 'no_connection',
      unavailableReason: 'no_connection',
    });
    await app.close();
  });

  it('GET /trading/fills returns a 200 empty state when no exchange is connected', async () => {
    const { app, token } = await createAppWithToken();

    const res = await app.inject({
      method: 'GET',
      url: '/trading/fills?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      data: [],
      status: 'no_connection',
      unavailableReason: 'no_connection',
    });
    await app.close();
  });
});
