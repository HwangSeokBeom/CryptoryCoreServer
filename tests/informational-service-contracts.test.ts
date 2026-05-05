import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
  vi.clearAllMocks();
  vi.doUnmock('../src/config/database');
  vi.doUnmock('../src/domains/assets/asset-metadata.service');
  vi.doUnmock('../src/domains/market-data/market-data.service');
  vi.doUnmock('../src/core/exchange/rest.client');
});

describe('Informational service contracts', () => {
  async function importWithFailingProviders() {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-value',
      NODE_ENV: 'test',
      EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: 'test-exchange-credential-encryption-key-32',
    };

    vi.resetModules();
    vi.doMock('../src/config/database', () => ({
      prisma: {
        coin: {
          findUnique: vi.fn(async () => null),
        },
      },
    }));
    vi.doMock('../src/domains/assets/asset-metadata.service', () => ({
      assetMetadataService: {
        getAssetViewsSafely: vi.fn(async () => new Map()),
      },
    }));
    vi.doMock('../src/domains/market-data/market-data.service', () => ({
      getReferenceTicker: vi.fn(async () => {
        throw new Error('reference provider unavailable');
      }),
      getCandlesWithMeta: vi.fn(async () => {
        throw new Error('candle provider unavailable');
      }),
    }));
    vi.doMock('../src/core/exchange/rest.client', () => ({
      RestClient: class {
        request = vi.fn(async () => {
          throw new Error('external provider unavailable');
        });
      },
    }));

    const [{ getCoinInfo }, { getCoinAnalysis }, { getMarketTrends }] = await Promise.all([
      import('../src/domains/coins/coin-info.service'),
      import('../src/domains/coins/coin-analysis.service'),
      import('../src/domains/market-data/market-trends.service'),
    ]);
    return { getCoinInfo, getCoinAnalysis, getMarketTrends };
  }

  async function importWithCoinGeckoDetail(marketData: Record<string, unknown>) {
    process.env = {
      ...ORIGINAL_ENV,
      DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'super-secret-jwt-value',
      NODE_ENV: 'test',
      EXCHANGE_CREDENTIAL_ENCRYPTION_KEY: 'test-exchange-credential-encryption-key-32',
    };

    vi.resetModules();
    vi.doMock('../src/config/database', () => ({
      prisma: {
        coin: {
          findUnique: vi.fn(async () => null),
        },
      },
    }));
    vi.doMock('../src/domains/assets/asset-metadata.service', () => ({
      assetMetadataService: {
        getAssetViewsSafely: vi.fn(async () => new Map()),
      },
    }));
    vi.doMock('../src/domains/market-data/market-data.service', () => ({
      getReferenceTicker: vi.fn(async () => {
        throw new Error('reference provider unavailable');
      }),
      getCandlesWithMeta: vi.fn(async () => {
        throw new Error('candle provider unavailable');
      }),
    }));
    vi.doMock('../src/core/exchange/rest.client', () => ({
      RestClient: class {
        request = vi.fn(async () => ({
          id: 'orca',
          symbol: 'orca',
          name: 'Orca',
          image: null,
          description: { en: 'Orca protocol reference information.' },
          links: { homepage: [], blockchain_site: [] },
          market_data: marketData,
          last_updated: '2026-05-02T00:00:00.000Z',
        }));
      },
    }));

    const { getCoinInfo } = await import('../src/domains/coins/coin-info.service');
    return { getCoinInfo };
  }

  it('returns null-safe coin info fallback and normalizes common pair inputs', async () => {
    const { getCoinInfo } = await importWithFailingProviders();

    await expect(getCoinInfo('DRIFT/KRW')).resolves.toMatchObject({
      symbol: 'DRIFT',
      displaySymbol: 'DRIFT/KRW',
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
        marketCap: null,
        marketCapRank: null,
        circulatingSupply: null,
        totalSupply: null,
        maxSupply: null,
      },
      source: null,
      sourceDetail: { fallbackUsed: true },
    });

    await expect(getCoinInfo('KRW-DRIFT')).resolves.toMatchObject({ symbol: 'DRIFT' });
    await expect(getCoinInfo('drift')).resolves.toMatchObject({ symbol: 'DRIFT' });
    await expect(getCoinInfo('ORCA/KRW')).resolves.toMatchObject({ symbol: 'ORCA', displaySymbol: 'ORCA/KRW' });
    await expect(getCoinInfo('KRW-ORCA')).resolves.toMatchObject({ symbol: 'ORCA' });
    await expect(getCoinInfo('orca')).resolves.toMatchObject({ symbol: 'ORCA' });
    await expect(getCoinInfo('UNKNOWN')).resolves.toMatchObject({
      symbol: 'UNKNOWN',
      market: { price: null, volume24h: null },
      source: null,
      sourceDetail: { fallbackUsed: true },
    });
  });

  it('maps available period price changes and leaves missing provider values null', async () => {
    const { getCoinInfo } = await importWithCoinGeckoDetail({
      current_price: { krw: 1234 },
      high_24h: { krw: 1300 },
      low_24h: { krw: 1200 },
      total_volume: { krw: 1000000 },
      price_change_percentage_24h: 1.25,
      price_change_percentage_7d: 2.5,
      price_change_percentage_14d: null,
      price_change_percentage_30d: -3.75,
    });

    await expect(getCoinInfo('ORCA')).resolves.toMatchObject({
      symbol: 'ORCA',
      providerId: 'orca',
      market: {
        priceChangePercent24h: 1.25,
        priceChangePercent7d: 2.5,
        priceChangePercent14d: null,
        priceChangePercent30d: -3.75,
        priceChangePercent60d: null,
        priceChangePercent200d: null,
        priceChangePercent1y: null,
      },
    });
  });

  it('returns neutral analysis and market trend fallbacks when providers fail', async () => {
    const { getCoinAnalysis, getMarketTrends } = await importWithFailingProviders();

    await expect(getCoinAnalysis('DRIFT', '1h')).resolves.toMatchObject({
      symbol: 'DRIFT',
      timeframe: '1h',
      summary: {
        status: 'neutral',
        label: '중립',
      },
      indicators: [
        {
          key: 'recent_price_change',
          label: '최근 가격 변화',
          state: 'neutral',
          valueText: '데이터 부족',
        },
      ],
      source: { type: 'server_analysis', fallbackUsed: true },
    });

    await expect(getMarketTrends()).resolves.toMatchObject({
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
      movers: {
        topGainers: [],
        topLosers: [],
        topVolume: [],
      },
      series: {
        marketCap: [],
        volume: [],
      },
      source: {
        primary: 'market_snapshot',
        fallbackUsed: true,
      },
      insights: [],
      dataQuality: {
        summaryAvailable: false,
        moversAvailable: false,
        seriesAvailable: false,
        fallbackUsed: true,
      },
    });
    const trends = await getMarketTrends();
    expect(Array.isArray(trends.events)).toBe(true);
    expect(JSON.stringify(trends).toLowerCase()).not.toMatch(/\b(buy|sell|strong buy|strong sell|recommend|investment advice)\b|매수|매도|추천|투자\s*조언/);
  });
});
