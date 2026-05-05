import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('global error handler', () => {
  it('returns AppError client responses without logging them as unhandled errors', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-value',
      NODE_ENV: 'test',
    };
    vi.resetModules();
    const [{ buildApp }, { AppError }, { logger }] = await Promise.all([
      import('../src/app'),
      import('../src/utils/errors'),
      import('../src/utils/logger'),
    ]);
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const app = await buildApp();
    app.get('/__test/client-error', async () => {
      throw new AppError(400, 'invalid test request', { field: 'symbol' }, 'INVALID_TEST_REQUEST');
    });

    const response = await app.inject({ method: 'GET', url: '/__test/client-error' });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      success: false,
      code: 'INVALID_TEST_REQUEST',
      details: { field: 'symbol' },
    });
    expect(errorSpy).not.toHaveBeenCalledWith(expect.anything(), 'Unhandled error');
    expect(warnSpy).toHaveBeenCalledWith(expect.objectContaining({
      code: 'INVALID_TEST_REQUEST',
      statusCode: 400,
    }), 'Handled client error');
    await app.close();
  }, 15000);
});
