import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';

describe('Application security defaults', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('adds baseline security and rate-limit headers', async () => {
    app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(response.headers['x-ratelimit-limit']).toBe('300');
  });
});
