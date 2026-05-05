import { spawnSync } from 'child_process';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

function runEnvImport(envOverrides: Record<string, string>) {
  return spawnSync(tsxBin, [
    '-e',
    [
      'import("./src/config/env.ts").then((mod) => {',
      'const env = mod.env ?? mod.default?.env;',
      'console.log(JSON.stringify({',
      'newsProvider: env.NEWS_PROVIDER,',
      'newsApiBaseUrl: env.NEWSAPI_API_BASE_URL,',
      'fcmEnabled: env.FCM_ENABLED,',
      'fcmDryRun: env.FCM_DRY_RUN,',
      'marketCollectorEnabled: env.MARKET_COLLECTOR_ENABLED,',
      'marketStartupWarmupEnabled: env.MARKET_STARTUP_WARMUP_ENABLED,',
      '}));',
      '});',
    ].join(''),
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://cryptomts:cryptomts@localhost:5433/cryptomts?schema=public',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-jwt-secret-value',
      ...envOverrides,
    },
    encoding: 'utf8',
  });
}

describe('runtime env validation', () => {
  it('accepts NEWS_PROVIDER=newsapi in development without requiring a NewsAPI key', () => {
    const result = runEnvImport({
      NODE_ENV: 'development',
      NEWS_PROVIDER: 'newsapi',
      NEWSAPI_API_KEY: '',
      NEWSAPI_API_BASE_URL: 'https://newsapi.org/v2',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      newsProvider: 'newsapi',
      newsApiBaseUrl: 'https://newsapi.org/v2',
      fcmEnabled: false,
      fcmDryRun: false,
      marketCollectorEnabled: false,
      marketStartupWarmupEnabled: false,
    });
  });

  it('rejects missing NEWSAPI_API_KEY in production when NewsAPI news is explicitly enabled', () => {
    const result = runEnvImport({
      NODE_ENV: 'production',
      NEWS_PROVIDER: 'newsapi',
      NEWSAPI_API_KEY: '',
      FEATURE_NEWS_ENABLED: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NEWSAPI_API_KEY');
  });

  it('parses explicit boolean env strings without Boolean(string) coercion', () => {
    const result = runEnvImport({
      FCM_DRY_RUN: 'false',
      FCM_ENABLED: 'true',
      MARKET_COLLECTOR_ENABLED: 'false',
      MARKET_STARTUP_WARMUP_ENABLED: 'false',
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      fcmEnabled: true,
      fcmDryRun: false,
      marketCollectorEnabled: false,
      marketStartupWarmupEnabled: false,
    });
  });

  it('parses true and false FCM boolean values exactly', () => {
    const trueResult = runEnvImport({
      FCM_DRY_RUN: 'true',
      FCM_ENABLED: 'true',
    });
    const falseResult = runEnvImport({
      FCM_DRY_RUN: 'false',
      FCM_ENABLED: 'false',
    });

    expect(trueResult.status).toBe(0);
    expect(JSON.parse(trueResult.stdout.trim())).toMatchObject({
      fcmEnabled: true,
      fcmDryRun: true,
    });
    expect(falseResult.status).toBe(0);
    expect(JSON.parse(falseResult.stdout.trim())).toMatchObject({
      fcmEnabled: false,
      fcmDryRun: false,
    });
  });

  it('rejects invalid boolean strings with the env field name', () => {
    const result = runEnvImport({
      FCM_DRY_RUN: 'maybe',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FCM_DRY_RUN');
    expect(result.stderr).toContain('must be a boolean value');
  });

  it('does not put FIREBASE_PRIVATE_KEY in FCM initialization log payloads', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-value',
      NODE_ENV: 'test',
      FCM_ENABLED: 'true',
      FCM_DRY_RUN: 'false',
      FIREBASE_PROJECT_ID: 'cryptory-test',
      FIREBASE_CLIENT_EMAIL: 'firebase-adminsdk@example.iam.gserviceaccount.com',
      FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nsecret-test-key\\n-----END PRIVATE KEY-----\\n',
    };
    vi.doMock('firebase-admin', () => ({
      default: {
        apps: [],
        credential: { cert: vi.fn(() => ({ projectId: 'cryptory-test' })) },
        initializeApp: vi.fn(),
      },
    }));
    const { logger } = await import('../src/utils/logger');
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const { initializeFcm } = await import('../src/domains/push/fcm.service');

    initializeFcm();

    const serializedLogs = JSON.stringify(infoSpy.mock.calls);
    expect(serializedLogs).toContain('[FCM] initialized enabled=true dryRun=false');
    expect(serializedLogs).not.toContain('secret-test-key');
    expect(serializedLogs).not.toContain('BEGIN PRIVATE KEY');
  });
});
