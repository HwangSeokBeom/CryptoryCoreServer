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

async function createApp(extraEnv: Record<string, string> = {}) {
  process.env = { ...ORIGINAL_ENV, ...BASE_ENV, ...extraEnv };
  vi.resetModules();
  const restCalls: Array<{ path: string; options?: { query?: Record<string, unknown>; headers?: Record<string, unknown> } }> = [];
  vi.doMock('../src/config/database', () => ({
    prisma: {
      coin: {
        findUnique: vi.fn(async () => null),
      },
    },
  }));
  vi.doMock('../src/domains/market-data/market-data.service', () => ({
    getReferenceTicker: vi.fn(async () => ({
      price: 2400,
      volume24h: 1200000000,
      change24h: 1.2,
      high24h: 2500,
      low24h: 2300,
      timestamp: '2026-05-02T13:22:00.000Z',
    })),
  }));
  vi.doMock('../src/core/exchange/rest.client', () => ({
    RestClient: class {
      request = vi.fn(async (path: string, options?: { query?: Record<string, unknown>; headers?: Record<string, unknown> }) => {
        const previousCallsForPath = restCalls.filter((call) => call.path === path).length;
        restCalls.push({ path, options });
        if (path === '/news') {
          if (extraEnv.NEWS_TEST_ALWAYS_FAIL === 'true') {
            throw new Error('rate limit exceeded');
          }
          if (extraEnv.NEWS_TEST_FAIL_AFTER_SUCCESS === 'true' && previousCallsForPath > 0) {
            throw new Error('simulated news provider outage');
          }
          return {
            articles: [
              {
                id: 'cv-market-1',
                title: 'Bitcoin liquidity improves as crypto market volumes rise',
                summary: 'BTC and ETH market volumes increased across major venues.',
                url: 'https://cryptocurrency.cv/news/cv-market-1',
                source: { name: 'Crypto Vision' },
                publishedAt: '2026-05-02T12:00:00.000Z',
                symbols: ['BTC', 'ETH'],
                category: 'market',
                tags: ['bitcoin', 'markets'],
              },
            ],
          };
        }
        if (path === '/search') {
          if (extraEnv.NEWS_TEST_ALWAYS_FAIL === 'true') {
            throw new Error('rate limit exceeded');
          }
          return {
            articles: [
              {
                id: 'cv-search-btc-1',
                title: 'BTC ETF flows remain in focus',
                summary: 'Bitcoin ETF flows are watched by market participants.',
                url: 'https://cryptocurrency.cv/news/cv-search-btc-1',
                source: 'Crypto Vision',
                publishedAt: '2026-05-02T13:00:00.000Z',
                symbols: ['BTC'],
                category: 'market',
                tags: ['BTC', 'ETF'],
              },
            ],
          };
        }
        if (path === '/chat/completions') {
          return {
            choices: [{ message: { content: '오르카는 솔라나 기반 탈중앙화 거래소입니다.' } }],
          };
        }
        if (path === '/coins/orca') {
          return {
            id: 'orca',
            symbol: 'orca',
            name: 'Orca',
            image: { large: 'https://assets.example/orca.png' },
            description: {
              en: '<p>Orca is a decentralized exchange on Solana.</p>',
              ko: '',
            },
            links: {
              homepage: ['https://www.orca.so'],
              blockchain_site: ['https://solscan.io/token/orca'],
            },
            market_data: {
              current_price: { krw: 2400 },
              total_volume: { krw: 1200000000 },
              market_cap: { krw: 120000000000 },
              market_cap_rank: 250,
              high_24h: { krw: 2500 },
              low_24h: { krw: 2300 },
              price_change_percentage_24h: 1.2,
            },
            last_updated: '2026-05-02T13:22:00.000Z',
          };
        }
        if (path === '/global') {
          return {
            data: {
              total_market_cap: { krw: 2680000000000, usd: 2000000000000 },
              total_volume: { krw: 83225000000, usd: 62000000000 },
              market_cap_percentage: { btc: 58.47, eth: 10.37 },
            },
          };
        }
        if (path === '/fng/') {
          return {
            data: [{ value: '26', value_classification: 'Fear' }],
          };
        }
        throw new Error(`unexpected provider path: ${path}`);
      });
      requestDetailed = vi.fn(async (path: string, options?: unknown) => ({
        data: await this.request(path, options),
        meta: {
          owner: 'coingecko',
          path,
          requestUrl: `https://example.test${path}`,
          statusCode: 200,
          responseSnippet: null,
        },
      }));
    },
  }));
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com' });
  return { app, token, restCalls };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock('../src/core/exchange/rest.client');
  vi.doUnmock('../src/domains/market-data/market-data.service');
  vi.doUnmock('../src/config/database');
});

