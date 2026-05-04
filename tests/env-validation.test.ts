import { spawnSync } from 'child_process';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const tsxBin = join(process.cwd(), 'node_modules/.bin/tsx');

function runEnvImport(envOverrides: Record<string, string>) {
  return spawnSync(tsxBin, [
    '-e',
    [
      'import("./src/config/env.ts").then((mod) => {',
      'const env = mod.env ?? mod.default?.env;',
      'console.log(JSON.stringify({ newsProvider: env.NEWS_PROVIDER, newsApiBaseUrl: env.NEWSAPI_API_BASE_URL }));',
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
});
