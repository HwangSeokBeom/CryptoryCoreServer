import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: '/dev/null',
};

const BINANCE_ENDPOINT_ENV_KEYS = [
  'BINANCE_PUBLIC_API_BASE_URL',
  'BINANCE_PRIVATE_API_BASE_URL',
  'BINANCE_WS_BASE_URL',
  'BINANCE_API_BASE_URL',
  'BINANCE_REST_BASE_URL',
  'BINANCE_WS_URL',
  'BINANCE_PUBLIC_WS_URL',
  'BINANCE_PRIVATE_WS_URL',
] as const;

function resetEnv(overrides: Record<string, string> = {}) {
  process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
  for (const key of BINANCE_ENDPOINT_ENV_KEYS) {
    delete process.env[key];
  }
  Object.assign(process.env, overrides);
}

describe('Binance endpoint configuration', () => {
  beforeEach(() => {
    vi.resetModules();
    resetEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it('defaults public REST to data-api and private REST to api.binance.com', async () => {
    const { getExchangeConfig } = await import('../src/config/exchange.config');

    const config = getExchangeConfig('binance');

    expect(config.restBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.publicRestBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.privateRestBaseUrl).toBe('https://api.binance.com');
    expect(config.publicWebSocketUrl).toBe('wss://stream.binance.com:9443');
  });

  it('keeps the legacy BINANCE_API_BASE_URL as a public REST fallback only', async () => {
    resetEnv({
      BINANCE_API_BASE_URL: 'https://api1.binance.com',
    });
    const { getExchangeConfig } = await import('../src/config/exchange.config');

    const config = getExchangeConfig('binance');

    expect(config.publicRestBaseUrl).toBe('https://api1.binance.com');
    expect(config.privateRestBaseUrl).toBe('https://api.binance.com');
  });

  it('uses explicit public, private, and websocket Binance endpoint overrides', async () => {
    resetEnv({
      BINANCE_PUBLIC_API_BASE_URL: 'https://data-api.binance.vision',
      BINANCE_PRIVATE_API_BASE_URL: 'https://api4.binance.com',
      BINANCE_WS_BASE_URL: 'wss://stream.binance.com:9443',
    });
    const { buildBinancePublicWebSocketUrl, getExchangeConfig } = await import('../src/config/exchange.config');

    const config = getExchangeConfig('binance');

    expect(config.publicRestBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.privateRestBaseUrl).toBe('https://api4.binance.com');
    expect(buildBinancePublicWebSocketUrl(['btcusdt@ticker', 'ethusdt@trade'])).toBe(
      'wss://stream.binance.com:9443/stream?streams=btcusdt@ticker/ethusdt@trade',
    );
  });

  it('does not use the public data host for private REST fallback values', async () => {
    resetEnv({
      BINANCE_REST_BASE_URL: 'https://data-api.binance.vision',
      BINANCE_PRIVATE_API_BASE_URL: 'https://data-api.binance.vision',
    });
    const { getExchangeConfig } = await import('../src/config/exchange.config');

    const config = getExchangeConfig('binance');

    expect(config.publicRestBaseUrl).toBe('https://data-api.binance.vision');
    expect(config.privateRestBaseUrl).toBe('https://api.binance.com');
  });

  it('routes Binance exchangeInfo through the public REST host', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      symbols: [
        {
          symbol: 'BTCUSDT',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          status: 'TRADING',
        },
      ],
    }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { BinanceProvider } = await import('../src/providers/exchanges/binance.provider');

    const provider = new BinanceProvider();
    await provider.listMarkets();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://data-api.binance.vision/api/v3/exchangeInfo',
      expect.any(Object),
    );
  });
});
