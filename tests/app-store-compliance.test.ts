import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateFeatureFlags } from '../src/config/feature-flags';

const ORIGINAL_ENV = { ...process.env };
const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
  EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: 'test-exchange-credential-encryption-key-32',
};

function setAppStoreEnv(overrides: Record<string, string> = {}) {
  process.env = {
    ...ORIGINAL_ENV,
    ...BASE_ENV,
    APP_STORE_REVIEW_MODE: 'true',
    FEATURE_TRADING_ENABLED: 'true',
    FEATURE_ORDER_ENABLED: 'true',
    FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED: 'true',
    ...overrides,
  };
}

async function createAppWithToken() {
  vi.resetModules();
  vi.doMock('../src/domains/portfolio/portfolio.service', () => ({
    getPortfolioSnapshotRouteResponse: vi.fn(async () => ({
      data: {
        exchange: 'upbit',
        balances: [{ asset: 'BTC', free: 0.01, locked: 0, averageBuyPrice: 95000000 }],
        positions: [],
        totalAsset: 0.01,
        totalAssetValue: 1000000,
        totalPnlValue: 50000,
        totalPnlPercent: 5,
        timestamp: 1712345678000,
      },
      routeStatus: 'ok',
      privateStreamingStatus: 'live_stream_unavailable_polling_active',
      pollingFallbackRecommended: true,
    })),
    getAggregatedPortfolioSummary: vi.fn(async () => ({
      requestedExchanges: ['upbit'],
      connectedExchanges: ['upbit'],
      partialSuccess: false,
      failures: [],
      totals: {
        estimatedTotalAssetValueKrw: 1000000,
        estimatedTotalPnlValueKrw: 50000,
        estimatedTotalPnlPercent: 5,
      },
      exchangeGroups: [],
      assets: [
        {
          exchange: 'upbit',
          exchangeName: '업비트',
          quoteCurrency: 'KRW',
          asset: 'BTC',
          quantity: 0.01,
          availableQuantity: 0.01,
          lockedQuantity: 0,
          averageBuyPrice: 95000000,
          averageBuyPriceKrw: 95000000,
          currentPrice: 100000000,
          currentPriceKrw: 100000000,
          marketValue: 1000000,
          marketValueKrw: 1000000,
          pnlValue: 50000,
          pnlValueKrw: 50000,
          pnlPercent: 5,
          isCashAsset: false,
          timestamp: 1712345678000,
        },
      ],
      generatedAt: '2026-04-30T00:00:00.000Z',
    })),
    getAssetHistoryRouteResponse: vi.fn(async () => ({ data: [] })),
  }));

  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
  return { app, token };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.clearAllMocks();
});

describe('App Store compliance feature flags', () => {
  it('forces transactional features off in App Store mode even when env enables them', () => {
    const flags = calculateFeatureFlags({
      APP_STORE_REVIEW_MODE: 'true',
      FEATURE_TRADING_ENABLED: 'true',
      FEATURE_ORDER_ENABLED: 'true',
      FEATURE_TRANSFER_ENABLED: 'true',
      FEATURE_DEPOSIT_WITHDRAW_ENABLED: 'true',
      FEATURE_WALLET_ENABLED: 'true',
      FEATURE_PRIVATE_EXCHANGE_TRADING_API_ENABLED: 'true',
    });

    expect(flags.isMarketEnabled).toBe(true);
    expect(flags.isChartEnabled).toBe(true);
    expect(flags.isNewsEnabled).toBe(true);
    expect(flags.isReadOnlyPortfolioEnabled).toBe(true);
    expect(flags.isKimchiPremiumEnabled).toBe(true);
    expect(flags.isCommunityContentEnabled).toBe(true);
    expect(flags.isCoinInfoEnabled).toBe(true);
    expect(flags.isMarketTrendsEnabled).toBe(true);
    expect(flags.isMarketThemesEnabled).toBe(true);
    expect(flags.isAnalysisReferenceDataEnabled).toBe(true);
    expect(flags.isOrderEnabled).toBe(false);
    expect(flags.isTradingEnabled).toBe(false);
    expect(flags.isTransferEnabled).toBe(false);
    expect(flags.isDepositWithdrawEnabled).toBe(false);
    expect(flags.isWalletEnabled).toBe(false);
    expect(flags.isPrivateExchangeTradingAPIEnabled).toBe(false);
  });
});

