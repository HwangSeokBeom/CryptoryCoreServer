import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
  APP_STORE_REVIEW_MODE: 'true',
  EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: 'test-exchange-credential-encryption-key-32',
};

vi.mock('../src/domains/coins/coin-info.service', () => ({
  getCoinInfo: vi.fn(async (symbol: string) => ({
    symbol,
    displaySymbol: `${symbol}/KRW`,
    name: null,
    logoUrl: null,
    provider: null,
    providerId: null,
    description: null,
    homepageUrl: null,
    explorerUrl: null,
    market: {
      price: null,
      priceCurrency: 'KRW',
      priceChangePercent24h: null,
      high24h: null,
      low24h: null,
      volume24h: null,
      tradeValue24h: null,
      marketCap: null,
      marketCapRank: null,
      circulatingSupply: null,
      totalSupply: null,
      maxSupply: null,
      ath: null,
      atl: null,
      asOf: '2026-04-30T00:00:00.000Z',
    },
    source: { metadata: null, market: null, fallbackUsed: true },
  })),
}));

vi.mock('../src/domains/coins/coin-analysis.service', () => ({
  ANALYSIS_TIMEFRAMES: ['1m', '5m', '15m', '30m', '1h', '2h'],
  getCoinAnalysis: vi.fn(async (symbol: string, timeframe: string) => ({
    symbol,
    timeframe,
    summary: {
      status: 'neutral',
      label: '중립',
      score: 0,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 1,
    },
    indicators: [
      {
        key: 'recent_price_change',
        label: '최근 가격 변화',
        state: 'neutral',
        valueText: '데이터 부족',
        description: '최근 캔들 데이터가 부족합니다.',
      },
    ],
    source: { type: 'server_analysis', fallbackUsed: true },
    asOf: '2026-04-30T00:00:00.000Z',
  })),
}));

vi.mock('../src/domains/market-data/market-trends.service', () => ({
  getMarketTrends: vi.fn(async () => ({
    summary: {
      totalMarketCap: null,
      volume24h: null,
      btcDominance: null,
      ethDominance: null,
      fearGreedIndex: null,
      altcoinIndex: null,
    },
    movers: { topGainers: [], topLosers: [], topVolume: [] },
    series: { marketCap: [], volume: [] },
    latestHeadline: null,
    marketPoll: { bullishCount: 0, bearishCount: 0, participantCount: 0, myVote: null },
    source: { primary: 'market_snapshot', fallbackUsed: true },
    asOf: '2026-04-30T00:00:00.000Z',
  })),
}));

vi.mock('../src/domains/market-data/market-themes.service', () => ({
  getMarketThemes: vi.fn(async () => ({
    items: [
      {
        id: 'layer1',
        name: 'Layer 1',
        change24h: null,
        marketCap: null,
        symbols: ['BTC', 'ETH', 'SOL'],
      },
    ],
    updatedAt: '2026-04-30T00:00:00.000Z',
  })),
}));

async function createAppWithToken() {
  process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
  return { app, token };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
});

