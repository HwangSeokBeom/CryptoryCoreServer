import { afterEach, describe, expect, it, vi } from 'vitest';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
};

const EXCHANGE_ENV_KEYS = [
  'UPBIT_ACCESS_KEY',
  'UPBIT_SECRET_KEY',
  'BITHUMB_API_KEY',
  'BITHUMB_SECRET_KEY',
  'COINONE_ACCESS_TOKEN',
  'COINONE_SECRET_KEY',
  'KORBIT_API_KEY',
  'KORBIT_SECRET_KEY',
  'BINANCE_API_KEY',
  'BINANCE_SECRET_KEY',
] as const;

function resetRuntimeEnv() {
  Object.assign(process.env, BASE_ENV);
  for (const key of EXCHANGE_ENV_KEYS) {
    delete process.env[key];
  }
}

function createPrismaMock(connection: Record<string, unknown> | null) {
  return {
    exchangeConnection: {
      findUnique: vi.fn(async () => connection),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    user: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => null),
    },
  };
}

afterEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock('../src/config/database');
  vi.doUnmock('../src/core/exchange/registry.bootstrap');
  vi.doUnmock('../src/modules/private-account/exchange-connections.service');
});

describe('runtime exchange credential resolution', () => {
  it('prefers stored user credentials over server env credentials', async () => {
    resetRuntimeEnv();
    process.env.UPBIT_ACCESS_KEY = 'env-upbit-key';
    process.env.UPBIT_SECRET_KEY = 'env-upbit-secret';

    const prisma = createPrismaMock(null);
    vi.doMock('../src/config/database', () => ({ prisma }));

    const { encryptSecret } = await import('../src/modules/private-account/exchange-connections.crypto');
    prisma.exchangeConnection.findUnique.mockResolvedValue({
      apiKeyEncrypted: encryptSecret('user-upbit-key'),
      secretKeyEncrypted: encryptSecret('user-upbit-secret'),
      passphraseEncrypted: null,
    });

    const { resolveRuntimeExchangeCredentials } = await import(
      '../src/domains/exchange-connections/user-exchange-credentials.service'
    );
    const resolved = await resolveRuntimeExchangeCredentials('user-1', 'upbit');

    expect(resolved.source).toBe('user_connection');
    expect(resolved.credentials.apiKey).toBe('user-upbit-key');
    expect(resolved.credentials.secretKey).toBe('user-upbit-secret');
  });

  it('falls back to formal server env credentials when no stored connection exists', async () => {
    resetRuntimeEnv();
    process.env.COINONE_ACCESS_TOKEN = 'env-coinone-token';
    process.env.COINONE_SECRET_KEY = 'env-coinone-secret';

    vi.doMock('../src/config/database', () => ({ prisma: createPrismaMock(null) }));

    const { resolveRuntimeExchangeCredentials } = await import(
      '../src/domains/exchange-connections/user-exchange-credentials.service'
    );
    const resolved = await resolveRuntimeExchangeCredentials('user-1', 'coinone');

    expect(resolved.source).toBe('server_env');
    expect(resolved.credentials).toMatchObject({
      exchange: 'coinone',
      apiKey: 'env-coinone-token',
      secretKey: 'env-coinone-secret',
    });
  });

  it('raises a clear error when server env credentials are incomplete', async () => {
    resetRuntimeEnv();
    process.env.BINANCE_API_KEY = 'env-binance-key';

    vi.doMock('../src/config/database', () => ({ prisma: createPrismaMock(null) }));

    const { resolveRuntimeExchangeCredentials } = await import(
      '../src/domains/exchange-connections/user-exchange-credentials.service'
    );

    await expect(resolveRuntimeExchangeCredentials('user-1', 'binance')).rejects.toMatchObject({
      name: 'ExchangeAuthError',
      message: expect.stringContaining('BINANCE_SECRET_KEY'),
    });
  });
});

describe('trading service credential wiring', () => {
  it('passes formal env credentials into private trading providers when no stored connection exists', async () => {
    resetRuntimeEnv();
    process.env.UPBIT_ACCESS_KEY = 'env-upbit-key';
    process.env.UPBIT_SECRET_KEY = 'env-upbit-secret';

    const prisma = createPrismaMock(null);
    const orderChanceSpy = vi.fn(async (_symbol: string, context: any) => ({
      exchange: 'upbit',
      market: 'BTC/KRW',
      symbol: 'BTC',
      quoteCurrency: 'KRW',
      minTotal: 5000,
      supportedOrderTypes: ['limit', 'market'],
      credentialsEcho: context.credentials,
    }));

    vi.doMock('../src/config/database', () => ({ prisma }));
    vi.doMock('../src/modules/private-account/exchange-connections.service', () => ({
      markExchangeConnectionSync: vi.fn(async () => undefined),
    }));
    vi.doMock('../src/core/exchange/registry.bootstrap', () => ({
      exchangeProviderRegistry: {
        getTradingProvider: () => ({
          exchange: 'upbit',
          metadata: { displayName: '업비트' },
          supports: () => true,
          getOrderChance: orderChanceSpy,
        }),
      },
    }));

    const { getOrderChance } = await import('../src/domains/trading/trading.service');
    const response = await getOrderChance('user-1', 'upbit', 'BTC');

    expect(orderChanceSpy).toHaveBeenCalledTimes(1);
    expect(orderChanceSpy.mock.calls[0]?.[1]?.credentials).toMatchObject({
      exchange: 'upbit',
      apiKey: 'env-upbit-key',
      secretKey: 'env-upbit-secret',
    });
    expect(response).toMatchObject({
      exchange: 'upbit',
      market: 'BTC/KRW',
      symbol: 'BTC',
    });
  });

  it('maps missing private credentials to a clear 400-level application error', async () => {
    resetRuntimeEnv();

    vi.doMock('../src/config/database', () => ({ prisma: createPrismaMock(null) }));
    vi.doMock('../src/modules/private-account/exchange-connections.service', () => ({
      markExchangeConnectionSync: vi.fn(async () => undefined),
    }));
    vi.doMock('../src/core/exchange/registry.bootstrap', () => ({
      exchangeProviderRegistry: {
        getTradingProvider: () => ({
          exchange: 'upbit',
          metadata: { displayName: '업비트' },
          supports: () => true,
          getOrderChance: vi.fn(async () => {
            throw new Error('should not be reached');
          }),
        }),
      },
    }));

    const { getOrderChance } = await import('../src/domains/trading/trading.service');

    await expect(getOrderChance('user-1', 'upbit', 'BTC')).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('UPBIT_ACCESS_KEY'),
    });
  });
});
