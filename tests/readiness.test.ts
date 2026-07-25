import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { getReadinessSnapshot } from '../src/health/readiness';

describe('readiness', () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('reports ready only when PostgreSQL and Redis probes both succeed', async () => {
    const snapshot = await getReadinessSnapshot({
      databaseProbe: async () => {},
      redisProbe: async () => {},
      timeoutMs: 50,
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      checks: {
        database: 'ok',
        redis: 'ok',
      },
    });
  });

  it('fails closed without exposing dependency errors', async () => {
    const snapshot = await getReadinessSnapshot({
      databaseProbe: async () => {
        throw new Error('postgresql://credential-bearing-value');
      },
      redisProbe: async () => {},
      timeoutMs: 50,
    });

    expect(snapshot).toMatchObject({
      status: 'not_ready',
      checks: {
        database: 'failed',
        redis: 'ok',
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain('credential-bearing-value');
  });

  it('returns HTTP 503 until dependencies are ready and 200 afterward', async () => {
    const notReadyApp = await buildApp({
      readinessProbe: async () => ({
        status: 'not_ready',
        timestamp: 1,
        checks: { database: 'failed', redis: 'ok' },
      }),
    });
    apps.push(notReadyApp);
    const notReady = await notReadyApp.inject({ method: 'GET', url: '/ready' });
    expect(notReady.statusCode).toBe(503);

    const readyApp = await buildApp({
      readinessProbe: async () => ({
        status: 'ready',
        timestamp: 2,
        checks: { database: 'ok', redis: 'ok' },
      }),
    });
    apps.push(readyApp);
    const ready = await readyApp.inject({ method: 'GET', url: '/ready' });
    expect(ready.statusCode).toBe(200);
  });
});