describe('App Store compliance middleware', () => {
  async function expectBlocked(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) {
    setAppStoreEnv();
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'x-app-version': '1.0.0',
        'x-build-channel': 'app-store',
      },
      payload,
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe('FEATURE_DISABLED_FOR_APP_STORE');
    expect(body.error).toBe('Trading, transfer, deposit, and withdrawal features are not available in this app version.');
    await app.close();
  }

  it('blocks order, buy, sell, transfer, withdrawal, deposit, and wallet paths', async () => {
    await expectBlocked('POST', '/trading/orders', {
      exchange: 'upbit',
      symbol: 'BTC',
      side: 'buy',
      type: 'market',
      quantity: 0.01,
    });
    await expectBlocked('POST', '/api/v1/private/orders', {
      symbol: 'BTC',
      exchange: 'upbit',
      side: 'sell',
      type: 'market',
      quantity: 0.01,
    });
    await expectBlocked('GET', '/trading/open-orders?exchange=upbit');
    await expectBlocked('GET', '/transfer');
    await expectBlocked('GET', '/withdraw');
    await expectBlocked('GET', '/deposit');
    await expectBlocked('GET', '/wallet');
    await expectBlocked('POST', '/coins/BTC/orders', { side: 'buy' });
  }, 30000);

  it('keeps read-only portfolio and news available', async () => {
    setAppStoreEnv();
    const { app, token } = await createAppWithToken();

    const portfolio = await app.inject({
      method: 'GET',
      url: '/portfolio/summary?exchange=upbit',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(portfolio.statusCode).toBe(200);
    expect(JSON.parse(portfolio.body).data.totalAssetValue).toBe(1000000);

    const news = await app.inject({ method: 'GET', url: '/news?coin=BTC&category=market&date=2026-04-30' });
    expect(news.statusCode).toBe(200);
    const newsBody = JSON.parse(news.body);
    expect(newsBody.data.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(newsBody).toLowerCase()).not.toMatch(/\b(buy|sell|trade|order|transfer|withdraw|deposit|wallet)\b/);

    const analysis = await app.inject({ method: 'GET', url: '/coins/ORCA%2FKRW/analysis?timeframe=1h' });
    expect(analysis.statusCode).toBe(200);
    expect(JSON.parse(analysis.body).data.symbol).toBe('ORCA');

    const coinInfo = await app.inject({ method: 'GET', url: '/coins/ORCA/info' });
    expect(coinInfo.statusCode).toBe(200);
    expect(JSON.parse(coinInfo.body).data.symbol).toBe('ORCA');

    const aliasCoinInfo = await app.inject({ method: 'GET', url: '/api/v1/coins/ORCA/info' });
    expect(aliasCoinInfo.statusCode).toBe(200);
    expect(JSON.parse(aliasCoinInfo.body).data.symbol).toBe('ORCA');

    const aliasAnalysis = await app.inject({ method: 'GET', url: '/api/v1/coins/ORCA/analysis?timeframe=1h' });
    expect(aliasAnalysis.statusCode).toBe(200);
    expect(JSON.parse(aliasAnalysis.body).data.symbol).toBe('ORCA');

    const community = await app.inject({ method: 'GET', url: '/api/v1/coins/KRW-ORCA/community' });
    expect(community.statusCode).toBe(200);
    expect(JSON.parse(community.body).data).toMatchObject({
      symbol: 'ORCA',
      items: [],
      nextCursor: null,
    });

    const unauthenticatedVote = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/votes',
      payload: { direction: 'bullish' },
    });
    expect(unauthenticatedVote.statusCode).toBe(401);
    expect(JSON.parse(unauthenticatedVote.body).code).toBe('ACCESS_TOKEN_REQUIRED');

    const aliasUnauthenticatedVote = await app.inject({
      method: 'POST',
      url: '/api/v1/coins/ORCA/votes',
      payload: { direction: 'bullish' },
    });
    expect(aliasUnauthenticatedVote.statusCode).toBe(401);
    expect(JSON.parse(aliasUnauthenticatedVote.body).code).toBe('ACCESS_TOKEN_REQUIRED');

    const trends = await app.inject({ method: 'GET', url: '/api/v1/market/trends' });
    expect(trends.statusCode).toBe(200);
    expect(JSON.parse(trends.body).data).toMatchObject({
      range: '7d',
      currency: 'KRW',
      availability: {
        totalMarketCap: expect.any(Boolean),
        totalVolume: expect.any(Boolean),
        btcDominance: expect.any(Boolean),
        ethDominance: expect.any(Boolean),
        fearGreedIndex: false,
      },
      unavailableReasons: {
        fearGreedIndex: 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE',
      },
      points: expect.any(Array),
    });

    const themes = await app.inject({ method: 'GET', url: '/api/v1/market/themes' });
    expect(themes.statusCode).toBe(200);
    await app.close();
  }, 30000);
});

describe('Read-only exchange connection enforcement', () => {
  it('rejects trading-enabled API keys before registration in App Store mode', async () => {
    setAppStoreEnv();
    vi.resetModules();
    const { createExchangeConnection: createConnection } = await import('../src/modules/private-account/exchange-connections.service');

    await expect(createConnection('user-1', {
      exchange: 'upbit',
      apiKey: 'sample-api-key',
      secretKey: 'sample-secret-key',
      permission: 'trade_enabled',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'EXCHANGE_API_KEY_PERMISSION_NOT_ALLOWED',
    });
  });
});
