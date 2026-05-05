import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateCandles,
  evaluateAlertCondition,
  isRepeatAlertInCooldown,
} from '../src/domains/market-data/contracts/candle-aggregation';
import { V1ExchangeMarketDataAdapter } from '../src/domains/market-data/contracts/exchange-market-data.adapters';

const ORIGINAL_ENV = { ...process.env };
const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
};

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.doUnmock('node-cron');
  vi.doUnmock('../src/core/exchange/registry.bootstrap');
  vi.doUnmock('../src/domains/market-data/market-streaming.orchestrator');
  vi.doUnmock('../src/domains/market-data/market-data.service');
  vi.doUnmock('../src/domains/charts/chart.service');
  vi.doUnmock('../src/domains/assets/asset-metadata.service');
  vi.resetModules();
});

async function createApp(extraEnv: Record<string, string> = {}) {
  process.env = { ...ORIGINAL_ENV, ...BASE_ENV, ...extraEnv };
  vi.resetModules();
  const { buildApp } = await import('../src/app');
  return buildApp();
}

function mockContractFetch() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/market/all')) {
      return new Response(JSON.stringify([
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        { market: 'KRW-BIO', korean_name: '바이오', english_name: 'Bio Protocol' },
        { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      const request = new URL(url);
      const markets = request.searchParams.get('markets')?.split(',') ?? [];
      const timeStep = Math.max(0, Math.floor((Date.now() - 1777809600000) / 60_000));
      return new Response(JSON.stringify(markets.map((market, index) => ({
        market,
        trade_price: market.startsWith('BTC-')
          ? 0.03 + index * 0.001 + (timeStep % 7) * 0.00001
          : market === 'KRW-BIO'
            ? 100000000 + index * 100000 + ((timeStep % 6) - 2) * 75000 + (timeStep % 3 === 0 ? 180000 : 0)
            : 100000000 + index * 100000 + ((timeStep % 5) - 2) * 50000,
        signed_change_rate: 0.0123,
        signed_change_price: market.startsWith('BTC-') ? 0.0001 : 1230000,
        acc_trade_price_24h: 987654321000 - index,
        acc_trade_volume_24h: 9876 + index,
        high_price: market.startsWith('BTC-') ? 0.031 : 101000000,
        low_price: market.startsWith('BTC-') ? 0.029 : 99000000,
        trade_timestamp: 1777809600000,
      }))), { status: 200 });
    }
    if (url.includes('/v1/candles/minutes/60')) {
      return new Response(JSON.stringify([
        {
          candle_date_time_utc: '2026-05-03T13:00:00',
          opening_price: 100000000,
          high_price: 102000000,
          low_price: 99500000,
          trade_price: 101000000,
          candle_acc_trade_volume: 13,
          candle_acc_trade_price: 1313000000,
        },
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

function mockContractFetchWithTicker(item: Record<string, unknown>) {
  vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/market/all')) {
      return new Response(JSON.stringify([
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      return new Response(JSON.stringify([{ market: 'KRW-BTC', ...item }]), { status: 200 });
    }
    if (url.includes('/v1/candles')) {
      throw new Error('tickers must not call candles');
    }
    return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 500 });
  });
}

function mockExpandedMarketContractFetch() {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/market/all')) {
      return new Response(JSON.stringify([
        { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        { market: 'KRW-BIO', korean_name: '바이오', english_name: 'Bio Protocol' },
        { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        { market: 'BTC-XRP', korean_name: '리플', english_name: 'XRP' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      const request = new URL(url);
      const markets = request.searchParams.get('markets')?.split(',') ?? [];
      const timeStep = Math.max(0, Math.floor((Date.now() - 1777809600000) / 60_000));
      return new Response(JSON.stringify(markets.map((market, index) => ({
        market,
        trade_price: market.startsWith('BTC-')
          ? 0.03 + index * 0.001 + (timeStep % 7) * 0.00001
          : market === 'KRW-BIO'
            ? 100000000 + index * 100000 + ((timeStep % 6) - 2) * 75000 + (timeStep % 3 === 0 ? 180000 : 0)
            : 100000000 + index * 100000 + ((timeStep % 5) - 2) * 50000,
        signed_change_rate: 0.01,
        signed_change_price: market.startsWith('BTC-') ? 0.0001 : 1000000,
        acc_trade_price_24h: 1000 - index,
        acc_trade_volume_24h: 10 + index,
        high_price: market.startsWith('BTC-') ? 0.031 : 101000000,
        low_price: market.startsWith('BTC-') ? 0.029 : 99000000,
        trade_timestamp: Date.now(),
      }))), { status: 200 });
    }
    if (url.includes('/public/v2/markets/KRW')) {
      return new Response(JSON.stringify({
        markets: [
          { quote_currency: 'krw', target_currency: 'btc', trade_status: 1, maintenance_status: 0 },
          { quote_currency: 'krw', target_currency: 'eth', trade_status: 1, maintenance_status: 0 },
        ],
      }), { status: 200 });
    }
    if (url.includes('/public/v2/ticker_new/KRW')) {
      const timeStep = Math.max(0, Math.floor((Date.now() - 1777809600000) / 60_000));
      return new Response(JSON.stringify({
        tickers: [
          { quote_currency: 'krw', target_currency: 'btc', timestamp: Date.now(), high: '101', low: '90', first: '95', last: String(100 + ((timeStep % 5) - 2) * 0.7), quote_volume: '1000', target_volume: '10', yesterday_last: '95' },
          { quote_currency: 'krw', target_currency: 'eth', timestamp: Date.now(), high: '51', low: '40', first: '45', last: String(50 + ((timeStep % 4) - 1) * 0.4), quote_volume: '900', target_volume: '20', yesterday_last: '45' },
        ],
      }), { status: 200 });
    }
    if (url.includes('/v2/currencyPairs')) {
      return new Response(JSON.stringify({
        data: [
          { symbol: 'btc_krw', status: 'launched' },
          { symbol: 'eth_krw', status: 'launched' },
        ],
      }), { status: 200 });
    }
    if (url.includes('/v2/tickers')) {
      return new Response(JSON.stringify({
        data: [
          { symbol: 'btc_krw', close: '100', priceChangePercent: '1.5', quoteVolume: '1000', volume: '10', high: '110', low: '90' },
          { symbol: 'eth_krw', close: '50', priceChangePercent: '2.5', quoteVolume: '900', volume: '20', high: '55', low: '45' },
        ],
      }), { status: 200 });
    }
    if (url.includes('/api/v3/exchangeInfo')) {
      return new Response(JSON.stringify({
        symbols: [
          { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
          { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
        ],
      }), { status: 200 });
    }
    if (url.includes('/api/v3/ticker/24hr')) {
      const request = new URL(url);
      const markets = JSON.parse(request.searchParams.get('symbols') ?? '[]') as string[];
      return new Response(JSON.stringify(markets.map((symbol, index) => ({
        symbol,
        lastPrice: symbol.endsWith('BTC') ? '0.03' : String(100 + index),
        priceChangePercent: '1.2',
        quoteVolume: String(1000 - index),
        volume: String(10 + index),
        highPrice: symbol.endsWith('BTC') ? '0.031' : '110',
        lowPrice: symbol.endsWith('BTC') ? '0.029' : '90',
        closeTime: Date.now(),
      }))), { status: 200 });
    }
    if (url.includes('/candles') || url.includes('/trades') || url.includes('/orderbook')) {
      throw new Error(`sparkline contract must not call heavy provider: ${url}`);
    }
    return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
  });
}

describe('market contract helpers', () => {
  it('normalizes Upbit and Bithumb KRW/BTC market codes', () => {
    const upbit = new V1ExchangeMarketDataAdapter('upbit');
    const bithumb = new V1ExchangeMarketDataAdapter('bithumb');

    expect(upbit.normalizeMarket('BTC', 'KRW')).toBe('KRW-BTC');
    expect(upbit.normalizeMarket('ETH', 'BTC')).toBe('BTC-ETH');
    expect(bithumb.normalizeMarket('SOL', 'BTC')).toBe('BTC-SOL');
  });

  it('aggregates 1H candles into 4H buckets', () => {
    const candles = [
      { timestamp: '2026-05-04T00:00:00.000Z', open: 10, high: 12, low: 9, close: 11, volume: 1, quoteVolume: 10 },
      { timestamp: '2026-05-04T01:00:00.000Z', open: 11, high: 13, low: 10, close: 12, volume: 2, quoteVolume: 20 },
      { timestamp: '2026-05-04T02:00:00.000Z', open: 12, high: 14, low: 8, close: 13, volume: 3, quoteVolume: 30 },
      { timestamp: '2026-05-04T03:00:00.000Z', open: 13, high: 15, low: 12, close: 14, volume: 4, quoteVolume: 40 },
    ];

    expect(aggregateCandles(candles, '4H', 10)).toEqual([
      { timestamp: '2026-05-04T00:00:00.000Z', open: 10, high: 15, low: 8, close: 14, volume: 10, quoteVolume: 100 },
    ]);
  });

  it('aggregates 1D candles into 1W buckets', () => {
    const candles = Array.from({ length: 7 }, (_, index) => ({
      timestamp: new Date(Date.UTC(1970, 0, 1 + index)).toISOString(),
      open: index === 0 ? 100 : 100 + index,
      high: 110 + index,
      low: 90 - index,
      close: 101 + index,
      volume: 1,
      quoteVolume: 2,
    }));

    const [weekly] = aggregateCandles(candles, '1W', 10);
    expect(weekly).toMatchObject({
      open: 100,
      high: 116,
      low: 84,
      close: 107,
      volume: 7,
      quoteVolume: 14,
    });
  });

  it('filters ticker lists by BTC quote currency', async () => {
    const adapter = new V1ExchangeMarketDataAdapter('upbit');
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
          { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify([
        {
          market: 'BTC-ETH',
          trade_price: 0.03,
          signed_change_rate: 0.01,
          signed_change_price: 0.001,
          acc_trade_price_24h: 10,
          acc_trade_volume_24h: 300,
          high_price: 0.031,
          low_price: 0.029,
        },
      ]), { status: 200 });
    });

    const tickers = await adapter.getTickers({ exchange: 'upbit', quoteCurrency: 'BTC' });
    expect(tickers).toHaveLength(1);
    expect(tickers[0]).toMatchObject({ market: 'BTC-ETH', symbol: 'ETH', quoteCurrency: 'BTC' });
  });

  it('evaluates ABOVE/BELOW and REPEAT cooldown rules', () => {
    expect(evaluateAlertCondition({ condition: 'ABOVE', currentPrice: 101, targetPrice: 100 })).toBe(true);
    expect(evaluateAlertCondition({ condition: 'BELOW', currentPrice: 99, targetPrice: 100 })).toBe(true);
    expect(isRepeatAlertInCooldown({
      repeatMode: 'REPEAT',
      lastTriggeredAt: '2026-05-04T00:00:00.000Z',
      now: new Date('2026-05-04T00:05:00.000Z'),
      cooldownSeconds: 600,
    })).toBe(true);
  });
});

describe('market REST contract routes', () => {
  it('does not start market collectors when startup market flags are false', async () => {
    process.env = {
      ...ORIGINAL_ENV,
      ...BASE_ENV,
      MARKET_COLLECTOR_ENABLED: 'false',
      MARKET_TRADE_COLLECTOR_ENABLED: 'false',
      MARKET_TREND_SNAPSHOT_ENABLED: 'false',
      MARKET_STARTUP_WARMUP_ENABLED: 'false',
    };
    vi.resetModules();
    const start = vi.fn();
    vi.doMock('../src/domains/market-data/market-streaming.orchestrator', () => ({
      marketStreamingOrchestrator: { start, stop: vi.fn() },
    }));
    vi.doMock('../src/domains/market-data/market-data.service', () => ({
      startMarketSnapshotCache: vi.fn(),
      stopMarketSnapshotCache: vi.fn(),
    }));
    vi.doMock('../src/domains/charts/chart.service', () => ({
      startChartLiveService: vi.fn(),
      stopChartLiveService: vi.fn(),
    }));
    vi.doMock('../src/domains/assets/asset-metadata.service', () => ({
      assetMetadataService: { start: vi.fn(), stop: vi.fn() },
    }));

    const { startTickerCollector } = await import('../src/jobs/tickerCollector');
    startTickerCollector();

    expect(start).not.toHaveBeenCalled();
  });

  it('starts the market collector without trade hydration when MARKET_TRADE_COLLECTOR_ENABLED is false', async () => {
    vi.useFakeTimers();
    process.env = {
      ...ORIGINAL_ENV,
      ...BASE_ENV,
      MARKET_COLLECTOR_ENABLED: 'true',
      MARKET_TRADE_COLLECTOR_ENABLED: 'false',
      MARKET_TREND_SNAPSHOT_ENABLED: 'false',
      MARKET_STARTUP_WARMUP_ENABLED: 'false',
    };
    vi.resetModules();
    const start = vi.fn();
    vi.doMock('node-cron', () => ({
      default: { schedule: vi.fn(() => ({ stop: vi.fn(), destroy: vi.fn() })) },
    }));
    vi.doMock('../src/core/exchange/registry.bootstrap', () => ({
      exchangeProviderRegistry: {
        getFxRateProvider: () => ({ getUsdKrwRate: vi.fn().mockResolvedValue(1350) }),
      },
    }));
    vi.doMock('../src/domains/market-data/market-streaming.orchestrator', () => ({
      marketStreamingOrchestrator: { start, stop: vi.fn() },
    }));
    vi.doMock('../src/domains/market-data/market-data.service', () => ({
      startMarketSnapshotCache: vi.fn(),
      stopMarketSnapshotCache: vi.fn(),
    }));
    vi.doMock('../src/domains/charts/chart.service', () => ({
      startChartLiveService: vi.fn(),
      stopChartLiveService: vi.fn(),
    }));
    vi.doMock('../src/domains/assets/asset-metadata.service', () => ({
      assetMetadataService: { start: vi.fn(), stop: vi.fn() },
    }));

    const { startTickerCollector, stopTickerCollector } = await import('../src/jobs/tickerCollector');
    startTickerCollector();
    expect(start).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(start).toHaveBeenCalledWith({ includeTrades: false });

    await stopTickerCollector();
    vi.useRealTimers();
  });

  it('GET /market/tickers returns Upbit KRW ticker rows for first paint', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=10' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(body.data.items[0]).toMatchObject({
      market: expect.any(String),
      symbol: expect.any(String),
      quoteCurrency: 'KRW',
      koreanName: expect.any(String),
      englishName: expect.any(String),
      currentPrice: expect.any(Number),
      changeRate24h: expect.any(Number),
      signedChangePrice24h: expect.any(Number),
      accTradePrice24h: expect.any(Number),
      accTradeVolume24h: expect.any(Number),
      high24h: expect.any(Number),
      low24h: expect.any(Number),
      exchange: 'upbit',
      exchangeName: '업비트',
      exchangeSymbol: expect.any(String),
      displaySymbol: expect.any(String),
      displayName: expect.any(String),
      price: expect.any(Number),
      current: expect.any(Number),
      percent: expect.any(Number),
      volume24h: expect.any(Number),
      change24h: expect.any(Number),
      timestamp: expect.any(Number),
      sourceTimestamp: expect.any(Number),
      stale: false,
      sparkline: expect.any(Array),
      sparklinePoints: expect.any(Array),
      sparklineSource: expect.any(String),
      sparklineQuality: expect.any(String),
      sparklinePointCount: expect.any(Number),
      sparklineIsDerived: expect.any(Boolean),
      graphDisplayAllowed: expect.any(Boolean),
      previewGraphQuality: expect.any(String),
      previewGraphIsDerived: expect.any(Boolean),
      previewGraphPointCount: expect.any(Number),
      previewGraphRealSeries: false,
      previewGraphDisplayAllowed: expect.any(Boolean),
      previousPrice24h: expect.any(Number),
    });
    expect(body.data.meta).toMatchObject({
      sparklineTargetPointCount: 24,
      sparklineMissingCount: 0,
      sparklineUnavailableCount: expect.any(Number),
      nextCursor: null,
      hasNext: false,
    });
    expect(body.data.meta.sparklineAttachedCount + body.data.meta.sparklineUnavailableCount).toBe(body.data.items.length);
    expect(body.data.items[0].sparklinePoints.every((point: unknown) => typeof point === 'number')).toBe(true);
    if (body.data.items[0].sparklinePointCount < 2) {
      expect(body.data.items[0].sparklineSource).toBe('unavailable');
      expect(body.data.items[0].sparklineUnavailableReason).toEqual(expect.any(String));
      expect(body.data.items[0].graphDisplayAllowed).toBe(false);
    }

    await app.close();
  }, 15000);

  it('GET /market/tickers caps compatibility limits at 100', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=500' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.data.meta.requestedLimit).toBe(100);
    expect(body.data.items.length).toBeLessThanOrEqual(100);

    await app.close();
  }, 15000);

  it('GET /market/tickers does not fake a 24 point sparkline from currentPrice and changeRate24h', async () => {
    mockContractFetchWithTicker({
      trade_price: 110,
      signed_change_rate: 0.1,
      acc_trade_price_24h: 1000,
      acc_trade_volume_24h: 10,
      high_price: 120,
      low_price: 90,
      trade_timestamp: 1777809600000,
    });
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
    const body = JSON.parse(response.body);
    const ticker = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(ticker.sparklineSource).toBe('unavailable');
    expect(ticker.sparklineQuality).toBe('unavailable');
    expect(ticker.sparklineIsDerived).toBe(false);
    expect(ticker.previewGraphIsDerived).toBe(false);
    expect(ticker.previewGraphRealSeries).toBe(false);
    expect(ticker.graphDisplayAllowed).toBe(false);
    expect(ticker.sparkline).toHaveLength(0);
    expect(ticker.sparklinePoints).toHaveLength(0);
    expect(ticker.sparklinePoints).toEqual(ticker.sparkline);
    expect(ticker.sparklinePointCount).toBe(0);
    expect(ticker.sparklineUnavailableReason).toBe('provider_candle_unavailable');
    expect(ticker.previousPrice24h).toBeCloseTo(100);

    await app.close();
  }, 15000);

  it('GET /market/tickers returns unavailable instead of flat current-price backfill when only currentPrice exists', async () => {
    mockContractFetchWithTicker({
      trade_price: 100,
      acc_trade_price_24h: 1000,
      acc_trade_volume_24h: 10,
      high_price: 100,
      low_price: 100,
      trade_timestamp: 1777809600000,
    });
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
    const body = JSON.parse(response.body);
    const ticker = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(ticker.sparklineSource).toBe('unavailable');
    expect(ticker.sparklineQuality).toBe('unavailable');
    expect(ticker.sparklineIsDerived).toBe(false);
    expect(ticker.previewGraphIsDerived).toBe(false);
    expect(ticker.previewGraphRealSeries).toBe(false);
    expect(ticker.graphDisplayAllowed).toBe(false);
    expect(ticker.sparkline).toHaveLength(0);
    expect(ticker.sparklinePointCount).toBe(0);
    expect(ticker.sparklineUnavailableReason).toBe('provider_candle_unavailable');
    expect(ticker.previousPrice24h).toBeNull();

    await app.close();
  }, 15000);

  it('GET /market/tickers uses observed ring buffer points as lowInformation while warming', async () => {
    let price = 100;
    mockContractFetchWithTicker({
      get trade_price() {
        price += 1;
        return price;
      },
      signed_change_rate: 0.01,
      acc_trade_price_24h: 1000,
      acc_trade_volume_24h: 10,
      high_price: 110,
      low_price: 90,
      trade_timestamp: 1777809600000,
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
    const ticker = JSON.parse(response.body).data.items[0];

    expect(response.statusCode).toBe(200);
    expect(ticker.sparklineSource).toBe('ticker_ring_buffer');
    expect(ticker.sparklineQuality).toBe('lowInformation');
    expect(ticker.sparklinePointCount).toBe(2);
    expect(ticker.sparklineLowInformationReason).toBe('insufficient_history');
    expect(ticker.sparklineUnavailableReason).toBeNull();
    expect(ticker.sparkline).toHaveLength(2);
    expect(new Set(ticker.sparkline).size).toBe(2);
    expect(JSON.parse(response.body).data.meta.sparklineSummary).toMatchObject({
      targetPointCount: 24,
      lowInformation: 1,
      fallbackListSparkline: 0,
      missing: 0,
      warmup: true,
    });

    await app.close();
  }, 15000);

  it('GET /market/tickers returns cursor pagination metadata and next page sparklines', async () => {
    mockContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const firstResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc' });
    const first = JSON.parse(firstResponse.body).data;
    const nextCursor = first.meta.nextCursor;
    const secondResponse = await app.inject({ method: 'GET', url: `/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc&cursor=${encodeURIComponent(nextCursor)}` });
    const second = JSON.parse(secondResponse.body).data;

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(first.meta).toMatchObject({
      returnedCount: 1,
      hasNext: true,
      nextCursor: expect.any(String),
      sparklineTargetPointCount: 24,
      sparklineSummary: expect.objectContaining({
        targetPointCount: 24,
        missing: 0,
      }),
    });
    expect(second.meta.returnedCount).toBe(1);
    expect(second.meta.sparklineSummary).toEqual(expect.objectContaining({
      targetPointCount: 24,
      missing: 0,
    }));
    expect(second.items[0].canonicalMarketId).not.toBe(first.items[0].canonicalMarketId);
    expect(Array.isArray(second.items[0].sparklinePoints)).toBe(true);
    expect(second.items[0].sparklinePointCount >= 2 || second.items[0].sparklineUnavailableReason).toBeTruthy();

    await app.close();
  }, 15000);

  it('GET /market/tickers encodes cursor contract and rejects query/exchange mismatches', async () => {
    mockContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const firstResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc&query=KRW' });
    const first = JSON.parse(firstResponse.body).data;
    const cursorPayload = JSON.parse(Buffer.from(first.meta.nextCursor, 'base64url').toString('utf8'));

    expect(firstResponse.statusCode).toBe(200);
    expect(cursorPayload).toMatchObject({
      version: 1,
      exchange: 'upbit',
      quoteCurrency: 'KRW',
      sortKey: 'volume24h',
      sortDirection: 'desc',
      query: 'krw',
      lastCanonicalMarketId: first.items[0].canonicalMarketId,
      snapshotAt: expect.any(String),
    });

    const secondResponse = await app.inject({ method: 'GET', url: `/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc&query=KRW&cursor=${encodeURIComponent(first.meta.nextCursor)}` });
    const second = JSON.parse(secondResponse.body).data;
    expect(secondResponse.statusCode).toBe(200);
    expect(second.items[0].canonicalMarketId).not.toBe(first.items[0].canonicalMarketId);

    const queryMismatch = await app.inject({ method: 'GET', url: `/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc&query=ETH&cursor=${encodeURIComponent(first.meta.nextCursor)}` });
    expect(queryMismatch.statusCode).toBe(400);
    expect(JSON.parse(queryMismatch.body).error.code).toBe('INVALID_CURSOR');

    const exchangeMismatch = await app.inject({ method: 'GET', url: `/market/tickers?exchange=bithumb&quoteCurrency=KRW&limit=1&sortKey=volume24h&sortDirection=desc&query=KRW&cursor=${encodeURIComponent(first.meta.nextCursor)}` });
    expect(exchangeMismatch.statusCode).toBe(400);
    expect(JSON.parse(exchangeMismatch.body).error.code).toBe('INVALID_CURSOR');

    await app.close();
  }, 15000);

  it('GET /market/tickers applies stable sort tie-breakers and asc cursor pagination', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-CCC', korean_name: '씨씨씨', english_name: 'CCC' },
          { market: 'KRW-AAA', korean_name: '에이에이', english_name: 'AAA' },
          { market: 'KRW-BBB', korean_name: '비비비', english_name: 'BBB' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([
          { market: 'KRW-CCC', trade_price: 30, signed_change_rate: 0.01, signed_change_price: 1, acc_trade_price_24h: 1000, acc_trade_volume_24h: 1, high_price: 31, low_price: 29, trade_timestamp: 1777809600000 },
          { market: 'KRW-AAA', trade_price: 10, signed_change_rate: 0.01, signed_change_price: 1, acc_trade_price_24h: 1000, acc_trade_volume_24h: 1, high_price: 11, low_price: 9, trade_timestamp: 1777809600000 },
          { market: 'KRW-BBB', trade_price: 20, signed_change_rate: 0.01, signed_change_price: 1, acc_trade_price_24h: 1000, acc_trade_volume_24h: 1, high_price: 21, low_price: 19, trade_timestamp: 1777809600000 },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const firstResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=2&sortKey=volume24h&sortDirection=desc' });
    const first = JSON.parse(firstResponse.body).data;
    expect(first.items.map((item: any) => item.canonicalMarketId)).toEqual(['KRW-AAA', 'KRW-BBB']);

    const secondResponse = await app.inject({ method: 'GET', url: `/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=2&sortKey=volume24h&sortDirection=desc&cursor=${encodeURIComponent(first.meta.nextCursor)}` });
    const second = JSON.parse(secondResponse.body).data;
    expect(second.items.map((item: any) => item.canonicalMarketId)).toEqual(['KRW-CCC']);

    const ascFirstResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=price&sortDirection=asc' });
    const ascFirst = JSON.parse(ascFirstResponse.body).data;
    const ascSecondResponse = await app.inject({ method: 'GET', url: `/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1&sortKey=price&sortDirection=asc&cursor=${encodeURIComponent(ascFirst.meta.nextCursor)}` });
    const ascSecond = JSON.parse(ascSecondResponse.body).data;
    expect(ascFirst.items[0].canonicalMarketId).toBe('KRW-AAA');
    expect(ascSecond.items[0].canonicalMarketId).toBe('KRW-BBB');

    await app.close();
  }, 15000);

  it('GET /market/tickers returns unavailable sparkline when currentPrice is missing', async () => {
    mockContractFetchWithTicker({
      acc_trade_price_24h: 1000,
      acc_trade_volume_24h: 10,
      high_price: 100,
      low_price: 90,
      trade_timestamp: 1777809600000,
    });
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
    const body = JSON.parse(response.body);
    const ticker = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(ticker.currentPrice).toBeNull();
    expect(ticker.sparklineSource).toBe('unavailable');
    expect(ticker.sparklineQuality).toBe('unavailable');
    expect(ticker.sparklineIsDerived).toBe(false);
    expect(ticker.sparkline).toEqual([]);
    expect(ticker.sparklinePoints).toEqual([]);
    expect(ticker.sparklinePointCount).toBe(0);
    expect(ticker.sparklineUnavailableReason).toBeTruthy();
    expect(ticker.previewGraphQuality).toBe('unavailable');
    expect(ticker.previewGraphRealSeries).toBe(false);
    expect(ticker.graphDisplayAllowed).toBe(false);

    await app.close();
  }, 15000);

  it('GET /market/tickers does not call candles to build sparklines', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/candles')) {
        throw new Error('unexpected candle fetch');
      }
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100,
          signed_change_rate: 0.01,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 101,
          low_price: 99,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 500 });
    });
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/v1/candles'))).toBe(false);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns visible symbol batch rows', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=BTC,ETH&limit=20' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'KRW',
      interval: '1H',
      unsupportedSymbols: [],
      unavailableSymbols: ['BTC', 'ETH'],
    });
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toMatchObject({
      symbol: 'BTC',
      marketId: 'KRW-BTC',
      sparkline: expect.any(Array),
      sparklinePoints: expect.any(Array),
      sparklineSource: 'unavailable',
      sparklineQuality: 'unavailable',
      isRenderable: false,
      isDerived: false,
      realSeries: false,
      graphDisplayAllowed: false,
      pointCount: 0,
      sparklinePointCount: 0,
      stale: false,
      updatedAt: null,
    });

    await app.close();
  }, 15000);

  it('GET /market/sparkline does not call trades or orderbook providers', async () => {
    const fetchSpy = mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=BTC,ETH&limit=20' });

    expect(response.statusCode).toBe(200);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/trades'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/orderbook'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([input]) => String(input).includes('/v1/trades/ticks'))).toBe(false);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns prepared_cache from prepared ticker ring buffer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    let tickerCall = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        tickerCall += 1;
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100 + (tickerCall % 5) * 1.5 + (tickerCall % 3 === 0 ? 2.25 : 0),
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 120,
          low_price: 90,
          trade_timestamp: Date.now(),
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles') || url.includes('/trades') || url.includes('/orderbook')) {
        throw new Error(`sparkline must not call heavy provider: ${url}`);
      }
      return new Response(JSON.stringify({ error: 'unexpected path' }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (let index = 0; index < 20; index += 1) {
      vi.setSystemTime(1777809600000 + index * 60_000);
      const tickerResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' });
      expect(tickerResponse.statusCode).toBe(200);
    }
    vi.setSystemTime(1777809600000 + 20 * 60_000);
    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=KRW-BTC&interval=1H&limit=24' });
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.symbol).toBe('BTC');
    expect(item.marketId).toBe('KRW-BTC');
    expect(item.sparklineSource).toBe('prepared_cache');
    expect(item.sparklineQuality).toBe('liveDetailed');
    expect(item.isDerived).toBe(false);
    expect(item.realSeries).toBe(true);
    expect(item.graphDisplayAllowed).toBe(true);
    expect(item.sparklinePointCount).toBeGreaterThanOrEqual(20);
    expect(item.sparkline).toHaveLength(item.sparklinePointCount);
    expect(body.data.diagnostics.heavyPathUsed).toBe(false);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns 60 BIO/KRW prepared_cache points after buffer warm-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    mockExpandedMarketContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (let index = 0; index < 60; index += 1) {
      vi.setSystemTime(1777809600000 + index * 60_000);
      const tickerResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=10' });
      expect(tickerResponse.statusCode).toBe(200);
    }

    vi.setSystemTime(1777809600000 + 60 * 60_000);
    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BIO&limit=60&interval=1m' });
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(item).toMatchObject({
      exchange: 'upbit',
      symbol: 'BIO',
      baseCurrency: 'BIO',
      quoteCurrency: 'KRW',
      marketId: 'KRW-BIO',
      displayPair: 'BIO/KRW',
      pointCount: 60,
      sparklinePointCount: 60,
      source: 'prepared_cache',
      quality: 'liveDetailed',
      isDerived: false,
      realSeries: true,
      graphDisplayAllowed: true,
      recommendedDisplayScale: expect.any(Number),
      interval: '1M',
      requestedLimit: 60,
    });
    expect(item.points).toHaveLength(60);
    expect(item.diagnostics).toMatchObject({
      pointCount: 60,
      realSeries: true,
      graphDisplayAllowed: true,
      isFlat: false,
      isLinearDerived: false,
      resolvedBy: 'ring_buffer',
    });
    expect(item.diagnostics.uniqueValueCount).toBeGreaterThan(3);
    expect(item.diagnostics.valueRange).toBeGreaterThan(0);
    expect(item.diagnostics.rangeRatio).toBeGreaterThan(0);
    expect(item.diagnostics.recommendedDisplayScale).toBe(item.recommendedDisplayScale);
    expect(typeof item.diagnostics.directionChanges).toBe('number');
    expect(body.data.diagnostics).toMatchObject({
      requestedExchange: 'upbit',
      requestedQuoteCurrency: 'KRW',
      requestedCount: 1,
      returnedCount: 1,
      fallbackCount: 0,
      realSeriesCount: 1,
      displayAllowedCount: 1,
      unsupported: false,
      minPointCount: 60,
      maxPointCount: 60,
      heavyPathUsed: false,
    });
    expect(body.data.diagnostics.derivedCount).toBe(0);
    expect(body.data.diagnostics.qualities.liveDetailed).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline downgrades 60 flat provider points instead of reporting prepared quality', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 120,
          low_price: 90,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => ({
          candle_date_time_utc: new Date(1777809600000 - index * 60_000).toISOString().replace('.000Z', ''),
          opening_price: 100,
          high_price: 100,
          low_price: 100,
          trade_price: 100,
          candle_acc_trade_volume: 1,
          candle_acc_trade_price: 100,
        }))), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m' });
    const item = JSON.parse(response.body).data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.pointCount).toBe(60);
    expect(item.quality).toBe('insufficient_variation');
    expect(item.realSeries).toBe(false);
    expect(item.isDerived).toBe(false);
    expect(item.graphDisplayAllowed).toBe(false);
    expect(['prepared_cache', 'refined_mini', 'provider_mini']).not.toContain(item.quality);
    expect(item.diagnostics).toMatchObject({
      uniqueValueCount: 1,
      valueRange: 0,
      isFlat: true,
      realSeries: false,
      graphDisplayAllowed: false,
    });

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns provider candle real series when the ring buffer is cold', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 130,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 140,
          low_price: 90,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const forward = 59 - index;
          const close = 100 + (forward % 7) * 2 + (forward % 4 === 0 ? 5 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 - index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close - 1,
            high_price: close + 2,
            low_price: close - 2,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m' });
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.pointCount).toBe(60);
    expect(item.quality).toBe('liveDetailed');
    expect(item.source).toBe('provider_candle_1m');
    expect(item.isDerived).toBe(false);
    expect(item.realSeries).toBe(true);
    expect(item.graphDisplayAllowed).toBe(true);
    expect(item.recommendedDisplayScale).toBe(item.diagnostics.recommendedDisplayScale);
    expect(item.diagnostics.uniqueValueCount).toBeGreaterThan(3);
    expect(item.diagnostics.valueRange).toBeGreaterThan(0);
    expect(item.diagnostics.resolvedBy).toBe('provider_candle');
    expect(body.data.diagnostics.qualities.liveDetailed).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline reuses cached full real 60pt without a second provider fetch', async () => {
    let candleCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 130,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 140,
          low_price: 90,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        candleCalls += 1;
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const close = 100 + (index % 9) * 1.5 + (index % 4 === 0 ? 3 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 + index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close - 1,
            high_price: close + 2,
            low_price: close - 2,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const first = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m' });
    const second = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m' });
    const secondItem = JSON.parse(second.body).data.items[0];

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(candleCalls).toBe(1);
    expect(secondItem.pointCount).toBe(60);
    expect(secondItem.realSeries).toBe(true);
    expect(secondItem.graphDisplayAllowed).toBe(true);
    expect(secondItem.diagnostics.cacheHit).toBe(true);
    expect(secondItem.diagnostics.cacheKey).toBe('upbit:KRW:KRW-BTC');
    expect(secondItem.diagnostics.decision).toBe('cache_full');
    expect(secondItem.diagnostics.cacheWriteDecision).toBe('write');
    expect(JSON.parse(second.body).data.diagnostics.cacheHitCount).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline priority=top returns stale full real cache as displayable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    let candleCalls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 130,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 140,
          low_price: 90,
          trade_timestamp: Date.now(),
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        candleCalls += 1;
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const close = 100 + (index % 8) * 1.25 + (index % 5 === 0 ? 2 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 + index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close - 1,
            high_price: close + 2,
            low_price: close - 2,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const first = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top' });
    vi.setSystemTime(1777809600000 + 61_000);
    const second = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top' });
    const secondBody = JSON.parse(second.body);
    const item = secondBody.data.items[0];

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(candleCalls).toBe(1);
    expect(item.pointCount).toBe(60);
    expect(item.realSeries).toBe(true);
    expect(item.graphDisplayAllowed).toBe(true);
    expect(item.diagnostics.cacheHit).toBe(true);
    expect(item.diagnostics.stale).toBe(true);
    expect(item.diagnostics.decision).toBe('cache_stale_full');
    expect(item.diagnostics.cacheKey).toBe('upbit:KRW:KRW-BTC');
    expect(item.quality).toBe('staleRealSeries');
    expect(secondBody.data.diagnostics.staleCacheHitCount).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns unavailable on provider timeout when no partial exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 120,
          low_price: 90,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Promise<Response>(() => undefined);
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const pending = app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top' });
    await vi.advanceTimersByTimeAsync(900);
    const response = await pending;
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(body.data.diagnostics.priority).toBe('top');
    expect(body.data.diagnostics.timeoutMs).toBe(1200);
    expect(body.data.diagnostics.elapsedMs).toBeLessThanOrEqual(1200);
    expect(item.quality).toBe('unavailable');
    expect(item.graphDisplayAllowed).toBe(false);
    expect(item.diagnostics.decision).toBe('timeout_unavailable');
    expect(item.diagnostics.cacheKey).toBe('upbit:KRW:KRW-BTC');
    expect(item.diagnostics.cacheWriteDecision).toBeNull();
    expect(item.diagnostics.providerTimeout).toBe(true);
    expect(item.diagnostics.fallbackReason).toBe('provider_timeout');
    expect(body.data.diagnostics.providerTimeoutCount).toBe(1);
    expect(body.data.diagnostics.displayAllowedCount).toBe(0);
    expect(body.data.diagnostics.quoteMismatchCount).toBe(0);

    await app.close();
  }, 15000);

  it('GET /market/sparkline priority=top returns ring partial when provider times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        const step = Math.max(0, Math.floor((Date.now() - 1777809600000) / 60_000));
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100 + (step % 5) * 1.7 + (step % 3 === 0 ? 2.3 : 0),
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 120,
          low_price: 90,
          trade_timestamp: Date.now(),
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Promise<Response>(() => undefined);
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (let index = 0; index < 8; index += 1) {
      vi.setSystemTime(1777809600000 + index * 60_000);
      expect((await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' })).statusCode).toBe(200);
    }
    vi.setSystemTime(1777809600000 + 8 * 60_000);
    const pending = app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top' });
    await vi.advanceTimersByTimeAsync(900);
    const response = await pending;
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.pointCount).toBe(9);
    expect(item.quality).toBe('liveDetailed');
    expect(item.realSeries).toBe(true);
    expect(item.graphDisplayAllowed).toBe(true);
    expect(item.diagnostics.decision).toBe('timeout_with_partial');
    expect(item.diagnostics.cacheKey).toBe('upbit:KRW:KRW-BTC');
    expect(item.diagnostics.cacheWriteDecision).toBe('write');
    expect(item.diagnostics.graphDisplayAllowedReason).toBe('partial_real_series');
    expect(item.diagnostics.coverageRatio).toBeCloseTo(9 / 60);
    expect(body.data.diagnostics.partialCount).toBe(1);
    expect(body.data.diagnostics.providerTimeoutCount).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline priority=top does not let one timed-out item block provider full items', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
          { market: 'KRW-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
          { market: 'KRW-XRP', korean_name: '리플', english_name: 'XRP' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        const request = new URL(url);
        const markets = request.searchParams.get('markets')?.split(',') ?? [];
        return new Response(JSON.stringify(markets.map((market, index) => ({
          market,
          trade_price: 100 + index,
          signed_change_rate: 0.01,
          signed_change_price: 1,
          acc_trade_price_24h: 1000 - index,
          acc_trade_volume_24h: 10,
          high_price: 120,
          low_price: 90,
          trade_timestamp: Date.now(),
        }))), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        const request = new URL(url);
        const market = request.searchParams.get('market');
        if (market === 'KRW-BTC') {
          return new Promise<Response>(() => undefined);
        }
        const offset = market === 'KRW-ETH' ? 10 : 20;
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const close = 100 + offset + (index % 7) * 1.4 + (index % 4 === 0 ? 3 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 + index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close - 1,
            high_price: close + 2,
            low_price: close - 2,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const pending = app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC,KRW-ETH,KRW-XRP&limit=60&interval=1m&priority=top' });
    await vi.advanceTimersByTimeAsync(900);
    const response = await pending;
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.data.diagnostics.elapsedMs).toBeLessThanOrEqual(1200);
    expect(body.data.diagnostics.fullCount).toBe(2);
    expect(body.data.diagnostics.unavailableCount).toBe(1);
    expect(body.data.items.find((item: any) => item.marketId === 'KRW-BTC').diagnostics.decision).toBe('timeout_unavailable');
    expect(body.data.items.find((item: any) => item.marketId === 'KRW-ETH').diagnostics.decision).toBe('provider_full');
    expect(body.data.items.find((item: any) => item.marketId === 'KRW-XRP').diagnostics.decision).toBe('provider_full');

    await app.close();
  }, 15000);

  it('GET /market/sparkline calculates display scale from rangeRatio', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        return new Response(JSON.stringify([{
          market: 'KRW-BTC',
          trade_price: 100.1,
          signed_change_rate: 0.01,
          signed_change_price: 0.1,
          acc_trade_price_24h: 1000,
          acc_trade_volume_24h: 10,
          high_price: 101,
          low_price: 99,
          trade_timestamp: 1777809600000,
        }]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const forward = 59 - index;
          const close = 100 + (forward % 5) * 0.03 + (forward % 3 === 0 ? 0.02 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 - index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close,
            high_price: close + 0.01,
            low_price: close - 0.01,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m' });
    const item = JSON.parse(response.body).data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.realSeries).toBe(true);
    expect(item.graphDisplayAllowed).toBe(true);
    expect(item.diagnostics.rangeRatio).toBeLessThan(0.002);
    expect(item.recommendedDisplayScale).toBe(0.25);
    expect(item.diagnostics.recommendedDisplayScale).toBe(0.25);
    expect(item.diagnostics.volatilityHint).toBe('low');

    await app.close();
  }, 15000);

  it('GET /market/tickers schedules warm-up logs for top volume markets when enabled', async () => {
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
            trade_price: 100,
            signed_change_rate: 0.01,
            signed_change_price: 1,
            acc_trade_price_24h: 2000,
            acc_trade_volume_24h: 10,
            high_price: 120,
            low_price: 90,
            trade_timestamp: 1777809600000,
          },
          {
            market: 'KRW-ETH',
            trade_price: 80,
            signed_change_rate: 0.01,
            signed_change_price: 1,
            acc_trade_price_24h: 1000,
            acc_trade_volume_24h: 10,
            high_price: 120,
            low_price: 70,
            trade_timestamp: 1777809600000,
          },
        ]), { status: 200 });
      }
      if (url.includes('/v1/candles/minutes/1')) {
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const close = 100 + (index % 7) * 1.1 + (index % 5 === 0 ? 2 : 0);
          return {
            candle_date_time_utc: new Date(1777809600000 + index * 60_000).toISOString().replace('.000Z', ''),
            opening_price: close,
            high_price: close + 1,
            low_price: close - 1,
            trade_price: close,
            candle_acc_trade_volume: 1,
            candle_acc_trade_price: close,
          };
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0', SPARKLINE_WARMUP_ENABLED: 'true' });
    const { logger } = await import('../src/utils/logger');
    const logSpy = vi.spyOn(logger, 'info');

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=2' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(response.statusCode).toBe(200);
    expect(logSpy.mock.calls.some((call) => String(call[1] ?? '').includes('[SparklineWarmupQueued]'))).toBe(true);
    expect(logSpy.mock.calls.some((call) => String(call[1] ?? '').includes('[SparklineWarmupStored]'))).toBe(true);

    await app.close();
  }, 15000);

  it('GET /market/sparkline resolves Binance USDT marketIds and uses 1m klines as real series', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v3/exchangeInfo') {
        return new Response(JSON.stringify({
          symbols: [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING' },
          ],
        }), { status: 200 });
      }
      if (url.pathname === '/api/v3/ticker/24hr') {
        const markets = JSON.parse(url.searchParams.get('symbols') ?? '[]') as string[];
        return new Response(JSON.stringify(markets.map((symbol, index) => ({
          symbol,
          lastPrice: String(100 + index),
          priceChangePercent: '1.2',
          quoteVolume: String(1000 - index),
          volume: String(10 + index),
          highPrice: '110',
          lowPrice: '90',
          closeTime: 1777809600000,
        }))), { status: 200 });
      }
      if (url.pathname === '/api/v3/klines') {
        const symbol = url.searchParams.get('symbol') ?? 'BTCUSDT';
        const offset = symbol === 'BTCUSDT' ? 0 : symbol === 'ETHUSDT' ? 10 : 20;
        return new Response(JSON.stringify(Array.from({ length: 60 }, (_, index) => {
          const close = 100 + offset + (index % 7) * 1.25 + (index % 4 === 0 ? 2 : 0);
          return [
            1777809600000 + index * 60_000,
            String(close - 0.5),
            String(close + 1),
            String(close - 1),
            String(close),
            '10',
            1777809659999 + index * 60_000,
            String(close * 10),
            10,
            '5',
            String(close * 5),
            '0',
          ];
        })), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url: String(url) }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=binance&quoteCurrency=USDT&marketIds=BTCUSDT,ETHUSDT,SOLUSDT&limit=60&interval=1m' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.data.items.map((item: any) => item.marketId)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(body.data.items.every((item: any) => item.quoteCurrency === 'USDT')).toBe(true);
    expect(body.data.items.every((item: any) => item.source === 'provider_candle_1m')).toBe(true);
    expect(body.data.items.every((item: any) => item.realSeries === true)).toBe(true);
    expect(body.data.items.every((item: any) => item.graphDisplayAllowed === true)).toBe(true);
    expect(body.data.diagnostics.realSeriesCount).toBe(3);
    expect(body.data.diagnostics.displayAllowedCount).toBe(3);

    await app.close();
  }, 15000);

  it('GET /market/sparkline keeps Binance quote-specific marketIds isolated and reports quote mismatches', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=binance&quoteCurrency=BTC&marketIds=BTCUSDT,ETHBTC&limit=60&interval=1m' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      marketId: 'ETHBTC',
      symbol: 'ETH',
      quoteCurrency: 'BTC',
    });
    expect(body.data.unsupportedSymbols).toEqual(['BTCUSDT']);
    expect(body.data.diagnostics.unsupportedDetails).toContainEqual({
      input: 'BTCUSDT',
      symbol: 'BTC',
      marketId: 'BTCUSDT',
      reason: 'quote_currency_mismatch',
      resolvedBy: 'marketId',
    });
    expect(body.data.diagnostics.quoteMismatchCount).toBe(1);
    expect(body.data.diagnostics.resolveFailedCount).toBe(0);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns unavailable when only derived preview points exist', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=BTC&limit=24' });
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.sparklineSource).toBe('unavailable');
    expect(item.sparklineQuality).toBe('unavailable');
    expect(item.isDerived).toBe(false);
    expect(item.sparklinePointCount).toBe(0);
    expect(item.realSeries).toBe(false);
    expect(item.graphDisplayAllowed).toBe(false);
    expect(['prepared_cache', 'refined_mini', 'provider_mini']).not.toContain(item.sparklineQuality);
    expect(item.diagnostics).toMatchObject({
      pointCount: 0,
      uniqueValueCount: 0,
      valueRange: 0,
      directionChanges: expect.any(Number),
      linearityScore: expect.any(Number),
      realSeries: false,
      graphDisplayAllowed: false,
    });
    expect(body.data.diagnostics.derivedCount).toBe(0);
    expect(body.data.diagnostics.unavailableCount).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline returns unsupported diagnostics for Upbit USDT', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=USDT&symbols=BTC&limit=60' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'USDT',
      supportedQuotes: ['KRW', 'BTC'],
      defaultQuoteCurrency: 'KRW',
      items: [],
    });
    expect(body.data.diagnostics).toMatchObject({
      requestedExchange: 'upbit',
      requestedQuoteCurrency: 'USDT',
      requestedCount: 1,
      returnedCount: 0,
      unsupported: true,
      reason: 'quote_currency_not_supported',
      heavyPathUsed: false,
    });

    await app.close();
  }, 15000);

  it('GET /market/sparkline resolves marketIds before symbols when both are provided', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=BTC&marketIds=KRW-BIO&limit=24' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0]).toMatchObject({
      symbol: 'BIO',
      marketId: 'KRW-BIO',
      quoteCurrency: 'KRW',
      displayPair: 'BIO/KRW',
    });
    expect(body.data.items[0].diagnostics.fallbackReason).toBe('provider_unavailable');
    expect(body.data.diagnostics.requestedCount).toBe(1);

    await app.close();
  }, 15000);

  it('GET /market/sparkline rejects wildcard symbol requests', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=all' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('WILDCARD_SYMBOLS_UNSUPPORTED');

    await app.close();
  }, 15000);

  it('GET /market/sparkline rejects symbol batches over the cap', async () => {
    mockContractFetch();
    const app = await createApp();
    const symbols = Array.from({ length: 51 }, (_, index) => `S${index}`).join(',');

    const response = await app.inject({ method: 'GET', url: `/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=${symbols}` });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('SYMBOLS_LIMIT_EXCEEDED');

    await app.close();
  }, 15000);

  it('GET /market/tickers returns Upbit BTC quote ticker rows', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=BTC&limit=10' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.items)).toBe(true);
    expect(body.data.items[0]).toMatchObject({
      market: 'BTC-ETH',
      symbol: 'ETH',
      quoteCurrency: 'BTC',
      price: expect.any(Number),
      priceDisplayHint: {
        quoteCurrency: 'BTC',
        recommendedMaxFractionDigits: 10,
        recommendedSignificantDigits: 6,
        compactNotationAllowed: false,
      },
    });
    expect(body.data.items[0].price).toBeGreaterThan(0);
    expect(body.data.items[0].price).toBeLessThan(1);
    expect(body.data.meta.quoteDisplayHint).toMatchObject({
      quoteCurrency: 'BTC',
      recommendedMaxFractionDigits: 10,
      recommendedSignificantDigits: 6,
    });

    await app.close();
  }, 15000);

  it('does not advertise Upbit USDT and returns unsupported diagnostics for Upbit USDT tickers', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    const exchangesResponse = await app.inject({ method: 'GET', url: '/market/exchanges' });
    const upbit = JSON.parse(exchangesResponse.body).data.items.find((item: any) => item.exchange === 'upbit');
    expect(upbit).toMatchObject({
      supportedQuotes: ['KRW', 'BTC'],
      defaultQuoteCurrency: 'KRW',
    });
    expect(upbit.supportedQuotes).not.toContain('USDT');

    const unsupportedResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=USDT' });
    const unsupported = JSON.parse(unsupportedResponse.body);
    expect(unsupportedResponse.statusCode).toBe(200);
    expect(unsupported.success).toBe(true);
    expect(unsupported.data).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'USDT',
      supportedQuotes: ['KRW', 'BTC'],
      defaultQuoteCurrency: 'KRW',
      items: [],
    });
    expect(unsupported.data.diagnostics).toMatchObject({
      requestedExchange: 'upbit',
      requestedQuoteCurrency: 'USDT',
      supportedQuotes: ['KRW', 'BTC'],
      defaultQuoteCurrency: 'KRW',
      unsupported: true,
      reason: 'quote_currency_not_supported',
    });

    await app.close();
  }, 15000);

  it('keeps Upbit KRW/BTC quote rows isolated and normalizes KRW-BTC as BTC/KRW', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    const krwResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=10' });
    const krw = JSON.parse(krwResponse.body).data;
    expect(krw.items.every((item: any) => item.exchange === 'upbit' && item.quoteCurrency === 'KRW')).toBe(true);
    expect(krw.items.every((item: any) => item.displayPair.endsWith('/KRW'))).toBe(true);
    expect(krw.items.find((item: any) => item.marketId === 'KRW-BTC')).toMatchObject({
      symbol: 'BTC',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      displayPair: 'BTC/KRW',
    });
    expect(krw.items.every((item: any) => item.marketId.startsWith('KRW-'))).toBe(true);

    const btcResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=BTC&limit=10' });
    const btc = JSON.parse(btcResponse.body).data;
    expect(btc.items.every((item: any) => item.exchange === 'upbit' && item.quoteCurrency === 'BTC')).toBe(true);
    expect(btc.items.every((item: any) => item.displayPair.endsWith('/BTC'))).toBe(true);
    expect(btc.items.every((item: any) => item.marketId.startsWith('BTC-'))).toBe(true);
    expect(btc.items.some((item: any) => item.marketId === 'KRW-BTC')).toBe(false);

    const krwSparkline = JSON.parse((await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60' })).body).data.items[0];
    expect(krwSparkline).toMatchObject({
      symbol: 'BTC',
      marketId: 'KRW-BTC',
      displayPair: 'BTC/KRW',
      quoteCurrency: 'KRW',
    });

    await app.close();
  }, 15000);

  it('returns supported quote metadata and unsupported diagnostics', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    const exchangesResponse = await app.inject({ method: 'GET', url: '/market/exchanges' });
    const exchanges = JSON.parse(exchangesResponse.body).data.items;
    expect(exchanges.find((item: any) => item.exchange === 'coinone')).toMatchObject({
      supportedQuotes: ['KRW'],
      defaultQuoteCurrency: 'KRW',
      status: 'active',
    });
    expect(exchanges.find((item: any) => item.exchange === 'binance')).toMatchObject({
      supportedQuotes: ['USDT', 'BTC', 'ETH'],
      defaultQuoteCurrency: 'USDT',
    });

    const unsupportedResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=coinone&quoteCurrency=BTC' });
    const unsupported = JSON.parse(unsupportedResponse.body);
    expect(unsupportedResponse.statusCode).toBe(200);
    expect(unsupported.success).toBe(true);
    expect(unsupported.data.items).toEqual([]);
    expect(unsupported.data.diagnostics).toMatchObject({
      requestedExchange: 'coinone',
      requestedQuoteCurrency: 'BTC',
      unsupported: true,
      reason: 'quote_currency_not_supported',
    });

    await app.close();
  }, 15000);

  it('loads Coinone, Korbit, Bithumb, and Binance ticker contracts with consistent quote fields', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp();

    for (const url of [
      '/market/tickers?exchange=bithumb&quoteCurrency=KRW&limit=2',
      '/market/tickers?exchange=bithumb&quoteCurrency=BTC&limit=2',
      '/market/tickers?exchange=coinone&quoteCurrency=KRW&limit=2',
      '/market/tickers?exchange=korbit&quoteCurrency=KRW&limit=2',
      '/market/tickers?exchange=binance&limit=2',
      '/market/tickers?exchange=binance&quoteCurrency=BTC&limit=2',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      const body = JSON.parse(response.body);
      expect(response.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.items.length).toBeGreaterThan(0);
      expect(body.data.items.every((item: any) => item.exchange === body.data.exchange)).toBe(true);
      expect(body.data.items.every((item: any) => item.quoteCurrency === body.data.quoteCurrency)).toBe(true);
      expect(body.data.items.every((item: any) => item.displayPair.endsWith(`/${body.data.quoteCurrency}`))).toBe(true);
      expect(body.data.diagnostics.unsupported).toBe(false);
    }

    const binanceKrw = await app.inject({ method: 'GET', url: '/market/tickers?exchange=binance&quoteCurrency=KRW' });
    const unsupported = JSON.parse(binanceKrw.body).data;
    expect(unsupported.items).toEqual([]);
    expect(unsupported.diagnostics).toMatchObject({
      unsupported: true,
      reason: 'quote_currency_not_supported',
    });

    await app.close();
  }, 15000);

  it('GET /market/sparkline resolves Bithumb, Coinone, and Korbit ticker marketIds directly', async () => {
    mockExpandedMarketContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (const exchange of ['bithumb', 'coinone', 'korbit']) {
      const tickersResponse = await app.inject({ method: 'GET', url: `/market/tickers?exchange=${exchange}&quoteCurrency=KRW&limit=1` });
      const ticker = JSON.parse(tickersResponse.body).data.items[0];
      const sparklineResponse = await app.inject({ method: 'GET', url: `/market/sparkline?exchange=${exchange}&quoteCurrency=KRW&symbols=ETH&marketIds=${ticker.marketId}&limit=60&interval=1m` });
      const sparkline = JSON.parse(sparklineResponse.body).data;

      expect(sparklineResponse.statusCode).toBe(200);
      expect(sparkline.items).toHaveLength(1);
      expect(sparkline.items[0]).toMatchObject({
        exchange,
        marketId: ticker.marketId,
        symbol: ticker.symbol,
        quoteCurrency: 'KRW',
        displayPair: `${ticker.symbol}/KRW`,
      });
      expect(sparkline.items[0].diagnostics.resolvedBy).toBeTruthy();
      if (exchange === 'bithumb') {
        expect(sparkline.items[0].diagnostics.providerMarket).toBe(ticker.marketId);
      } else if (exchange === 'coinone') {
        expect(sparkline.items[0].diagnostics.providerMarket).toBe(ticker.symbol);
        expect(sparkline.items[0].diagnostics.cacheKey).toBe(`coinone:KRW:${ticker.marketId}`);
      } else if (exchange === 'korbit') {
        expect(sparkline.items[0].diagnostics.providerMarket).toBe(`${ticker.symbol.toLowerCase()}_krw`);
        expect(sparkline.items[0].diagnostics.cacheKey).toBe(`korbit:KRW:${ticker.marketId}`);
      }
      expect(sparkline.unsupportedSymbols).toEqual([]);
    }

    await app.close();
  }, 15000);

  it('Coinone and Korbit KRW stale real cache stays displayable after the fast cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/public/v2/chart/KRW/BTC')) {
        return new Response(JSON.stringify({
          chart: Array.from({ length: 60 }, (_, index) => ({
            timestamp: 1777809600000 + index * 60_000,
            open: 100 + index,
            high: 102 + index,
            low: 99 + index,
            close: 100 + (index % 9) * 1.5 + (index % 4 === 0 ? 2 : 0),
            volume: 10,
            quote_volume: 1000,
          })),
        }), { status: 200 });
      }
      if (url.includes('/v2/candles')) {
        return new Response(JSON.stringify({
          data: Array.from({ length: 60 }, (_, index) => ({
            timestamp: 1777809600000 + index * 60_000,
            open: 50 + index,
            high: 52 + index,
            low: 49 + index,
            close: 50 + (index % 7) * 1.2 + (index % 5 === 0 ? 1.7 : 0),
            volume: 10,
            quoteVolume: 1000,
          })),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (const exchange of ['coinone', 'korbit']) {
      vi.setSystemTime(1777809600000);
      const first = await app.inject({ method: 'GET', url: `/market/sparkline?exchange=${exchange}&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top` });
      expect(first.statusCode).toBe(200);
      expect(JSON.parse(first.body).data.items[0]).toMatchObject({
        marketId: 'KRW-BTC',
        quoteCurrency: 'KRW',
        realSeries: true,
        graphDisplayAllowed: true,
      });

      vi.setSystemTime(1777809600000 + 61_000);
      const second = await app.inject({ method: 'GET', url: `/market/sparkline?exchange=${exchange}&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60&interval=1m&priority=top` });
      const item = JSON.parse(second.body).data.items[0];

      expect(second.statusCode).toBe(200);
      expect(item.marketId).toBe('KRW-BTC');
      expect(item.quality).toBe('staleRealSeries');
      expect(item.realSeries).toBe(true);
      expect(item.graphDisplayAllowed).toBe(true);
      expect(item.diagnostics.decision).toBe('cache_stale_full');
      expect(item.diagnostics.cacheKey).toBe(`${exchange}:KRW:KRW-BTC`);
      expect(item.diagnostics.providerMarket).toBe(exchange === 'coinone' ? 'BTC' : 'btc_krw');
    }

    await app.close();
  }, 15000);

  it('uses exchange + quoteCurrency + marketId for sparkline buffers and does not share symbols across exchanges', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1777809600000);
    mockExpandedMarketContractFetch();
    const app = await createApp({ TICKER_CACHE_TTL_SECONDS: '0' });

    for (let index = 0; index < 20; index += 1) {
      vi.setSystemTime(1777809600000 + index * 60_000);
      expect((await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=KRW&limit=1' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/market/tickers?exchange=bithumb&quoteCurrency=KRW&limit=1' })).statusCode).toBe(200);
    }

    const upbitSparkline = JSON.parse((await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60' })).body).data.items[0];
    const bithumbSparkline = JSON.parse((await app.inject({ method: 'GET', url: '/market/sparkline?exchange=bithumb&quoteCurrency=KRW&marketIds=KRW-BTC&limit=60' })).body).data.items[0];

    expect(upbitSparkline.exchange).toBe('upbit');
    expect(bithumbSparkline.exchange).toBe('bithumb');
    expect(upbitSparkline.marketId).toBe('KRW-BTC');
    expect(bithumbSparkline.marketId).toBe('KRW-BTC');
    expect(upbitSparkline.pointCount).toBeGreaterThanOrEqual(20);
    expect(bithumbSparkline.pointCount).toBeGreaterThanOrEqual(20);
    expect(upbitSparkline.quality).toBe('liveDetailed');
    expect(bithumbSparkline.quality).toBe('liveDetailed');
    expect(upbitSparkline.isDerived).toBe(false);
    expect(bithumbSparkline.isDerived).toBe(false);

    await app.close();
  }, 15000);

  it('GET /market/candles returns candles for base symbols', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=1H&limit=2' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.candles)).toBe(true);
    expect(body.data.candles.length).toBeGreaterThan(0);
    expect(body.data).toMatchObject({
      exchange: 'upbit',
      symbol: 'BTC',
      quoteCurrency: 'KRW',
      market: 'KRW-BTC',
      timeframe: '1H',
    });

    await app.close();
  }, 15000);

  it('GET /market/candles normalizes provider market ids to base symbols', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=KRW-BTC&quoteCurrency=KRW&timeframe=1H&limit=2' });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      symbol: 'BTC',
      market: 'KRW-BTC',
      displaySymbol: 'BTC/KRW',
    });
    expect(Array.isArray(body.data.candles)).toBe(true);

    await app.close();
  }, 15000);

  it('GET /market/candles handles BTC quote market ids without crashing', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=BTC-ETH&quoteCurrency=BTC&timeframe=1H&limit=2' });
    const body = JSON.parse(response.body);

    expect([200, 400, 404, 503]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.candles)).toBe(true);
      expect(body.data.symbol).toBe('ETH');
    } else {
      expect(body.success).toBe(false);
      expect(body.code).toEqual(expect.any(String));
    }

    await app.close();
  }, 15000);

  it('returns last-known-good candles when a repeated candle request hits a provider failure', async () => {
    mockContractFetch();
    const app = await createApp({ CANDLE_CACHE_TTL_SECONDS: '0' });

    const first = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=1H&limit=2' });
    expect(first.statusCode).toBe(200);
    expect(JSON.parse(first.body).data.candles.length).toBeGreaterThan(0);

    vi.mocked(global.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/candles/minutes/60')) {
        return new Response('rate limit', { status: 429 });
      }
      return new Response(JSON.stringify([
        {
          market: 'KRW-BTC',
          trade_price: 101000000,
          signed_change_rate: 0.0123,
          signed_change_price: 1230000,
          acc_trade_price_24h: 987654321000,
          acc_trade_volume_24h: 9876,
          high_price: 102000000,
          low_price: 99000000,
          trade_timestamp: 1777809600000,
        },
      ]), { status: 200 });
    });

    const second = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=1H&limit=2' });
    const body = JSON.parse(second.body);

    expect(second.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('stale');
    expect(body.data.meta).toMatchObject({
      freshnessState: 'stale',
      source: 'last_known_good',
      pointCount: 2,
    });
    expect(body.data.candles.length).toBe(2);

    await app.close();
  }, 15000);

  it('returns stable 400 codes for invalid quoteCurrency and timeframe', async () => {
    mockContractFetch();
    const app = await createApp();

    const invalidQuote = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=USD&limit=10' });
    expect(invalidQuote.statusCode).toBe(400);
    expect(JSON.parse(invalidQuote.body)).toMatchObject({
      success: false,
      code: 'INVALID_QUOTE_CURRENCY',
    });

    const invalidTimeframe = await app.inject({ method: 'GET', url: '/market/candles?exchange=upbit&symbol=BTC&quoteCurrency=KRW&timeframe=2H&limit=2' });
    expect(invalidTimeframe.statusCode).toBe(400);
    expect(JSON.parse(invalidTimeframe.body)).toMatchObject({
      success: false,
      code: 'INVALID_TIMEFRAME',
    });

    await app.close();
  }, 15000);
});
