import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/domains/market-data/market-data.service', () => ({
  listMarkets: vi.fn(async () => []),
  getTickers: vi.fn(async () => [
    {
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      price: 100000000,
      change24h: 1.2,
      volume24h: 1000,
      high24h: 101000000,
      low24h: 99000000,
      timestamp: 1712345678000,
    },
  ]),
  getOrderbook: vi.fn(),
  getTrades: vi.fn(),
  getCandles: vi.fn(),
  getReferenceTicker: vi.fn(),
}));

vi.mock('../src/domains/kimchi-premium/kimchi-premium.service', () => ({
  getKimchiPremium: vi.fn(async () => [
    {
      symbol: 'BTC',
      nameKo: '비트코인',
      nameEn: 'Bitcoin',
      binanceUsdtPrice: 70000,
      usdKrwRate: 1350,
      binanceKrwPrice: 94500000,
      domestic: [],
      stale: false,
      timestampSkewMs: 0,
    },
  ]),
}));

async function createApp() {
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Responsibility Routes', () => {
  it('GET /market/tickers works without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/market/tickers?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].exchange).toBe('upbit');
    await app.close();
  });

  it('GET /kimchi-premium works without auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/kimchi-premium?symbols=BTC',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data[0].binanceKrwPrice).toBe(94500000);
    await app.close();
  });

  it('GET /trading/chance requires auth', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/trading/chance?exchange=upbit&symbol=BTC',
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
