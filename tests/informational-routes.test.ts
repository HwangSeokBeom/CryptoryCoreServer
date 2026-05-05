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
      priceChangePercent7d: null,
      priceChangePercent14d: null,
      priceChangePercent30d: null,
      priceChangePercent60d: null,
      priceChangePercent200d: null,
      priceChangePercent1y: null,
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
  startMarketSnapshotCollector: vi.fn(),
  getMarketTrends: vi.fn(async () => ({
    summary: {
      totalMarketCap: null,
      volume24h: null,
      btcDominance: null,
      ethDominance: null,
      fearGreedIndex: null,
      altcoinIndex: null,
      marketMoodLabel: null,
      marketMoodDescription: null,
    },
    movers: { topGainers: [], topLosers: [], topVolume: [] },
    series: { marketCap: [], volume: [] },
    latestHeadline: null,
    insights: [],
    events: [],
    dataQuality: {
      summaryAvailable: false,
      moversAvailable: false,
      seriesAvailable: false,
      fallbackUsed: true,
      asOf: '2026-04-30T00:00:00.000Z',
    },
    marketPoll: { bullishCount: 0, bearishCount: 0, participantCount: 0, myVote: null },
    source: { primary: 'market_snapshot', fallbackUsed: true },
    asOf: '2026-04-30T00:00:00.000Z',
  })),
  getMarketTrendSeries: vi.fn(async () => ({
    range: '7d',
    currency: 'KRW',
    source: 'market_snapshot',
    updatedAt: '2026-04-30T00:00:00.000Z',
    availability: {
      totalMarketCap: false,
      totalVolume: false,
      btcDominance: false,
      ethDominance: false,
      fearGreedIndex: false,
    },
    unavailableReasons: {
      totalMarketCap: 'GLOBAL_MARKET_CAP_SERIES_UNAVAILABLE',
      totalVolume: 'GLOBAL_VOLUME_SERIES_UNAVAILABLE',
      btcDominance: 'BTC_DOMINANCE_SERIES_UNAVAILABLE',
      ethDominance: 'ETH_DOMINANCE_SERIES_UNAVAILABLE',
      fearGreedIndex: 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE',
    },
    dataState: {
      emptyReason: 'NO_MARKET_SNAPSHOTS_AVAILABLE',
    },
    emptyState: {
      isEmpty: true,
      reason: 'MARKET_TREND_SNAPSHOT_NOT_READY',
    },
    points: [],
  })),
  getMarketDashboard: vi.fn(async () => ({
    scope: 'market',
    currency: 'KRW',
    source: 'coingecko',
    updatedAt: '2026-04-30T00:00:00.000Z',
    isStale: false,
    metrics: {
      totalMarketCap: { value: 2680000000000, formatted: '2.68조', currency: 'KRW', source: 'coingecko', updatedAt: '2026-04-30T00:00:00.000Z', available: true },
      totalVolume24h: { value: 83225000000, formatted: '832.25억', currency: 'KRW', source: 'coingecko', updatedAt: '2026-04-30T00:00:00.000Z', available: true },
      btcDominance: { value: 58.47, unit: 'percent', available: true },
      ethDominance: { value: 10.37, unit: 'percent', available: true },
      fearGreedIndex: {
        value: 26,
        unit: 'index',
        label: 'fear',
        labelKo: '공포',
        scale: { min: 0, max: 100 },
        thresholds: [],
        available: true,
        source: 'alternative.me',
      },
      altcoinIndex: { value: null, available: false, reason: 'ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED' },
    },
    availability: {
      totalMarketCap: true,
      totalVolume24h: true,
      btcDominance: true,
      ethDominance: true,
      fearGreedIndex: true,
      altcoinIndex: false,
    },
  })),
  getNewsOverview: vi.fn(async () => ({
    scope: 'market',
    updatedAt: '2026-04-30T00:00:00.000Z',
    source: 'coingecko',
    summary: {
      title: '오늘 시장 요약',
      headline: '현재 시장 심리는 공포 구간입니다.',
      description: 'BTC 도미넌스는 58.47%, 24시간 거래량은 832.25억 KRW입니다.',
      headlineKo: '현재 시장 심리는 공포 구간입니다.',
      descriptionKo: 'BTC 도미넌스는 58.47%, 24시간 거래량은 832.25억 KRW입니다.',
      tone: 'fear',
      available: true,
      reason: null,
    },
    mood: {
      score: 26,
      label: 'fear',
      labelKo: '공포',
      scale: { min: 0, max: 100 },
      thresholds: [],
      source: 'alternative.me',
      available: true,
      reason: null,
      updatedAt: '2026-04-30T00:00:00.000Z',
    },
    marketSentiment: {
      scope: 'market',
      date: '2026-04-30',
      totalParticipants: 0,
      bullishCount: 0,
      bearishCount: 0,
      bullishRatio: 0,
      bearishRatio: 0,
      ratioScale: 'percent',
      myVote: null,
      updatedAt: '2026-04-30T00:00:00.000Z',
    },
    topNews: [
      {
        id: 'news_id',
        title: '뉴스 제목',
        titleKo: '뉴스 제목',
        source: 'Cryptory Research',
        provider: 'cryptory_research',
        publishedAt: '2026-04-30T01:00:00.000Z',
        url: 'https://cryptory.example/news/news_id',
        imageUrl: null,
        summary: '요약',
        summaryKo: '요약',
        tags: ['BTC'],
        symbols: ['BTC'],
      },
    ],
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
    expect(newsBody.data.sourceStatus).toMatchObject({
      externalConfigured: expect.any(Boolean),
      externalAvailable: expect.any(Boolean),
      fallbackUsed: expect.any(Boolean),
    });
    expect(newsBody.data.pagination).toMatchObject({
      hasMore: expect.any(Boolean),
    });
    expect(newsBody.data.nextCursor === null || typeof newsBody.data.nextCursor === 'string').toBe(true);

    const community = await app.inject({
      method: 'GET',
      url: '/coins/ORCA/community?sort=latest&filter=all&limit=30',
    });
    expect(community.statusCode).toBe(200);
    const communityBody = JSON.parse(community.body);
    expect(communityBody.data).toMatchObject({
      symbol: 'ORCA',
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
      provider: expect.any(String),
      relatedSymbols: expect.arrayContaining(['BTC']),
      isImportant: expect.any(Boolean),
    });
    expect(newsBody.data.sourceStatus).toBeDefined();
    expect(newsBody.data.nextCursor === null || typeof newsBody.data.nextCursor === 'string').toBe(true);

    const driftNews = await app.inject({ method: 'GET', url: '/news?symbol=DRIFT' });
    expect(driftNews.statusCode).toBe(200);
    const driftNewsBody = JSON.parse(driftNews.body);
    expect(driftNewsBody.data).toMatchObject({
      items: expect.any(Array),
      relatedItems: expect.any(Array),
      nextCursor: null,
      sourceStatus: expect.any(Object),
      emptyState: expect.any(Object),
    });
    if (driftNewsBody.data.items.length === 0) {
      expect(driftNewsBody.data.emptyState.reason).toEqual(expect.any(String));
    }

    const coinInfo = await app.inject({ method: 'GET', url: '/coins/DRIFT/info' });
    expect(coinInfo.statusCode).toBe(200);
    const coinInfoBody = JSON.parse(coinInfo.body);
    expect(coinInfoBody.data.symbol).toBe('DRIFT');
    expect(coinInfoBody.data.displaySymbol).toBe('DRIFT/KRW');
    expect(coinInfoBody.data.logoUrl).toBeNull();
    expect(coinInfoBody.data.market.marketCap).toBeNull();
    expect(coinInfoBody.data.market).toMatchObject({
      priceChangePercent24h: null,
      priceChangePercent7d: null,
      priceChangePercent14d: null,
      priceChangePercent30d: null,
      priceChangePercent60d: null,
      priceChangePercent200d: null,
      priceChangePercent1y: null,
    });
    expect(coinInfoBody.data.relatedSymbols).toBeUndefined();

    const unknownCoinInfo = await app.inject({ method: 'GET', url: '/coins/UNKNOWN/info' });
    expect(unknownCoinInfo.statusCode).toBe(200);
    expect(JSON.parse(unknownCoinInfo.body).data.symbol).toBe('UNKNOWN');

    const orcaPairInfo = await app.inject({ method: 'GET', url: '/coins/ORCA%2FKRW/info' });
    expect(orcaPairInfo.statusCode).toBe(200);
    expect(JSON.parse(orcaPairInfo.body).data.symbol).toBe('ORCA');

    const orcaUpbitInfo = await app.inject({ method: 'GET', url: '/coins/KRW-ORCA/info' });
    expect(orcaUpbitInfo.statusCode).toBe(200);
    expect(JSON.parse(orcaUpbitInfo.body).data.symbol).toBe('ORCA');

    const orcaLowercaseInfo = await app.inject({ method: 'GET', url: '/coins/orca/info' });
    expect(orcaLowercaseInfo.statusCode).toBe(200);
    expect(JSON.parse(orcaLowercaseInfo.body).data.symbol).toBe('ORCA');

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
      range: '7d',
      currency: 'KRW',
      source: 'market_snapshot',
      availability: {
        totalMarketCap: false,
        totalVolume: false,
        btcDominance: false,
        ethDominance: false,
        fearGreedIndex: false,
      },
      unavailableReasons: {
        fearGreedIndex: 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE',
      },
      dataState: { emptyReason: 'NO_MARKET_SNAPSHOTS_AVAILABLE' },
      points: [],
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
    expect(JSON.parse(unauthenticatedPost.body)).toMatchObject({
      success: false,
      error: '인증이 필요합니다',
      code: 'ACCESS_TOKEN_REQUIRED',
    });

    const invalidPost = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: 'Bearer invalid-token' },
      payload: { content: 'ORCA liquidity metrics are active today.' },
    });
    expect(invalidPost.statusCode).toBe(401);
    expect(JSON.parse(invalidPost.body)).toMatchObject({
      success: false,
      error: '인증이 필요합니다',
      code: 'ACCESS_TOKEN_INVALID',
    });

    const expiredToken = app.jwt.sign({
      id: 'user-1',
      email: 'user@example.com',
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    const expiredPost = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${expiredToken}` },
      payload: { content: 'ORCA liquidity metrics are active today.' },
    });
    expect(expiredPost.statusCode).toBe(401);
    expect(JSON.parse(expiredPost.body)).toMatchObject({
      success: false,
      code: 'ACCESS_TOKEN_EXPIRED',
    });

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
      item: {
        id: expect.any(String),
        symbol: 'BTC',
        content: 'BTC network activity looks active today.',
        author: {
          id: 'user-1',
          nickname: null,
          displayName: 'us***@example.com',
          emailMasked: 'us***@example.com',
          isPrivateRelay: false,
          followable: true,
          isMe: true,
        },
        createdAt: expect.any(String),
      },
    });

    const unauthenticatedVote = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/votes',
      payload: { direction: 'bullish' },
    });
    expect(unauthenticatedVote.statusCode).toBe(401);
    expect(JSON.parse(unauthenticatedVote.body)).toMatchObject({
      success: false,
      error: '인증이 필요합니다',
      code: 'ACCESS_TOKEN_REQUIRED',
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
