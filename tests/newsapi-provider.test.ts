import { afterEach, describe, expect, it, vi } from 'vitest';
import { listNews, toNewsApiNewsItems } from '../src/domains/news/news.service';

describe('NewsAPI provider mapping', () => {
  it('maps NewsAPI articles to internal news items and drops removed or incomplete articles', () => {
    const items = toNewsApiNewsItems({
      articles: [
        {
          source: { name: 'Example Crypto' },
          title: 'Bitcoin liquidity improves across crypto exchanges',
          description: 'Crypto market liquidity improved during the session.',
          url: 'https://example.com/bitcoin-liquidity',
          urlToImage: 'https://example.com/image.jpg',
          publishedAt: '2026-05-03T10:00:00.000Z',
        },
        {
          source: { name: 'Example Crypto' },
          title: null,
          description: 'Missing title',
          url: 'https://example.com/missing-title',
          publishedAt: '2026-05-03T10:00:00.000Z',
        },
        {
          source: { name: 'Example Crypto' },
          title: 'Missing URL',
          description: 'Missing URL',
          url: null,
          publishedAt: '2026-05-03T10:00:00.000Z',
        },
        {
          source: { name: 'Removed' },
          title: '[Removed]',
          description: '[Removed]',
          url: 'https://removed.com',
          publishedAt: '2026-05-03T10:00:00.000Z',
        },
        {
          source: { name: 'Duplicate' },
          title: 'Duplicate Bitcoin story',
          description: 'Duplicate URL',
          url: 'https://example.com/bitcoin-liquidity',
          publishedAt: '2026-05-03T10:00:00.000Z',
        },
      ],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Bitcoin liquidity improves across crypto exchanges',
      summary: 'Crypto market liquidity improved during the session.',
      source: 'Example Crypto',
      provider: 'newsapi',
      url: 'https://example.com/bitcoin-liquidity',
      imageUrl: 'https://example.com/image.jpg',
      language: 'en',
    });
    expect(items[0].symbols).toContain('BTC');
    expect(items[0].tags).toContain('market');
  });
});

describe('NewsAPI selected provider', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses NewsAPI as the primary provider when NEWS_PROVIDER=newsapi', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      status: 'ok',
      articles: [{
        source: { name: 'Example Crypto' },
        title: 'Bitcoin and Ethereum lead crypto market update',
        description: 'Digital asset markets tracked bitcoin and ethereum liquidity.',
        url: 'https://example.com/market-update',
        urlToImage: null,
        publishedAt: '2026-05-03T10:00:00.000Z',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await listNews({ date: '2026-05-03', limit: 10 });

    expect(response.source).toBe('newsapi');
    expect(response.providerStatus.newsapi).toBe('ok');
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({
      provider: 'newsapi',
      originalUrl: 'https://example.com/market-update',
      language: 'en',
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/everything?');
    expect(String(url)).toContain('language=en');
    expect(String(url)).not.toContain('apiKey=');
    expect((options.headers as Record<string, string>)['X-Api-Key']).toBeTruthy();
  });
});
