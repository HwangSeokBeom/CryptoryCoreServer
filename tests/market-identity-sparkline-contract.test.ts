import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BinanceMarketDataAdapter,
  CoinoneMarketDataAdapter,
  KorbitMarketDataAdapter,
  normalizeMarketIdentity,
  V1ExchangeMarketDataAdapter,
} from '../src/domains/market-data/contracts/exchange-market-data.adapters';

const ORIGINAL_ENV = { ...process.env };
const BASE_ENV = {
  DATABASE_URL: 'postgresql://cryptory:cryptory@localhost:5432/cryptory',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'super-secret-jwt-value',
  NODE_ENV: 'test',
  TICKER_CACHE_TTL_SECONDS: '0',
};

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('market identity and sparkline contract', () => {
  it('normalizes exchange market ids without truncating symbols', () => {
    const coinone = new CoinoneMarketDataAdapter();
    const korbit = new KorbitMarketDataAdapter();
    const binance = new BinanceMarketDataAdapter();
    const upbit = new V1ExchangeMarketDataAdapter('upbit');
    const bithumb = new V1ExchangeMarketDataAdapter('bithumb');

    expect(coinone.parseMarket('USDE')).toEqual({ symbol: 'USDE', quoteCurrency: 'KRW' });
    expect(coinone.normalizeMarket('USDE', 'KRW')).toBe('KRW-USDE');
    expect(coinone.normalizeMarket('PEPE', 'KRW')).toBe('KRW-PEPE');
    expect(korbit.parseMarket('xrp_krw')).toEqual({ symbol: 'XRP', quoteCurrency: 'KRW' });
    expect(binance.parseMarket('DOGEUSDT')).toEqual({ symbol: 'DOGE', quoteCurrency: 'USDT' });
    expect(binance.parseMarket('ARUSDT')).toEqual({ symbol: 'AR', quoteCurrency: 'USDT' });
    expect(binance.parseMarket('ACEUSDT')).toEqual({ symbol: 'ACE', quoteCurrency: 'USDT' });
    expect(binance.parseMarket('OGUSDT')).toEqual({ symbol: 'OG', quoteCurrency: 'USDT' });
    expect(binance.parseMarket('1000CATUSDT')).toEqual({ symbol: '1000CAT', quoteCurrency: 'USDT' });
    expect(upbit.parseMarket('KRW-BTC')).toEqual({ symbol: 'BTC', quoteCurrency: 'KRW' });
    expect(bithumb.parseMarket('BTC_KRW')).toEqual({ symbol: 'BTC', quoteCurrency: 'KRW' });
    expect(bithumb.normalizeMarket('BTC', 'KRW')).toBe('KRW-BTC');
  });

  it('normalizes Coinone base-only USDT and USDE without creating symbol T', () => {
    expect(normalizeMarketIdentity('coinone', 'USDT', 'KRW')).toMatchObject({
      canonicalMarketId: 'KRW-USDT',
      symbol: 'USDT',
      baseCurrency: 'USDT',
      quoteCurrency: 'KRW',
      valid: true,
    });
    expect(normalizeMarketIdentity('coinone', 'USDE', 'KRW')).toMatchObject({
      canonicalMarketId: 'KRW-USDE',
      symbol: 'USDE',
      baseCurrency: 'USDE',
      valid: true,
    });
    expect(normalizeMarketIdentity('coinone', 'BCH', 'KRW')).toMatchObject({
      canonicalMarketId: 'KRW-BCH',
      symbol: 'BCH',
      baseCurrency: 'BCH',
      valid: true,
    });
    expect(normalizeMarketIdentity('coinone', 'T', 'KRW')).toMatchObject({
      canonicalMarketId: 'KRW-T',
      symbol: 'T',
      valid: false,
      reason: 'suspicious_truncated_symbol',
    });
  });

  it('joins Korbit ticker rows by market key so KRW-XRP never inherits another symbol', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/currencyPairs')) {
        return new Response(JSON.stringify({
          data: [
            { symbol: 'aaa_krw', status: 'launched' },
            { symbol: 'xrp_krw', status: 'launched' },
          ],
        }), { status: 200 });
      }
      if (url.includes('/v2/tickers')) {
        return new Response(JSON.stringify({
          data: [
            { symbol: 'xrp_krw', close: '20.27', priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '21', low: '19' },
            { symbol: 'aaa_krw', close: '1', priceChangePercent: '0.1', quoteVolume: '10', volume: '1', high: '2', low: '1' },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });

    const tickers = await new KorbitMarketDataAdapter().getTickers({ exchange: 'korbit', quoteCurrency: 'KRW' });
    const xrp = tickers.find((item) => item.marketId === 'KRW-XRP');

    expect(xrp).toMatchObject({
      marketId: 'KRW-XRP',
      canonicalMarketId: 'KRW-XRP',
      symbol: 'XRP',
      baseCurrency: 'XRP',
      quoteCurrency: 'KRW',
      price: 20.27,
    });
    expect(xrp?.symbol).not.toBe('A');
  });

  it('returns ticker preview points and exact canonical ids from sparkline batch fallback', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/public/v2/markets/KRW')) {
        return new Response(JSON.stringify({
          markets: [
            { quote_currency: 'krw', target_currency: 'usde', trade_status: 1, maintenance_status: 0 },
            { quote_currency: 'krw', target_currency: 'pepe', trade_status: 1, maintenance_status: 0 },
          ],
        }), { status: 200 });
      }
      if (url.includes('/public/v2/ticker_new/KRW')) {
        return new Response(JSON.stringify({
          tickers: [
            { quote_currency: 'krw', target_currency: 'usde', timestamp: 1777809600000, high: '105', low: '90', last: '100', yesterday_last: '95', quote_volume: '1000', target_volume: '10' },
            { quote_currency: 'krw', target_currency: 'pepe', timestamp: 1777809600000, high: '2', low: '1', last: '1.2', yesterday_last: '1.0', quote_volume: '900', target_volume: '20' },
          ],
        }), { status: 200 });
      }
      if (url.includes('/public/v2/chart')) {
        return new Response(JSON.stringify({ chart: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });

    const { getMarketTickerList, getMarketSparklineBatch } = await import('../src/domains/market-data/contracts/market-data-contract.service');
    const tickers = await getMarketTickerList({ exchange: 'coinone', quoteCurrency: 'KRW', limit: 100 });
    expect(tickers.items.every((item: any) => item.sparklinePoints.length >= 2 || item.sparklineUnavailableReason)).toBe(true);
    expect(tickers.items.find((item: any) => item.marketId === 'KRW-USDE')).toMatchObject({
      canonicalMarketId: 'KRW-USDE',
      symbol: 'USDE',
      baseCurrency: 'USDE',
      sparklineQuality: 'unavailable',
      sparklinePointCount: 0,
      sparklineSource: 'unavailable',
      sparklineUnavailableReason: expect.any(String),
    });

    const sparkline = await getMarketSparklineBatch({
      exchange: 'coinone',
      quoteCurrency: 'KRW',
      marketIds: ['KRW-USDE', 'KRW-XXX'],
      symbols: [],
      interval: '1M',
      limit: 24,
    });

    expect(sparkline.items.find((item: any) => item.marketId === 'KRW-USDE')).toMatchObject({
      marketId: 'KRW-USDE',
      canonicalMarketId: 'KRW-USDE',
      symbol: 'USDE',
      quality: 'unavailable',
      pointCount: 0,
      unavailableReason: 'insufficient_provider_points',
    });
    expect(sparkline.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ marketId: 'KRW-XXX', reason: 'market_not_found' }),
    ]));
  });

  it('normalizes repeated Korbit 9 point ticker ring buffers to insufficient_points', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    let price = 100;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/currencyPairs')) {
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', status: 'launched' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/tickers')) {
        price += 1;
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', close: String(price), priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '120', low: '90' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/candles')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const { getMarketTickerList } = await import('../src/domains/market-data/contracts/market-data-contract.service');

    let response: any = null;
    for (let index = 0; index < 9; index += 1) {
      response = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1 });
    }
    const ticker = response.items[0];

    expect(ticker).toMatchObject({
      exchange: 'korbit',
      canonicalMarketId: 'KRW-AAVE',
      sparklineSource: 'unavailable',
      sparklineQuality: 'insufficient_points',
      sparklinePointCount: 0,
      sparklineLowInformationReason: null,
      sparklineUnavailableReason: 'insufficient_sparkline_points',
      graphDisplayAllowed: false,
    });
    expect(ticker.sparkline).toHaveLength(0);
    expect(ticker.sparklinePoints).toHaveLength(0);
    expect(response.meta.sparklineSummary).toMatchObject({
      targetPointCount: 24,
      fallbackListSparkline: 0,
      lowInformation: 0,
      unavailable: 1,
      missing: 0,
      warmup: true,
    });
  });

  it('attaches Korbit provider candle cache as a 24 point ticker list sparkline on the next ticker request', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/currencyPairs')) {
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', status: 'launched' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/tickers')) {
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', close: '100', priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '120', low: '90' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/candles')) {
        return new Response(JSON.stringify({
          data: Array.from({ length: 60 }, (_, index) => ({
            timestamp: 1777809600000 + index * 60_000,
            open: 90 + index,
            high: 92 + index,
            low: 89 + index,
            close: 100 + (index % 8) * 1.3 + (index % 5 === 0 ? 2 : 0),
            volume: 10,
            quoteVolume: 1000,
          })),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const { getMarketSparklineBatch, getMarketTickerList } = await import('../src/domains/market-data/contracts/market-data-contract.service');

    const sparkline = await getMarketSparklineBatch({
      exchange: 'korbit',
      quoteCurrency: 'KRW',
      marketIds: ['KRW-AAVE'],
      symbols: [],
      interval: '1M',
      limit: 60,
      priority: 'top',
    });
    const response = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1 });
    const ticker = response.items[0];

    expect(sparkline.items[0].realSeries).toBe(true);
    expect(ticker).toMatchObject({
      canonicalMarketId: 'KRW-AAVE',
      sparklineSource: 'candle_cache',
      sparklineQuality: 'listSparkline24',
      sparklinePointCount: 24,
      sparklineIsDerived: false,
    });
    expect(ticker.sparkline).toHaveLength(24);
    expect(new Set(ticker.sparkline).size).toBeGreaterThan(2);
    expect(response.meta.sparklineSummary).toMatchObject({
      targetPointCount: 24,
      listSparkline24: 1,
      fallbackListSparkline: 0,
      lowInformation: 0,
      unavailable: 0,
      missing: 0,
      warmup: false,
    });
  });

  it('changes list sparkline hash and sourceVersion when observed points change', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    let price = 100;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/currencyPairs')) {
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', status: 'launched' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/tickers')) {
        price += 1;
        return new Response(JSON.stringify({
          data: [{ symbol: 'aave_krw', close: String(price), priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '120', low: '90' }],
        }), { status: 200 });
      }
      if (url.includes('/v2/candles')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const { getMarketTickerList } = await import('../src/domains/market-data/contracts/market-data-contract.service');

    await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1 });
    const second: any = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1 });
    const third: any = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1 });

    expect(second.items[0]).toMatchObject({
      sparklineQuality: 'insufficient_points',
      sparklinePointCount: 0,
      sparklineLowInformationReason: null,
      sparklineUnavailableReason: 'insufficient_sparkline_points',
      sparklinePointsHash: expect.any(String),
      sparklineSourceVersion: null,
      sparklineTimeframe: '1H',
    });
    expect(third.items[0].sparklinePointCount).toBe(0);
    expect(third.items[0].sparklineQuality).toBe('insufficient_points');
    expect(third.items[0].sparklinePointsHash).toBe(second.items[0].sparklinePointsHash);
    expect(third.items[0].sparklineSourceVersion).toBeNull();
  });

  it('marks embedded 24 provider points as fresh providerCandle24 with graph version fields', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    const firstBaseTimestamp = Date.now() - 23 * 60_000;
    let requestCount = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/market/all')) {
        return new Response(JSON.stringify([
          { market: 'KRW-AAVE', korean_name: '에이브', english_name: 'Aave' },
          { market: 'KRW-BTC', korean_name: '비트코인', english_name: 'Bitcoin' },
        ]), { status: 200 });
      }
      if (url.includes('/v1/ticker')) {
        const baseTimestamp = firstBaseTimestamp + requestCount * 60_000;
        requestCount += 1;
        return new Response(JSON.stringify([
          {
            market: 'KRW-AAVE',
            trade_price: 100 + requestCount,
            signed_change_rate: 0.01,
            signed_change_price: 1,
            acc_trade_price_24h: 1000,
            acc_trade_volume_24h: 10,
            high_price: 120,
            low_price: 90,
            timestamp: baseTimestamp + 23 * 60_000,
            sparklinePoints: Array.from({ length: 24 }, (_, index) => ({
              price: 90 + index + requestCount,
              timestamp: baseTimestamp + index * 60_000,
            })),
          },
          {
            market: 'KRW-BTC',
            trade_price: 200,
            signed_change_rate: 0.02,
            signed_change_price: 2,
            acc_trade_price_24h: 1000,
            acc_trade_volume_24h: 10,
            high_price: 220,
            low_price: 190,
            timestamp: baseTimestamp + 23 * 60_000,
            sparklinePoints: Array.from({ length: 24 }, (_, index) => ({
              price: 190 + index,
              timestamp: baseTimestamp + index * 60_000,
            })),
          },
        ]), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const { getMarketTickerList } = await import('../src/domains/market-data/contracts/market-data-contract.service');

    const first: any = await getMarketTickerList({ exchange: 'upbit', quoteCurrency: 'KRW', limit: 1, requestId: 'req-1' });
    const second: any = await getMarketTickerList({ exchange: 'upbit', quoteCurrency: 'KRW', limit: 1, requestId: 'req-2' });

    expect(first.meta).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'KRW',
      requestId: 'req-1',
      requestedLimit: 1,
      returnedCount: 1,
      serverReceivedAt: expect.any(String),
      serverRespondedAt: expect.any(String),
      sparklineSummary: expect.objectContaining({
        providerCandle24: 1,
        updatedWithin30s: 1,
      }),
    });
    expect(first.items[0]).toMatchObject({
      exchange: 'upbit',
      quoteCurrency: 'KRW',
      canonicalMarketId: 'KRW-AAVE',
      symbol: 'AAVE',
      baseCurrency: 'AAVE',
      sparklineQuality: 'providerCandle24',
      sparklinePointCount: 24,
      sparklineSource: 'provider_candle',
      sparklineUpdatedAt: expect.any(String),
      sparklineSourceVersion: expect.any(String),
      sparklinePointsHash: expect.any(String),
      sparklineTimeframe: '1H',
    });
    expect(Date.now() - Date.parse(first.items[0].sparklineUpdatedAt)).toBeLessThan(30_000);
    expect(second.items[0].sparklinePointsHash).not.toBe(first.items[0].sparklinePointsHash);
    expect(second.items[0].sparklineSourceVersion).not.toBe(first.items[0].sparklineSourceVersion);
  });

  it('keeps pagination identity stable and includes graph version fields on next pages', async () => {
    process.env = { ...ORIGINAL_ENV, ...BASE_ENV };
    vi.resetModules();
    const baseTimestamp = Date.now() - 23 * 60_000;
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v2/currencyPairs')) {
        return new Response(JSON.stringify({
          data: [
            { symbol: 'aave_krw', status: 'launched' },
            { symbol: 'btc_krw', status: 'launched' },
          ],
        }), { status: 200 });
      }
      if (url.includes('/v2/tickers')) {
        return new Response(JSON.stringify({
          data: [
            { symbol: 'aave_krw', close: '100', priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '120', low: '90' },
            { symbol: 'btc_krw', close: '200', priceChangePercent: '1.2', quoteVolume: '1000', volume: '10', high: '220', low: '190' },
          ],
        }), { status: 200 });
      }
      if (url.includes('/v2/candles')) {
        const isBtc = url.includes('btc_krw');
        return new Response(JSON.stringify({
          data: Array.from({ length: 24 }, (_, index) => ({
            timestamp: baseTimestamp + index * 60_000,
            open: 90 + index,
            high: 92 + index,
            low: 89 + index,
            close: (isBtc ? 190 : 90) + index,
            volume: 10,
            quoteVolume: 1000,
          })),
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected path', url }), { status: 500 });
    });
    const { getMarketSparklineBatch, getMarketTickerList } = await import('../src/domains/market-data/contracts/market-data-contract.service');

    await getMarketSparklineBatch({
      exchange: 'korbit',
      quoteCurrency: 'KRW',
      marketIds: ['KRW-AAVE', 'KRW-BTC'],
      symbols: [],
      interval: '1M',
      limit: 24,
    });
    const page1: any = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1, requestId: 'page-1' });
    const page2: any = await getMarketTickerList({ exchange: 'korbit', quoteCurrency: 'KRW', limit: 1, cursor: page1.meta.nextCursor, requestId: 'page-2' });

    expect(page1.meta).toMatchObject({
      exchange: 'korbit',
      quoteCurrency: 'KRW',
      requestId: 'page-1',
      hasNext: true,
      sparklineSummary: expect.objectContaining({ targetPointCount: 24 }),
    });
    expect(page2.meta).toMatchObject({
      exchange: 'korbit',
      quoteCurrency: 'KRW',
      requestId: 'page-2',
      sparklineSummary: expect.objectContaining({ targetPointCount: 24 }),
    });
    expect(page1.items[0].canonicalMarketId).not.toBe(page2.items[0].canonicalMarketId);
    for (const response of [page1, page2]) {
      expect(response.items[0]).toMatchObject({
        exchange: response.meta.exchange,
        quoteCurrency: response.meta.quoteCurrency,
        canonicalMarketId: expect.stringMatching(/^KRW-/),
        symbol: expect.any(String),
        baseCurrency: expect.any(String),
        sparklineUpdatedAt: expect.any(String),
        sparklineSourceVersion: expect.any(String),
        sparklinePointsHash: expect.any(String),
        sparklineTimeframe: '1H',
      });
    }
  });
});
