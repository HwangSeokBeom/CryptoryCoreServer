import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';

describe('Orders API', () => {
  it('POST /api/v1/private/orders - requires authentication', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/private/orders',
      payload: {
        symbol: 'BTC',
        exchange: 'upbit',
        side: 'buy',
        type: 'market',
        quantity: 0.01,
      },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/v1/private/orders - requires authentication', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/private/orders',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('GET /api/v1/private/portfolio - requires authentication', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/private/portfolio',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