describe('iOS API contracts', () => {
  it('returns coin info with normalized symbol and stable Korean description contract', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/coins/KRW-ORCA/info' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        scope: 'coin',
        symbol: 'ORCA',
        marketId: 'KRW-ORCA',
        name: 'Orca',
        nameKo: '오르카',
        description: {
          available: true,
          ko: null,
          en: expect.any(String),
          plainTextKo: null,
          plainTextEn: 'Orca is a decentralized exchange on Solana.',
          rawHtml: '<p>Orca is a decentralized exchange on Solana.</p>',
          sourceLanguage: 'en',
          renderLanguage: 'ko',
          translated: false,
          translationProvider: 'unavailable',
          reason: 'TRANSLATION_PROVIDER_NOT_CONFIGURED',
          updatedAt: '2026-05-02T13:22:00.000Z',
        },
        links: {
          homepage: 'https://www.orca.so/',
          whitepaper: null,
          explorer: 'https://solscan.io/token/orca',
        },
        source: 'coingecko',
        updatedAt: '2026-05-02T13:22:00.000Z',
      },
    });
    expect(body.data.description.plainTextEn).not.toContain('<p>');

    const canonical = await app.inject({ method: 'GET', url: '/coins/orca' });
    expect(canonical.statusCode).toBe(200);
    expect(JSON.parse(canonical.body).data.symbol).toBe('ORCA');

    await app.close();
  }, 20000);

  it('returns scoped coin news with pagination and empty state contract', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/coins/ORCA/news?limit=20' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        scope: 'coin',
        symbol: 'ORCA',
        coinName: 'Orca',
        sourceStatus: {
          externalConfigured: true,
          externalAvailable: false,
          fallbackUsed: true,
          reason: 'NEWS_EXTERNAL_UNAVAILABLE',
        },
        items: expect.any(Array),
        relatedItems: expect.any(Array),
        pagination: {
          nextCursor: null,
          hasMore: false,
        },
        emptyState: {
          isEmpty: true,
          reason: 'NO_RELATED_COIN_NEWS',
        },
        updatedAt: expect.any(String),
      },
    });
    expect(body.data.items).toEqual([]);
    expect(body.data.relatedItems).toEqual([]);
    await app.close();
  }, 20000);

  it('returns market news with original-language fields and stable item shape', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/news?limit=2' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        scope: 'market',
        sourceStatus: {
          externalConfigured: true,
          externalAvailable: false,
          fallbackUsed: true,
          reason: 'NEWS_EXTERNAL_UNAVAILABLE',
        },
        items: expect.any(Array),
        pagination: {
          nextCursor: expect.anything(),
          hasMore: expect.any(Boolean),
        },
        emptyState: {
          isEmpty: false,
          reason: null,
        },
        updatedAt: expect.any(String),
      },
    });
    expect(body.data.items[0]).toMatchObject({
      id: expect.any(String),
      scope: 'market',
      symbols: expect.any(Array),
      title: expect.any(String),
      titleKo: null,
      summary: expect.any(String),
      summaryKo: null,
      source: expect.any(String),
      provider: 'cryptory_research',
      publishedAt: expect.any(String),
      imageUrl: null,
      tags: expect.any(Array),
      language: 'en',
      translated: false,
      translationProvider: 'client',
    });

    await app.close();
  }, 20000);

  it('returns stable Community POST and GET envelopes with matching item shape', async () => {
    const { app, token } = await createApp();

    const created = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: '  12313  ' },
    });
    expect(created.statusCode).toBe(201);
    const createdBody = JSON.parse(created.body);
    expect(createdBody).toMatchObject({
      success: true,
      data: {
        item: {
          id: expect.any(String),
          symbol: 'ORCA',
          content: '12313',
          author: {
            id: 'user-1',
            nickname: null,
            displayName: 'us***@example.com',
            emailMasked: 'us***@example.com',
            isPrivateRelay: false,
            avatarUrl: null,
            isFollowing: false,
            followable: true,
            isMe: true,
          },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          likeCount: 0,
          replyCount: 0,
          commentCount: 0,
          isLiked: false,
          myReaction: null,
        },
        summary: {
          itemCount: expect.any(Number),
          participantCount: expect.any(Number),
        },
      },
    });
    expect(createdBody.data.summary.itemCount).toBeGreaterThanOrEqual(1);
    expect(createdBody.data.summary.participantCount).toBeGreaterThanOrEqual(1);

    const listed = await app.inject({ method: 'GET', url: '/coins/ORCA/community' });
    expect(listed.statusCode).toBe(200);
    const listedBody = JSON.parse(listed.body);
    expect(listedBody).toMatchObject({
      success: true,
      data: {
        symbol: 'ORCA',
        items: expect.any(Array),
        pagination: {
          nextCursor: null,
          hasMore: false,
        },
        summary: {
          itemCount: expect.any(Number),
          participantCount: expect.any(Number),
        },
      },
    });
    const getItem = listedBody.data.items.find((item: { id: string }) => item.id === createdBody.data.item.id);
    expect(getItem).toBeTruthy();
    expect(Object.keys(getItem).sort()).toEqual(Object.keys(createdBody.data.item).sort());

    await app.close();
  }, 20000);

  it('supports community like, comments, and author follow state', async () => {
    const { app, token } = await createApp();
    const followerToken = app.jwt.sign({ id: 'user-2', email: 'follower@example.com' });

    const created = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: '좋아요 댓글 팔로우 테스트' },
    });
    const itemId = JSON.parse(created.body).data.item.id;

    const liked = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${itemId}/like`,
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(liked.statusCode).toBe(200);
    expect(JSON.parse(liked.body).data).toMatchObject({
      itemId,
      symbol: 'ORCA',
      isLiked: true,
      likeCount: 1,
    });

    const duplicateLike = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${itemId}/like`,
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(duplicateLike.statusCode).toBe(200);
    expect(JSON.parse(duplicateLike.body).data.likeCount).toBe(1);

    const comment = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${itemId}/comments`,
      headers: { authorization: `Bearer ${followerToken}` },
      payload: { content: '  댓글 내용  ' },
    });
    expect(comment.statusCode).toBe(200);
    expect(JSON.parse(comment.body).data).toMatchObject({
      comment: {
        id: expect.any(String),
        itemId,
        content: '댓글 내용',
        author: {
          id: 'user-2',
          nickname: null,
          displayName: 'fo***@example.com',
          emailMasked: 'fo***@example.com',
          isPrivateRelay: false,
          avatarUrl: null,
          isFollowing: false,
          followable: true,
          isMe: true,
        },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      summary: { commentCount: 1 },
    });

    const emptyComment = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${itemId}/comments`,
      headers: { authorization: `Bearer ${followerToken}` },
      payload: { content: '   ' },
    });
    expect(emptyComment.statusCode).toBe(400);
    expect(JSON.parse(emptyComment.body).code).toBe('INVALID_COMMENT_CONTENT');

    const comments = await app.inject({ method: 'GET', url: `/coins/ORCA/community/${itemId}/comments` });
    expect(comments.statusCode).toBe(200);
    expect(JSON.parse(comments.body).data).toMatchObject({
      symbol: 'ORCA',
      itemId,
      items: expect.any(Array),
      pagination: { nextCursor: null, hasMore: false },
      summary: { commentCount: 1 },
    });

    const selfFollow = await app.inject({
      method: 'POST',
      url: '/users/user-2/follow',
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(selfFollow.statusCode).toBe(400);
    expect(JSON.parse(selfFollow.body).code).toBe('CANNOT_FOLLOW_SELF');

    const follow = await app.inject({
      method: 'POST',
      url: '/users/user-1/follow',
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(follow.statusCode).toBe(200);
    expect(JSON.parse(follow.body).data).toMatchObject({
      targetUserId: 'user-1',
      isFollowing: true,
      followerCount: 1,
    });

    const listed = await app.inject({
      method: 'GET',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${followerToken}` },
    });
    const listedItem = JSON.parse(listed.body).data.items.find((item: { id: string }) => item.id === itemId);
    expect(listedItem).toMatchObject({
      likeCount: 1,
      commentCount: 1,
      isLiked: true,
      myReaction: 'like',
      author: {
        id: 'user-1',
        isFollowing: true,
      },
    });

    const unliked = await app.inject({
      method: 'DELETE',
      url: `/coins/ORCA/community/${itemId}/like`,
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(unliked.statusCode).toBe(200);
    expect(JSON.parse(unliked.body).data).toMatchObject({ isLiked: false, likeCount: 0 });

    const unfollow = await app.inject({
      method: 'DELETE',
      url: '/users/user-1/follow',
      headers: { authorization: `Bearer ${followerToken}` },
    });
    expect(unfollow.statusCode).toBe(200);
    expect(JSON.parse(unfollow.body).data).toMatchObject({ isFollowing: false, followerCount: 0 });

    await app.close();
  }, 20000);

  it('returns full comment DTO immediately and applies latest/oldest comment sorting', async () => {
    const { app, token } = await createApp();

    const post = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'comment sort target' },
    });
    const postId = JSON.parse(post.body).data.item.id;

    const first = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'first comment' },
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'second comment' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const firstComment = JSON.parse(first.body).data.comment;
    const secondComment = JSON.parse(second.body).data.comment;
    expect(secondComment).toMatchObject({
      id: expect.any(String),
      postId,
      itemId: postId,
      content: 'second comment',
      authorRelationship: {
        following: false,
        followedBy: false,
        blocked: false,
        blockedBy: false,
        me: true,
      },
      reportable: false,
      blockable: false,
    });

    const latest = await app.inject({ method: 'GET', url: `/coins/ORCA/community/${postId}/comments?sort=latest` });
    expect(latest.statusCode).toBe(200);
    expect(JSON.parse(latest.body).data).toMatchObject({
      count: 2,
      sort: { orderBy: 'createdAt', direction: 'desc' },
    });
    expect(JSON.parse(latest.body).data.items.map((item: { id: string }) => item.id)).toEqual([secondComment.id, firstComment.id]);

    const oldest = await app.inject({ method: 'GET', url: `/coins/ORCA/community/${postId}/comments?sort=oldest` });
    expect(oldest.statusCode).toBe(200);
    expect(JSON.parse(oldest.body).data.sort).toEqual({ orderBy: 'createdAt', direction: 'asc' });
    expect(JSON.parse(oldest.body).data.items.map((item: { id: string }) => item.id)).toEqual([firstComment.id, secondComment.id]);

    await app.close();
  }, 20000);

  it('does not expose Apple private relay email as community author displayName', async () => {
    const { app } = await createApp();
    const relayToken = app.jwt.sign({ id: 'apple-user-1', email: 'w9xyz123@privaterelay.appleid.com' });

    const created = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${relayToken}` },
      payload: { content: 'private relay display test' },
    });
    expect(created.statusCode).toBe(201);
    const author = JSON.parse(created.body).data.item.author;
    expect(author).toMatchObject({
      id: 'apple-user-1',
      displayName: 'Apple 사용자',
      nickname: null,
      emailMasked: 'w9***@privaterelay.appleid.com',
      isPrivateRelay: true,
      followable: true,
      isMe: true,
    });
    expect(author.displayName).not.toContain('privaterelay.appleid.com');

    await app.close();
  }, 20000);

  it('upserts coin sentiment per user and keeps market sentiment in a separate scope', async () => {
    const { app, token } = await createApp();

    const bullish = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'bullish' },
    });
    expect(bullish.statusCode).toBe(200);
    expect(JSON.parse(bullish.body).data).toMatchObject({
      scope: 'coin',
      symbol: 'ORCA',
      totalParticipants: 1,
      bullishCount: 1,
      bearishCount: 0,
      bullishRatio: 100,
      bearishRatio: 0,
      ratioScale: 'percent',
      myVote: 'bullish',
    });

    const bearish = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'bearish' },
    });
    expect(bearish.statusCode).toBe(200);
    expect(JSON.parse(bearish.body).data).toMatchObject({
      totalParticipants: 1,
      bullishCount: 0,
      bearishCount: 1,
      myVote: 'bearish',
    });

    const marketVote = await app.inject({
      method: 'POST',
      url: '/market/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'bullish' },
    });
    expect(marketVote.statusCode).toBe(200);
    expect(JSON.parse(marketVote.body).data).toMatchObject({
      scope: 'market',
      totalParticipants: 1,
      bullishCount: 1,
      bearishCount: 0,
      myVote: 'bullish',
    });

    const market = await app.inject({ method: 'GET', url: '/market/sentiment' });
    expect(market.statusCode).toBe(200);
    expect(JSON.parse(market.body).data).toMatchObject({
      scope: 'market',
      totalParticipants: 1,
      bullishCount: 1,
      bearishCount: 0,
    });

    const coin = await app.inject({ method: 'GET', url: '/coins/ORCA/sentiment' });
    expect(coin.statusCode).toBe(200);
    expect(JSON.parse(coin.body).data).toMatchObject({
      scope: 'coin',
      symbol: 'ORCA',
      totalParticipants: 1,
      bullishCount: 0,
      bearishCount: 1,
    });

    await app.close();
  }, 20000);

  it('uses cryptocurrency.cv as a separate no-auth news provider when selected', async () => {
    const { app, restCalls } = await createApp({
      NEWS_PROVIDER: 'cryptocurrency_cv',
      CRYPTOCURRENCY_CV_API_BASE_URL: 'https://cryptocurrency.cv/api',
      CRYPTOCURRENCY_CV_API_KEY: '',
      CRYPTOPANIC_API_BASE_URL: 'https://cryptopanic.com/api/v1',
      CRYPTOPANIC_API_KEY: '',
    });

    const marketResponse = await app.inject({ method: 'GET', url: '/news?limit=2' });
    expect(marketResponse.statusCode).toBe(200);
    const marketBody = JSON.parse(marketResponse.body);
    expect(marketBody.data.sourceStatus).toMatchObject({
      externalConfigured: true,
      externalAvailable: true,
      fallbackUsed: false,
      providers: ['cryptocurrency_cv'],
    });
    expect(marketBody.data.items[0]).toMatchObject({
      provider: 'cryptocurrency_cv',
      source: 'Crypto Vision',
      url: 'https://cryptocurrency.cv/news/cv-market-1',
    });

    const coinResponse = await app.inject({ method: 'GET', url: '/coins/BTC/news?limit=2' });
    expect(coinResponse.statusCode).toBe(200);
    const coinBody = JSON.parse(coinResponse.body);
    expect(coinBody.data.sourceStatus.providers).toContain('cryptocurrency_cv');
    expect(coinBody.data.items[0]).toMatchObject({
      provider: 'cryptocurrency_cv',
      symbols: ['BTC'],
    });

    const newsCall = restCalls.find((call) => call.path === '/news');
    const searchCall = restCalls.find((call) => call.path === '/search');
    expect(newsCall?.options?.query).toMatchObject({ limit: 2 });
    expect(searchCall?.options?.query).toMatchObject({ limit: 2 });
    expect(String(searchCall?.options?.query?.q)).toContain('Bitcoin');
    expect(newsCall?.options?.query).not.toHaveProperty('auth_token');
    expect(newsCall?.options?.query).not.toHaveProperty('apiKey');
    expect(newsCall?.options?.query).not.toHaveProperty('api_key');
    expect(newsCall?.options?.headers).toBeUndefined();
    expect(searchCall?.options?.query).not.toHaveProperty('auth_token');
    expect(searchCall?.options?.query).not.toHaveProperty('apiKey');
    expect(searchCall?.options?.query).not.toHaveProperty('api_key');
    expect(searchCall?.options?.headers).toBeUndefined();

    await app.close();
  }, 20000);

  it('falls back to cached news when the provider fails after a successful fetch', async () => {
    const { app } = await createApp({
      NEWS_PROVIDER: 'cryptocurrency_cv',
      NEWS_TEST_FAIL_AFTER_SUCCESS: 'true',
    });

    const fresh = await app.inject({ method: 'GET', url: '/news?limit=2' });
    expect(fresh.statusCode).toBe(200);
    expect(JSON.parse(fresh.body).data).toMatchObject({
      source: 'cryptocurrency_cv',
      cacheHit: false,
      items: [expect.objectContaining({ provider: 'cryptocurrency_cv' })],
    });

    const cached = await app.inject({ method: 'GET', url: '/news?limit=2' });
    expect(cached.statusCode).toBe(200);
    expect(JSON.parse(cached.body).data).toMatchObject({
      source: 'cache',
      cacheHit: true,
      items: [expect.objectContaining({ provider: 'cryptocurrency_cv' })],
      sourceStatus: {
        fallbackUsed: true,
      },
    });

    await app.close();
  }, 20000);

  it('keeps explicit news dates strict and only uses latest available date when fallback is requested', async () => {
    const { app } = await createApp({
      NEWS_PROVIDER: 'cryptocurrency_cv',
      CRYPTOCURRENCY_CV_API_BASE_URL: 'https://cryptocurrency.cv/api',
    });

    const strictToday = await app.inject({ method: 'GET', url: '/news?date=2026-05-03&limit=20' });
    expect(strictToday.statusCode).toBe(200);
    const strictBody = JSON.parse(strictToday.body).data;
    expect(strictBody.items).toEqual([]);
    expect(strictBody).toMatchObject({
      requestedDate: '2026-05-03',
      resolvedRange: {
        timezone: 'Asia/Seoul',
        startUTC: '2026-05-02T15:00:00.000Z',
        endUTC: '2026-05-03T15:00:00.000Z',
      },
      fallbackUsed: false,
      fallbackDate: null,
      reason: 'no_news_for_date',
    });

    const fallback = await app.inject({ method: 'GET', url: '/news?date=2026-05-03&fallback=true&limit=20' });
    expect(fallback.statusCode).toBe(200);
    expect(JSON.parse(fallback.body).data).toMatchObject({
      fallbackUsed: true,
      fallbackDate: '2026-05-02',
      reason: 'no_news_for_requested_date_using_latest_available',
      items: [expect.objectContaining({ provider: 'cryptocurrency_cv' })],
    });

    await app.close();
  }, 20000);

  it('builds BIO coin news queries from metadata instead of the bare symbol', async () => {
    const { app, restCalls } = await createApp({
      NEWS_PROVIDER: 'cryptocurrency_cv',
      CRYPTOCURRENCY_CV_API_BASE_URL: 'https://cryptocurrency.cv/api',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/news?symbol=BIO&coinName=BIO%20Protocol&providerId=bio-protocol&date=2026-05-02&limit=20',
    });
    expect(response.statusCode).toBe(200);
    const searchCall = restCalls.find((call) => call.path === '/search');
    const query = String(searchCall?.options?.query?.q);
    expect(query).toContain('"BIO Protocol"');
    expect(query).toContain('"BIO Protocol token"');
    expect(query).toContain('DeSci');
    expect(query).toContain('bio.xyz');
    expect(query).not.toBe('BIO');
    expect(JSON.parse(response.body).data).toMatchObject({
      scope: 'coin',
      symbol: 'BIO',
      coinName: 'BIO Protocol',
      reason: expect.any(String),
    });

    await app.close();
  }, 20000);

  it('marks 30d market history insufficient instead of duplicating the current point', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market-data/global/history?range=30d&interval=daily&currency=KRW' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data).toMatchObject({
      range: '30d',
      interval: 'daily',
      currency: 'KRW',
      points: [],
      source: 'none',
      reason: 'insufficient_history',
      requiredPointCount: 30,
      metricAvailability: {
        marketCap: false,
        volume24h: false,
        btcDominance: false,
        ethDominance: false,
      },
    });

    await app.close();
  }, 20000);

  it('returns news overview mood without events and with topNews contract', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/news/overview' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.data.mood).toMatchObject({
      score: 26,
      label: 'fear',
      labelKo: '공포',
      scale: { min: 0, max: 100 },
      available: true,
      reason: null,
    });
    expect(body.data.mood.labelKo).not.toBe('중립');
    expect(body.data).not.toHaveProperty('events');
    expect(body.data).not.toHaveProperty('eventsState');
    expect(body.data.summary).toMatchObject({
      title: '오늘 시장 요약',
      headlineKo: expect.any(String),
      descriptionKo: expect.any(String),
      available: true,
      reason: null,
    });
    expect(body.data.marketSentiment).toMatchObject({
      scope: 'market',
      ratioScale: 'percent',
      myVote: null,
    });
    expect(body.data.sourceStatus).toMatchObject({
      marketDataAvailable: true,
      fearGreedAvailable: true,
      newsAvailable: true,
      fallbackUsed: true,
      reasons: expect.any(Array),
    });
    expect(body.data.topNews[0]).toMatchObject({
      id: expect.any(String),
      title: expect.any(String),
      titleKo: null,
      source: expect.any(String),
      provider: expect.any(String),
      publishedAt: expect.any(String),
      url: expect.any(String),
      imageUrl: null,
      summary: expect.any(String),
      summaryKo: null,
      tags: expect.any(Array),
    });

    await app.close();
  }, 20000);

  it('returns market trend series with stable point and partial-data shape', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/trends?range=7d&currency=KRW' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        scope: 'market',
        range: '7d',
        currency: 'KRW',
        source: 'coingecko',
        pointCount: expect.any(Number),
        chartReady: expect.any(Boolean),
        renderHint: expect.any(String),
        dataQuality: {
          level: expect.any(String),
          messageKo: expect.any(String),
          reason: expect.anything(),
        },
        availability: {
          totalMarketCap: true,
          totalVolume: true,
          btcDominance: true,
          ethDominance: true,
          fearGreedIndex: false,
        },
        unavailableReasons: {
          fearGreedIndex: 'HISTORICAL_FEAR_GREED_NOT_AVAILABLE',
        },
        points: expect.any(Array),
      },
    });
    if (body.data.points.length > 0) {
      expect(body.data.points[0]).toMatchObject({
        timestamp: expect.any(String),
        totalMarketCap: expect.any(Number),
        totalVolume: expect.any(Number),
        btcDominance: expect.any(Number),
        ethDominance: expect.any(Number),
        fearGreedIndex: null,
      });
    } else {
      expect(body.data.emptyState).toMatchObject({
        isEmpty: true,
        reason: expect.any(String),
      });
    }
    if (body.data.pointCount <= 2) {
      expect(body.data.chartReady).toBe(false);
      expect(body.data.renderHint).toBe('limited_points');
    }
    if (body.data.pointCount >= 7) {
      expect(body.data.chartReady).toBe(true);
      expect(body.data.renderHint).toBe('chart');
    }
    for (const key of Object.keys(body.data.unavailableReasons)) {
      expect(body.data.availability[key]).toBe(false);
    }

    await app.close();
  }, 20000);

  it('returns market dashboard metrics with raw/formatted values and unavailable reasons', async () => {
    const { app } = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/data?currency=KRW' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body).toMatchObject({
      success: true,
      data: {
        scope: 'market',
        currency: 'KRW',
        source: 'coingecko',
        updatedAt: expect.any(String),
        isStale: false,
        metrics: {
          totalMarketCap: {
            value: 2680000000000,
            formatted: expect.stringMatching(/^KRW /),
            currency: 'KRW',
            available: true,
            source: 'coingecko',
            reason: null,
          },
          totalVolume24h: {
            value: 83225000000,
            formatted: expect.stringMatching(/^KRW /),
            currency: 'KRW',
            available: true,
            source: 'coingecko',
            reason: null,
          },
          btcDominance: {
            value: 58.47,
            unit: 'percent',
            available: true,
            source: 'coingecko',
            reason: null,
          },
          ethDominance: {
            value: 10.37,
            unit: 'percent',
            available: true,
            source: 'coingecko',
            reason: null,
          },
          fearGreedIndex: {
            value: 26,
            unit: 'index',
            label: 'fear',
            labelKo: '공포',
            available: true,
            source: 'alternative.me',
            reason: null,
          },
          altcoinIndex: {
            value: null,
            unit: 'index',
            label: null,
            labelKo: null,
            available: false,
            source: null,
            reason: 'ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED',
          },
        },
        availability: {
          totalMarketCap: true,
          totalVolume24h: true,
          btcDominance: true,
          ethDominance: true,
          fearGreedIndex: true,
          altcoinIndex: false,
        },
        unavailableReasons: {
          altcoinIndex: 'ALTCOIN_INDEX_SOURCE_NOT_CONFIGURED',
        },
        sourceStatus: {
          marketDataAvailable: true,
          fearGreedAvailable: true,
          fallbackUsed: false,
        },
      },
    });

    await app.close();
  }, 20000);

  it('validates market sentiment vote values and keeps upsert participant count stable', async () => {
    const { app, token } = await createApp();

    const invalid = await app.inject({
      method: 'POST',
      url: '/market/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'neutral' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(JSON.parse(invalid.body)).toMatchObject({
      success: false,
      code: 'INVALID_SENTIMENT_VOTE',
    });

    const bullish = await app.inject({
      method: 'POST',
      url: '/market/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'bullish' },
    });
    expect(bullish.statusCode).toBe(200);
    expect(JSON.parse(bullish.body).data).toMatchObject({
      totalParticipants: 1,
      bullishCount: 1,
      bearishCount: 0,
      myVote: 'bullish',
    });

    const bearish = await app.inject({
      method: 'POST',
      url: '/market/sentiment',
      headers: { authorization: `Bearer ${token}` },
      payload: { vote: 'bearish' },
    });
    expect(bearish.statusCode).toBe(200);
    expect(JSON.parse(bearish.body).data).toMatchObject({
      totalParticipants: 1,
      bullishCount: 0,
      bearishCount: 1,
      myVote: 'bearish',
    });

    await app.close();
  }, 20000);

  it('returns translation provider errors, successful translations, cache hits, and length validation', async () => {
    const missingProvider = await createApp();
    const unavailable = await missingProvider.app.inject({
      method: 'POST',
      url: '/translate',
      payload: {
        text: 'English text',
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        context: 'coin_description',
        symbol: 'ORCA',
      },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body)).toMatchObject({
      success: false,
      code: 'TRANSLATION_PROVIDER_NOT_CONFIGURED',
    });
    await missingProvider.app.close();

    const configured = await createApp({
      TRANSLATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-openai-key',
      TRANSLATION_MAX_TEXT_LENGTH: '80',
    });
    const translated = await configured.app.inject({
      method: 'POST',
      url: '/translate',
      payload: {
        text: '<p>Orca is a decentralized exchange on Solana.</p>',
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        context: 'coin_description',
        symbol: 'ORCA',
      },
    });
    expect(translated.statusCode).toBe(200);
    expect(JSON.parse(translated.body).data).toMatchObject({
      sourceLanguage: 'en',
      targetLanguage: 'ko',
      translatedText: '오르카는 솔라나 기반 탈중앙화 거래소입니다.',
      provider: 'openai',
      cached: false,
      updatedAt: expect.any(String),
    });

    const cached = await configured.app.inject({
      method: 'POST',
      url: '/translate',
      payload: {
        text: '<p>Orca is a decentralized exchange on Solana.</p>',
        sourceLanguage: 'en',
        targetLanguage: 'ko',
        context: 'coin_description',
        symbol: 'ORCA',
      },
    });
    expect(cached.statusCode).toBe(200);
    expect(JSON.parse(cached.body).data.cached).toBe(true);

    const tooLong = await configured.app.inject({
      method: 'POST',
      url: '/translate',
      payload: {
        text: 'x'.repeat(81),
        sourceLanguage: 'en',
        targetLanguage: 'ko',
      },
    });
    expect(tooLong.statusCode).toBe(400);
    expect(JSON.parse(tooLong.body).code).toBe('TRANSLATION_TEXT_TOO_LONG');
    await configured.app.close();
  }, 20000);

  it('supports batch translations with validation, cache, and original-only fallback', async () => {
    const fallback = await createApp();
    const originalOnly = await fallback.app.inject({
      method: 'POST',
      url: '/translations',
      payload: {
        targetLanguage: 'ko',
        items: [
          { id: 'empty', text: '   ', sourceLanguage: 'en' },
          { id: 'title', text: '<b>Bitcoin market update</b>', sourceLanguage: 'en' },
        ],
      },
    });
    expect(originalOnly.statusCode).toBe(200);
    expect(JSON.parse(originalOnly.body).data.items).toEqual([
      expect.objectContaining({
        id: 'empty',
        translatedText: '',
        provider: 'fallback',
        status: 'original_only',
        reason: 'EMPTY_TEXT',
      }),
      expect.objectContaining({
        id: 'title',
        originalText: 'Bitcoin market update',
        translatedText: 'Bitcoin market update',
        provider: 'fallback',
        status: 'original_only',
        reason: 'TRANSLATION_PROVIDER_NOT_CONFIGURED',
      }),
    ]);
    await fallback.app.close();

    const configured = await createApp({
      TRANSLATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-openai-key',
    });
    const translated = await configured.app.inject({
      method: 'POST',
      url: '/translations',
      payload: {
        targetLanguage: 'ko',
        items: [{ id: 'coin_description', text: 'Orca is a decentralized exchange on Solana.', sourceLanguage: 'en' }],
      },
    });
    expect(translated.statusCode).toBe(200);
    expect(JSON.parse(translated.body).data.items[0]).toMatchObject({
      id: 'coin_description',
      translatedText: '오르카는 솔라나 기반 탈중앙화 거래소입니다.',
      provider: 'openai',
      cached: false,
      status: 'translated',
    });

    const cached = await configured.app.inject({
      method: 'POST',
      url: '/api/v1/translations',
      payload: {
        targetLanguage: 'ko',
        items: [{ id: 'coin_description', text: 'Orca is a decentralized exchange on Solana.', sourceLanguage: 'en' }],
      },
    });
    expect(cached.statusCode).toBe(200);
    expect(JSON.parse(cached.body).data.items[0]).toMatchObject({
      provider: 'cache',
      cached: true,
    });

    const tooMany = await configured.app.inject({
      method: 'POST',
      url: '/translations',
      payload: {
        targetLanguage: 'ko',
        items: Array.from({ length: 21 }, (_, index) => ({ id: `item_${index}`, text: 'x', sourceLanguage: 'en' })),
      },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(JSON.parse(tooMany.body).code).toBe('INVALID_TRANSLATION_BATCH_REQUEST');
    await configured.app.close();
  }, 20000);

  it('persists app-review reports, blocks users, hides blocked comments, and guards follow relationships', async () => {
    const { app, token } = await createApp();
    const otherToken = app.jwt.sign({ id: 'user-2', email: 'other@example.com' });

    const post = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${token}` },
      payload: { content: 'report target post' },
    });
    const postId = JSON.parse(post.body).data.item.id;
    const comment = await app.inject({
      method: 'POST',
      url: `/coins/ORCA/community/${postId}/comments`,
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { content: 'blocked user comment' },
    });
    const commentId = JSON.parse(comment.body).data.comment.id;
    const otherPost = await app.inject({
      method: 'POST',
      url: '/coins/ORCA/community',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { content: 'blocked user post' },
    });
    const otherPostId = JSON.parse(otherPost.body).data.item.id;

    const reportPost = await app.inject({
      method: 'POST',
      url: '/community/reports',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { targetType: 'post', targetId: postId, reason: 'spam', description: '<b>spam</b>' },
    });
    expect(reportPost.statusCode).toBe(200);
    expect(JSON.parse(reportPost.body).data).toMatchObject({
      reportId: expect.any(String),
      status: 'received',
      duplicate: false,
    });

    const duplicateReport = await app.inject({
      method: 'POST',
      url: '/community/reports',
      headers: { authorization: `Bearer ${otherToken}` },
      payload: { targetType: 'post', targetId: postId, reason: 'spam' },
    });
    expect(duplicateReport.statusCode).toBe(200);
    expect(JSON.parse(duplicateReport.body).data).toMatchObject({
      reportId: JSON.parse(reportPost.body).data.reportId,
      duplicate: true,
    });

    const reportComment = await app.inject({
      method: 'POST',
      url: '/community/reports',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetType: 'comment', targetId: commentId, reason: 'harassment' },
    });
    expect(reportComment.statusCode).toBe(200);

    const invalidReason = await app.inject({
      method: 'POST',
      url: '/community/reports',
      headers: { authorization: `Bearer ${token}` },
      payload: { targetType: 'comment', targetId: commentId, reason: 'not-a-reason' },
    });
    expect(invalidReason.statusCode).toBe(400);
    expect(JSON.parse(invalidReason.body).code).toBe('INVALID_REPORT_REQUEST');

    const selfBlock = await app.inject({
      method: 'POST',
      url: '/community/blocks',
      headers: { authorization: `Bearer ${token}` },
      payload: { blockedUserId: 'user-1' },
    });
    expect(selfBlock.statusCode).toBe(400);
    expect(JSON.parse(selfBlock.body).code).toBe('CANNOT_BLOCK_SELF');

    const block = await app.inject({
      method: 'POST',
      url: '/community/blocks',
      headers: { authorization: `Bearer ${token}` },
      payload: { blockedUserId: 'user-2' },
    });
    expect(block.statusCode).toBe(200);
    expect(JSON.parse(block.body).data).toMatchObject({ blockedUserId: 'user-2', blocked: true });

    const blockedComments = await app.inject({
      method: 'GET',
      url: `/coins/ORCA/community/${postId}/comments`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedComments.statusCode).toBe(200);
    expect(JSON.parse(blockedComments.body).data.items).toEqual([]);

    const blockedPosts = await app.inject({
      method: 'GET',
      url: '/coins/ORCA/community?sort=latest',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedPosts.statusCode).toBe(200);
    expect(JSON.parse(blockedPosts.body).data.items.some((item: { id: string }) => item.id === otherPostId)).toBe(false);
    expect(JSON.parse(blockedPosts.body).data.sort).toEqual({ orderBy: 'createdAt', direction: 'desc' });

    const followBlocked = await app.inject({
      method: 'POST',
      url: '/users/user-2/follow',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(followBlocked.statusCode).toBe(403);
    expect(JSON.parse(followBlocked.body).code).toBe('FOLLOW_BLOCKED_USER_FORBIDDEN');

    const relationship = await app.inject({
      method: 'POST',
      url: '/users/relationships/batch',
      headers: { authorization: `Bearer ${token}` },
      payload: { userIds: ['user-1', 'user-2'] },
    });
    expect(relationship.statusCode).toBe(200);
    expect(JSON.parse(relationship.body).data.items).toEqual([
      expect.objectContaining({ userId: 'user-1', me: true }),
      expect.objectContaining({ userId: 'user-2', blocked: true, following: false }),
    ]);

    const blocks = await app.inject({
      method: 'GET',
      url: '/community/blocks',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blocks.statusCode).toBe(200);
    expect(JSON.parse(blocks.body).data.items[0]).toMatchObject({ blockedUserId: 'user-2', blocked: true });

    const unblock = await app.inject({
      method: 'DELETE',
      url: '/api/v1/community/blocks/user-2',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unblock.statusCode).toBe(200);
    expect(JSON.parse(unblock.body).data).toMatchObject({ blockedUserId: 'user-2', blocked: false });

    const follow = await app.inject({
      method: 'POST',
      url: '/users/user-2/follow',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(follow.statusCode).toBe(200);
    expect(JSON.parse(follow.body).data).toMatchObject({ following: true, isFollowing: true });

    const unfollow = await app.inject({
      method: 'DELETE',
      url: '/users/user-2/follow',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(unfollow.statusCode).toBe(200);
    expect(JSON.parse(unfollow.body).data).toMatchObject({ following: false, isFollowing: false });

    await app.close();
  }, 20000);

  it('filters news by date and symbol relevance, supports summaries, and returns global market history', async () => {
    const { app } = await createApp();

    const news = await app.inject({ method: 'GET', url: '/news?symbol=BIO&date=2026-05-02&limit=20' });
    expect(news.statusCode).toBe(200);
    const newsBody = JSON.parse(news.body);
    expect(newsBody.data.items).toEqual([]);
    expect(newsBody.data).toMatchObject({
      date: '2026-05-02',
      cacheHit: false,
      providerStatus: expect.any(Object),
      reason: expect.any(String),
      sort: { orderBy: 'publishedAt', direction: 'desc' },
    });
    expect(newsBody.data.relatedItems.every((item: { title: string; summary: string | null }) => {
      const text = `${item.title} ${item.summary ?? ''}`.toLowerCase();
      return !text.includes('apple') && !text.includes('porsche') && !text.includes('rent');
    })).toBe(true);

    const oldestNews = await app.inject({ method: 'GET', url: '/news?date=2026-05-02&limit=3&sort=oldest' });
    expect(oldestNews.statusCode).toBe(200);
    const oldestBody = JSON.parse(oldestNews.body);
    expect(oldestBody.data.sort).toEqual({ orderBy: 'publishedAt', direction: 'asc' });
    expect(oldestBody.data.items.map((item: { publishedAt: string }) => item.publishedAt)).toEqual([
      '2026-05-02T00:00:00.000Z',
      '2026-05-02T01:00:00.000Z',
      '2026-05-02T02:00:00.000Z',
    ]);

    const summary = await app.inject({ method: 'GET', url: '/news/summary?date=2026-05-02&targetLanguage=ko' });
    expect(summary.statusCode).toBe(200);
    expect(JSON.parse(summary.body).data).toMatchObject({
      date: '2026-05-02',
      translated: false,
      items: expect.any(Array),
    });
    expect(JSON.parse(summary.body).data.items[0]).toMatchObject({
      translatedTitle: null,
      translatedSummary: null,
      originalUrl: expect.any(String),
    });

    const history = await app.inject({ method: 'GET', url: '/market-data/global/history?range=30d&interval=daily' });
    expect(history.statusCode).toBe(200);
    const historyBody = JSON.parse(history.body);
    expect(historyBody.data).toMatchObject({
      range: '30d',
      interval: 'daily',
      currency: 'KRW',
      source: 'none',
      cacheHit: expect.any(Boolean),
      reason: 'insufficient_history',
    });
    expect(historyBody.data.points).toEqual([]);
    expect(historyBody.data.metricAvailability).toEqual({
      marketCap: false,
      volume24h: false,
      btcDominance: false,
      ethDominance: false,
    });

    await app.close();
  }, 20000);

  it('translates coin info descriptions when the server translation provider is configured', async () => {
    const { app } = await createApp({
      TRANSLATION_PROVIDER: 'openai',
      OPENAI_API_KEY: 'test-openai-key',
    });

    const response = await app.inject({ method: 'GET', url: '/coins/ORCA/info' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).data.description).toMatchObject({
      ko: '오르카는 솔라나 기반 탈중앙화 거래소입니다.',
      plainTextKo: '오르카는 솔라나 기반 탈중앙화 거래소입니다.',
      translated: true,
      translationProvider: 'openai',
      reason: null,
    });

    await app.close();
  }, 20000);

  it('keeps compatibility aliases on the same envelope and body shape', async () => {
    const { app } = await createApp();

    const [rootNews, aliasNews, rootMarket, aliasMarket, rootCoin, aliasCoin] = await Promise.all([
      app.inject({ method: 'GET', url: '/news?limit=1' }),
      app.inject({ method: 'GET', url: '/api/v1/news?limit=1' }),
      app.inject({ method: 'GET', url: '/market/trends?range=7d&currency=KRW' }),
      app.inject({ method: 'GET', url: '/api/v1/market/trends?range=7d&currency=KRW' }),
      app.inject({ method: 'GET', url: '/coins/ORCA/community' }),
      app.inject({ method: 'GET', url: '/api/v1/coins/ORCA/community' }),
    ]);

    expect(rootNews.statusCode).toBe(200);
    expect(aliasNews.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(aliasNews.body))).toEqual(Object.keys(JSON.parse(rootNews.body)));
    expect(Object.keys(JSON.parse(aliasNews.body).data).sort()).toEqual(Object.keys(JSON.parse(rootNews.body).data).sort());

    expect(rootMarket.statusCode).toBe(200);
    expect(aliasMarket.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(aliasMarket.body).data).sort()).toEqual(Object.keys(JSON.parse(rootMarket.body).data).sort());

    expect(rootCoin.statusCode).toBe(200);
    expect(aliasCoin.statusCode).toBe(200);
    expect(Object.keys(JSON.parse(aliasCoin.body).data).sort()).toEqual(Object.keys(JSON.parse(rootCoin.body).data).sort());

    await app.close();
  }, 20000);
});
