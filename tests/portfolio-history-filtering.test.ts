import { beforeEach, describe, expect, it, vi } from 'vitest';

const portfolioProvider = {
  exchange: 'upbit',
  metadata: { displayName: '업비트', quoteCurrency: 'KRW' },
  supports: vi.fn(() => true),
  getPortfolioSnapshot: vi.fn(),
  getAssetHistory: vi.fn(),
};

const getPortfolioProvider = vi.fn(() => portfolioProvider);
const requireUserOwnedExchangeCredentials = vi.fn(async () => ({
  exchange: 'upbit',
  apiKey: 'key',
  secretKey: 'secret',
}));
const getUserExchangeConnectionRecord = vi.fn(async () => ({
  canUsePrivateApi: true,
}));
const listUserVerifiedExchangeConnections = vi.fn(async () => []);
const markExchangeConnectionSync = vi.fn(async () => undefined);

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getPortfolioProvider,
    getFxRateProvider: vi.fn(() => ({
      getUsdKrwRate: vi.fn(async () => ({ rate: 1400 })),
    })),
  },
}));

vi.mock('../src/domains/exchange-connections/user-exchange-credentials.service', () => ({
  requireUserOwnedExchangeCredentials,
  getUserExchangeConnectionRecord,
  listUserVerifiedExchangeConnections,
}));

vi.mock('../src/modules/private-account/exchange-connections.service', () => ({
  markExchangeConnectionSync,
}));

describe('portfolio history filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    portfolioProvider.getAssetHistory.mockResolvedValue([
      {
        id: 'fill-1',
        exchange: 'upbit',
        assetSymbol: 'BTC',
        symbol: 'BTC',
        eventType: 'trade',
        type: 'trade',
        amount: 0.01,
        price: 100000000,
        occurredAt: '2024-04-05T19:34:38.000Z',
        timestamp: 1712345678000,
        source: 'exchange_private_api',
        sourceType: 'fill',
        isSynthetic: false,
        isVerifiedUserEvent: true,
      },
      {
        id: 'mock-1',
        exchange: 'upbit',
        assetSymbol: 'BTC',
        symbol: 'BTC',
        eventType: 'trade',
        type: 'trade',
        amount: 0.02,
        price: 99999999,
        timestamp: 1712345677000,
        sourceType: 'mock',
        isSynthetic: false,
        isVerifiedUserEvent: false,
      },
      {
        id: 'synthetic-1',
        exchange: 'upbit',
        assetSymbol: 'BTC',
        symbol: 'BTC',
        eventType: 'trade',
        type: 'trade',
        amount: 0.03,
        price: 99999998,
        timestamp: 1712345676000,
        sourceType: 'synthetic_snapshot',
        isSynthetic: true,
        isVerifiedUserEvent: false,
      },
      {
        id: 'invalid-1',
        exchange: 'upbit',
        assetSymbol: 'BTC',
        symbol: 'BTC',
        eventType: 'trade',
        type: 'trade',
        amount: 0,
        price: 99999997,
        timestamp: 0,
        sourceType: 'fill',
        isSynthetic: false,
        isVerifiedUserEvent: true,
      },
    ]);
  });

  it('returns only verified non-synthetic user events', async () => {
    const { getAssetHistoryRouteResponse } = await import('../src/domains/portfolio/portfolio.service');

    const response = await getAssetHistoryRouteResponse('user-1', 'upbit');

    expect(response.routeStatus).toBe('ok');
    expect(response.data).toHaveLength(1);
    expect(response.data[0]).toMatchObject({
      id: 'fill-1',
      exchange: 'upbit',
      assetSymbol: 'BTC',
      symbol: 'BTC',
      eventType: 'trade',
      type: 'trade',
      amount: 0.01,
      price: 100000000,
      source: 'exchange_private_api',
      sourceType: 'fill',
      isSynthetic: false,
      isVerifiedUserEvent: true,
    });
  });
});
