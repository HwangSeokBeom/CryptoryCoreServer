import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
};

async function createApp() {
  process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

function mockMarketFetch() {
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/market/all')) {
      return new Response(JSON.stringify([
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      return new Response(JSON.stringify([
        {
          market: 'KRW-BTC',
          trade_price: 100000000,
          signed_change_rate: 0.0123,
          signed_change_price: 1230000,
          acc_trade_price_24h: 987654321000,
          acc_trade_volume_24h: 9876,
          high_price: 101000000,
          low_price: 99000000,
          trade_timestamp: 1777809600000,
        },
      ]), { status: 200 });
    }
    if (url.includes('/v1/candles/minutes/60')) {
      return new Response(JSON.stringify([
        {
          candle_date_time_utc: '2026-05-03T12:00:00',
          opening_price: 99000000,
          high_price: 101000000,
          low_price: 98500000,
          trade_price: 100000000,
          candle_acc_trade_volume: 12.5,
          candle_acc_trade_price: 1250000000,
        },
      ]), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 500 });
  });
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('iOS public market contracts', () => {
  it('returns ticker aliases required by the iOS market list when quoteCurrency is used', async () => {
    mockMarketFetch();
    const app = await createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=2',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'KRW',
      status: 'success',
      total: 1,
    });
    expect(body.data.items[0]).toMatchObject({
      exchange: 'upbit',
      marketId: 'KRW-BTC',
      symbol: 'BTC',
      displaySymbol: 'BTC/KRW',
      price: 100000000,
      tradePrice: 100000000,
      changeRate: 1.23,
      signedChangeRate: 1.23,
      changePrice: 1230000,
      signedChangePrice: 1230000,
      accTradePrice24h: 987654321000,
      value: 987654321000,
      updatedAt: '2026-05-03T12:00:00.000Z',
    });

    await app.close();
  }, 15000);

  it('accepts quote and exchange market symbols for candles and returns status plus points', async () => {
    mockMarketFetch();
    const app = await createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?exchange=upbit&symbol=KRW-BTC&quote=KRW&timeframe=1H&limit=1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      symbol: 'BTC',
      quoteCurrency: 'KRW',
      market: 'KRW-BTC',
      marketId: 'KRW-BTC',
      displaySymbol: 'BTC/KRW',
      timeframe: '1H',
      status: 'success',
    });
    expect(body.data.points[0]).toMatchObject({
      timestamp: '2026-05-03T12:00:00.000Z',
      open: 99000000,
      high: 101000000,
      low: 98500000,
      close: 100000000,
      volume: 12.5,
      value: 1250000000,
    });

    await app.close();
  }, 15000);

  it('returns retryable_error instead of unsupported when the exchange candle API is temporarily down', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('rate limit', { status: 429 }));
    const app = await createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/market/candles?exchange=upbit&symbol=KRW-BTC&quote=KRW&timeframe=1H&limit=1',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      status: 'retryable_error',
      points: [],
      error: {
        code: 'MARKET_DATA_RETRYABLE_ERROR',
        retryable: true,
        source: 'external_exchange',
        exchange: 'upbit',
        marketId: 'KRW-BTC',
      },
    });

    await app.close();
  }, 15000);
});
