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
        { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      const request = new URL(url);
      const markets = request.searchParams.get('markets')?.split(',') ?? [];
      return new Response(JSON.stringify(markets.map((market, index) => ({
        market,
        trade_price: market.startsWith('BTC-') ? 0.03 + index * 0.001 : 100000000 + index * 100000,
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
        { market: 'BTC-ETH', korean_name: '이더리움', english_name: 'Ethereum' },
        { market: 'BTC-XRP', korean_name: '리플', english_name: 'XRP' },
      ]), { status: 200 });
    }
    if (url.includes('/v1/ticker')) {
      const request = new URL(url);
      const markets = request.searchParams.get('markets')?.split(',') ?? [];
      return new Response(JSON.stringify(markets.map((market, index) => ({
        market,
        trade_price: market.startsWith('BTC-') ? 0.03 + index * 0.001 : 100000000 + index * 100000,
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
      return new Response(JSON.stringify({
        tickers: [
          { quote_currency: 'krw', target_currency: 'btc', timestamp: Date.now(), high: '101', low: '90', first: '95', last: '100', quote_volume: '1000', target_volume: '10', yesterday_last: '95' },
          { quote_currency: 'krw', target_currency: 'eth', timestamp: Date.now(), high: '51', low: '40', first: '45', last: '50', quote_volume: '900', target_volume: '20', yesterday_last: '45' },
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
      previousPrice24h: expect.any(Number),
    });
    expect(body.data.items[0].sparkline).toHaveLength(6);
    expect(body.data.items[0].sparklinePoints).toHaveLength(6);
    expect(body.data.items[0].sparklineSource).toBe('derived_change24h');
    expect(body.data.items[0].sparklineQuality).toBe('derived_preview');
    expect(body.data.items[0].sparklineIsDerived).toBe(true);

    await app.close();
  }, 15000);

  it('GET /market/tickers derives a 6 point sparkline from currentPrice and changeRate24h', async () => {
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
    expect(ticker.sparklineSource).toBe('derived_change24h');
    expect(ticker.sparklineQuality).toBe('derived_preview');
    expect(ticker.sparklineIsDerived).toBe(true);
    expect(ticker.sparkline).toHaveLength(6);
    expect(ticker.sparklinePoints).toHaveLength(6);
    expect(ticker.sparklinePointCount).toBe(6);
    expect(ticker.previousPrice24h).toBeCloseTo(100);
    expect(ticker.sparkline[0]).toBeCloseTo(100);
    expect(ticker.sparkline[5]).toBe(110);

    await app.close();
  }, 15000);

  it('GET /market/tickers returns flat_current sparkline when only currentPrice exists', async () => {
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
    expect(ticker.sparklineSource).toBe('flat_current');
    expect(ticker.sparklineQuality).toBe('flat_current');
    expect(ticker.sparklineIsDerived).toBe(false);
    expect(ticker.sparkline).toEqual([100, 100, 100, 100, 100, 100]);
    expect(ticker.sparklinePointCount).toBe(6);
    expect(ticker.previousPrice24h).toBeNull();

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
    expect(ticker.sparklineQuality).toBe('placeholder');
    expect(ticker.sparklineIsDerived).toBe(false);
    expect(ticker.sparkline).toEqual([]);
    expect(ticker.sparklinePoints).toEqual([]);
    expect(ticker.sparklinePointCount).toBe(0);

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
      unavailableSymbols: [],
    });
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toMatchObject({
      symbol: 'BTC',
      marketId: 'KRW-BTC',
      sparkline: expect.any(Array),
      sparklinePoints: expect.any(Array),
      sparklineSource: 'derived_change24h',
      sparklineQuality: 'derived_preview',
      isRenderable: true,
      isDerived: true,
      pointCount: 6,
      sparklinePointCount: 6,
      stale: false,
      updatedAt: expect.any(Number),
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

  it('GET /market/sparkline returns refined_mini from prepared ticker ring buffer', async () => {
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
          trade_price: 100 + tickerCall,
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
    expect(item.sparklineQuality).toBe('refined_mini');
    expect(item.isDerived).toBe(false);
    expect(item.sparklinePointCount).toBeGreaterThanOrEqual(20);
    expect(item.sparkline).toHaveLength(item.sparklinePointCount);

    await app.close();
  }, 15000);

  it('GET /market/sparkline falls back to derived_preview when prepared points are insufficient', async () => {
    mockContractFetch();
    const app = await createApp();

    const response = await app.inject({ method: 'GET', url: '/market/sparkline?exchange=upbit&quoteCurrency=KRW&symbols=BTC&limit=24' });
    const body = JSON.parse(response.body);
    const item = body.data.items[0];

    expect(response.statusCode).toBe(200);
    expect(item.sparklineSource).toBe('derived_change24h');
    expect(item.sparklineQuality).toBe('derived_preview');
    expect(item.isDerived).toBe(true);
    expect(item.sparklinePointCount).toBe(6);

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

    const btcResponse = await app.inject({ method: 'GET', url: '/market/tickers?exchange=upbit&quoteCurrency=BTC&limit=10' });
    const btc = JSON.parse(btcResponse.body).data;
    expect(btc.items.every((item: any) => item.exchange === 'upbit' && item.quoteCurrency === 'BTC')).toBe(true);
    expect(btc.items.every((item: any) => item.displayPair.endsWith('/BTC'))).toBe(true);
    expect(btc.items.some((item: any) => item.marketId === 'KRW-BTC')).toBe(false);

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
    expect(upbitSparkline.quality).toBe('refined_mini');
    expect(bithumbSparkline.quality).toBe('refined_mini');
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
