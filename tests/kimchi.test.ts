import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';

describe('Kimchi Premium API', () => {
  it('GET /api/v1/public/kimchi-premium - requires symbols param', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/kimchi-premium',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    await app.close();
  });

  it('GET /api/v1/public/markets - returns market list without auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/markets',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    await app.close();
  });

  it('GET /api/v1/public/search - requires q param', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/public/search',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('GET /health - returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    await app.close();
  });
});
