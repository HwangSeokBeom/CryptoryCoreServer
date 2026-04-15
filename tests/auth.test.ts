import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app';

describe('Auth API', () => {
  it('POST /api/v1/auth/register - validates input', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: 'invalid', password: '12', nickname: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    await app.close();
  });

  it('POST /api/v1/auth/login - validates input', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'bad', password: '' },
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    await app.close();
  });
});