describe('Informational App Store routes', () => {
  it('serves the redesigned client route paths without 404', async () => {
    const { app } = await createAppWithToken();

    const news = await app.inject({ method: 'GET', url: '/news?limit=40' });
    expect(news.statusCode).toBe(200);
    const newsBody = JSON.parse(news.body);
    expect(Array.isArray(newsBody.data.items)).toBe(true);
    expect(newsBody.data.nextCursor).toBeNull();

    const community = await app.inject({
      method: 'GET',
      url: '/coins/NEWT/community?sort=latest&filter=all&limit=30',
    });
    expect(community.statusCode).toBe(200);
    const communityBody = JSON.parse(community.body);
    expect(communityBody.data).toMatchObject({
      symbol: 'NEWT',
      vote: { bullishCount: 0, bearishCount: 0, participantCount: 0, myVote: null },
      items: [],
      nextCursor: null,
    });

    const legacyNews = await app.inject({ method: 'GET', url: '/api/v1/news?limit=40' });
    expect(legacyNews.statusCode).toBe(200);
    const legacyCoin = await app.inject({ method: 'GET', url: '/api/v1/coins/DRIFT/info' });
    expect(legacyCoin.statusCode).toBe(200);
    const legacyAnalysis = await app.inject({ method: 'GET', url: '/api/v1/coins/DRIFT/analysis?timeframe=1h' });
    expect(legacyAnalysis.statusCode).toBe(200);
    const legacyCommunity = await app.inject({ method: 'GET', url: '/api/v1/coins/DRIFT/community' });
    expect(legacyCommunity.statusCode).toBe(200);
    const legacyMarket = await app.inject({ method: 'GET', url: '/api/v1/market/trends' });
    expect(legacyMarket.statusCode).toBe(200);
    const legacyThemes = await app.inject({ method: 'GET', url: '/api/v1/market/themes' });
    expect(legacyThemes.statusCode).toBe(200);

    await app.close();
  }, 20000);

  it('serves news, coin info, analysis, community, and trends in App Store mode', async () => {
    const { app } = await createAppWithToken();

    const news = await app.inject({ method: 'GET', url: '/news?symbol=BTC&category=market&date=2026-04-30' });
    expect(news.statusCode).toBe(200);
    const newsBody = JSON.parse(news.body);
    expect(newsBody.data.items[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      source: expect.any(String),
      relatedSymbols: ['BTC'],
      isImportant: true,
    });
    expect(newsBody.data.nextCursor).toBeNull();

    const driftNews = await app.inject({ method: 'GET', url: '/news?symbol=DRIFT' });
    expect(driftNews.statusCode).toBe(200);
    expect(JSON.parse(driftNews.body).data).toMatchObject({ items: [], nextCursor: null });

    const coinInfo = await app.inject({ method: 'GET', url: '/coins/DRIFT/info' });
    expect(coinInfo.statusCode).toBe(200);
    const coinInfoBody = JSON.parse(coinInfo.body);
    expect(coinInfoBody.data.symbol).toBe('DRIFT');
    expect(coinInfoBody.data.displaySymbol).toBe('DRIFT/KRW');
    expect(coinInfoBody.data.logoUrl).toBeNull();
    expect(coinInfoBody.data.market.marketCap).toBeNull();
    expect(coinInfoBody.data.relatedSymbols).toBeUndefined();

    const unknownCoinInfo = await app.inject({ method: 'GET', url: '/coins/UNKNOWN/info' });
    expect(unknownCoinInfo.statusCode).toBe(200);
    expect(JSON.parse(unknownCoinInfo.body).data.symbol).toBe('UNKNOWN');

    const orcaPairInfo = await app.inject({ method: 'GET', url: '/coins/ORCA%2FKRW/info' });
    expect(orcaPairInfo.statusCode).toBe(200);
    expect(JSON.parse(orcaPairInfo.body).data.symbol).toBe('ORCA');

    const invalidCoinInfo = await app.inject({ method: 'GET', url: '/coins/%20/info' });
    expect(invalidCoinInfo.statusCode).toBe(400);
    expect(JSON.parse(invalidCoinInfo.body).code).toBe('INVALID_SYMBOL');

    const analysis = await app.inject({ method: 'GET', url: '/coins/BTC/analysis?timeframe=1h' });
    expect(analysis.statusCode).toBe(200);
    const analysisBody = JSON.parse(analysis.body);
    expect(analysisBody.data.summary.status).toBe('neutral');
    expect(['bearish', 'neutral', 'bullish']).toContain(analysisBody.data.indicators[0].state);
    expect(analysisBody.data.indicators[0]).toMatchObject({
      label: '최근 가격 변화',
      valueText: '데이터 부족',
      description: expect.any(String),
    });
    expect(JSON.stringify(analysisBody).toLowerCase()).not.toMatch(/\b(buy|sell|strong buy|strong sell|recommend|investment advice)\b|매수|매도|추천|투자\s*조언/);

    const community = await app.inject({ method: 'GET', url: '/coins/BTC/community?sort=latest&filter=all' });
    expect(community.statusCode).toBe(200);
    const communityBody = JSON.parse(community.body);
    expect(communityBody.data.items).toEqual([]);
    expect(communityBody.data.nextCursor).toBeNull();
    expect(communityBody.data.vote).toMatchObject({ bullishCount: 0, bearishCount: 0, participantCount: 0, myVote: null });
    expect(JSON.stringify(communityBody).toLowerCase()).not.toMatch(/\b(order|transfer|withdraw|deposit|wallet)\b/);

    const trends = await app.inject({ method: 'GET', url: '/market/trends' });
    expect(trends.statusCode).toBe(200);
    const trendsBody = JSON.parse(trends.body);
    expect(trendsBody.data).toMatchObject({
      summary: {
        totalMarketCap: null,
        volume24h: null,
        btcDominance: null,
        ethDominance: null,
        fearGreedIndex: null,
        altcoinIndex: null,
      },
      movers: { topGainers: [], topLosers: [], topVolume: [] },
      series: { marketCap: [], volume: [] },
      latestHeadline: null,
      source: { primary: 'market_snapshot', fallbackUsed: true },
      asOf: '2026-04-30T00:00:00.000Z',
    });

    const themes = await app.inject({ method: 'GET', url: '/market/themes' });
    expect(themes.statusCode).toBe(200);
    const themesBody = JSON.parse(themes.body);
    expect(themesBody.data.items[0]).toMatchObject({
      id: 'layer1',
      name: 'Layer 1',
      change24h: null,
      marketCap: null,
      symbols: ['BTC', 'ETH', 'SOL'],
    });
    expect(themesBody.data.updatedAt).toBe('2026-04-30T00:00:00.000Z');

    await app.close();
  }, 20000);

  it('validates community content and records votes behind auth', async () => {
    const { app, token } = await createAppWithToken();

    const unauthenticatedPost = await app.inject({
      method: 'POST',
      url: '/coins/BTC/community',
      payload: { content: 'BTC network activity looks active today.' },
    });
    expect(unauthenticatedPost.statusCode).toBe(401);

    const emptyPost = await app.inject({
      method: 'POST',
      url: '/coins/BTC/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: '   ' },
    });
    expect(emptyPost.statusCode).toBe(400);
    expect(JSON.parse(emptyPost.body).code).toBe('INVALID_COMMUNITY_CONTENT');

    const created = await app.inject({
      method: 'POST',
      url: '/coins/BTC/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'BTC network activity looks active today.' },
    });
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body).data).toMatchObject({
      id: expect.any(String),
      createdAt: expect.any(String),
    });

    const vote = await app.inject({
      method: 'POST',
      url: '/coins/BTC/votes',
      headers: { authorization: `Bearer ${token}` },
      payload: { direction: 'bullish' },
    });
    expect(vote.statusCode).toBe(200);
    expect(JSON.parse(vote.body).data).toMatchObject({
      symbol: 'BTC',
      vote: {
        bullishCount: 1,
        bearishCount: 0,
        participantCount: 1,
        myVote: 'bullish',
      },
    });

    await app.close();
  }, 20000);
});
