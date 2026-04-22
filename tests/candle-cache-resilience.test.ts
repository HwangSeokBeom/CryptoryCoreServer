import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeProviderRegistry } from '../src/core/exchange/registry.bootstrap';

const provider = {
  exchange: 'upbit',
  metadata: {
    displayName: '업비트',
    quoteCurrency: 'KRW',
  },
  listMarkets: vi.fn(),
  getMarketCapabilitySnapshot: vi.fn(),
  getCandles: vi.fn(),
};

vi.mock('../src/config/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

function makeCandles(
  count: number,
  closeAnchor = 1_712_345_000_000,
  market: {
    symbol?: string;
    market?: string;
    rawSymbol?: string;
    marketId?: string;
  } = {},
) {
  const symbol = market.symbol ?? 'BTC';
  const displayMarket = market.market ?? `${symbol}/KRW`;
  const rawSymbol = market.rawSymbol ?? market.marketId ?? `KRW-${symbol}`;
  return Array.from({ length: count }, (_, index) => {
    const openTime = closeAnchor - (count - index) * 60_000;
    return {
      exchange: 'upbit' as const,
      symbol,
      market: displayMarket,
      baseCurrency: symbol,
      quoteCurrency: 'KRW' as const,
      rawSymbol,
      interval: '1m',
      openTime,
      closeTime: openTime + 60_000,
      open: 100_000_000 + index,
      high: 100_000_100 + index,
      low: 99_999_900 + index,
      close: 100_000_050 + index,
      volume: 10 + index,
    };
  });
}

describe('candle cache resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(exchangeProviderRegistry, 'getMarketDataProvider').mockReturnValue(provider as never);
    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_000_000);
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        marketId: 'KRW-BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['BTC'],
      capabilitySymbols: {
        tickers: ['BTC'],
        orderbook: ['BTC'],
        trades: ['BTC'],
        candles: ['BTC'],
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dedupes concurrent requests for the same exchange, symbol, and interval', async () => {
    provider.getCandles.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return makeCandles(12);
    });

    const { resolveCandleSnapshot, resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const first = resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    const second = resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(provider.getCandles).toHaveBeenCalledTimes(1);
    expect(firstResult.items).toHaveLength(12);
    expect(secondResult.items).toHaveLength(12);
    expect(firstResult.meta.freshnessState).toBe('live');
    expect(secondResult.meta.isRenderable).toBe(true);
  });

  it('fetches a stable minimum point set so smaller sparkline requests do not starve later detailed requests', async () => {
    provider.getCandles.mockResolvedValueOnce(makeCandles(60));

    const { resolveCandleSnapshot, resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const compact = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    const detailed = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 60 });

    expect(provider.getCandles).toHaveBeenCalledTimes(1);
    expect(provider.getCandles).toHaveBeenCalledWith('BTC', '1m', 60);
    expect(compact.items).toHaveLength(12);
    expect(detailed.items).toHaveLength(60);
    expect(detailed.meta.source).toBe('memory');
  });

  it('returns stale usable candles after an upstream failure instead of collapsing to unavailable', async () => {
    provider.getCandles.mockResolvedValueOnce(makeCandles(12));

    const { resolveCandleSnapshot, resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const first = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    expect(first.status).toBe('loaded');

    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_966_000);
    provider.getCandles.mockRejectedValueOnce(new Error('upstream timed out'));

    const staleWhileRefresh = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    expect(staleWhileRefresh.status).toBe('stale');
    expect(staleWhileRefresh.meta.isRenderable).toBe(true);
    expect(staleWhileRefresh.meta.fallbackReason).toBe('last_known_good');
    expect(staleWhileRefresh.meta.recommendedClientBehavior).toBe('first_paint_ok');

    await vi.waitFor(() => {
      expect(provider.getCandles).toHaveBeenCalledTimes(2);
    });

    const fallback = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    expect(fallback.status).toBe('stale');
    expect(fallback.meta.source).toBe('fallback');
    expect(fallback.meta.fallbackReason).toBe('timeout');
    expect(fallback.meta.retryAfterMs).toBeGreaterThan(0);
    expect(fallback.items).toHaveLength(12);
  });

  it('keeps stale renderable candles and marks the market unsupported after a provider-level unsupported response', async () => {
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'S',
        exchangeSymbol: 'KRW-S',
        marketId: 'KRW-S',
        market: 'S/KRW',
        baseCurrency: 'S',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-S',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['S'],
      capabilitySymbols: {
        tickers: ['S'],
        orderbook: ['S'],
        trades: ['S'],
        candles: ['S'],
      },
    });
    provider.getCandles.mockResolvedValueOnce(makeCandles(12, 1_712_345_000_000, {
      symbol: 'S',
      market: 'S/KRW',
      rawSymbol: 'KRW-S',
      marketId: 'KRW-S',
    }));

    const { ExchangeUnsupportedSymbolError } = await import('../src/core/exchange/errors');
    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const first = await getCandlesWithMeta('upbit', { marketId: 'KRW-S' }, '1m', 12);
    expect(first.items).toHaveLength(12);

    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_966_000);
    provider.getCandles.mockRejectedValueOnce(
      new ExchangeUnsupportedSymbolError('upbit', 'HTTP 400 market_data_unsupported', 400, 'KRW-S'),
    );

    const staleWhileRefresh = await getCandlesWithMeta('upbit', { marketId: 'KRW-S' }, '1m', 12);
    expect(staleWhileRefresh.items).toHaveLength(12);
    expect(staleWhileRefresh.meta.freshnessState).toBe('stale');

    await vi.waitFor(() => {
      expect(provider.getCandles).toHaveBeenCalledTimes(2);
    });

    const cachedUnsupported = await getCandlesWithMeta('upbit', { marketId: 'KRW-S' }, '1m', 12);
    expect(cachedUnsupported.items).toHaveLength(12);
    expect(cachedUnsupported.meta.freshnessState).toBe('stale');
    expect(cachedUnsupported.metadata.availability.candles).toBe('unsupported');
    expect(cachedUnsupported.metadata.isChartAvailable).toBe(false);
    expect(provider.getCandles).toHaveBeenCalledTimes(2);
  });

  it('returns unavailable only when no last known good candles exist and honors negative cooldown', async () => {
    provider.getCandles.mockRejectedValue(new Error('HTTP 503'));

    const { resolveCandleSnapshot, resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const first = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });
    const second = await resolveCandleSnapshot({ exchange: 'upbit', symbol: 'BTC', interval: '1m', limit: 12 });

    expect(first.status).toBe('unavailable');
    expect(first.meta.isRenderable).toBe(false);
    expect(second.status).toBe('unavailable');
    expect(second.meta.fallbackReason).toBe('negative_cooldown');
    expect(second.meta.retryAfterMs).toBeGreaterThan(0);
    expect(provider.getCandles).toHaveBeenCalledTimes(1);
  });

  it('marks representative symbols as visible priority ahead of background refreshes', async () => {
    const { getCandleRefreshPriorityForTest } = await import('../src/domains/charts/candle.snapshot');

    expect(getCandleRefreshPriorityForTest('BTC', false)).toBe('visible');
    expect(getCandleRefreshPriorityForTest('AAVE', false)).toBe('background');
    expect(getCandleRefreshPriorityForTest('AAVE', true)).toBe('normal');
  });

  it('keeps the market candle contract additive with freshness meta and timestamps', async () => {
    provider.getCandles.mockResolvedValueOnce(makeCandles(12));

    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const response = await getCandlesWithMeta('upbit', 'BTC', '1m', 12);

    expect(response.items).toHaveLength(12);
    expect(response.items[0]).toHaveProperty('marketId', 'KRW-BTC');
    expect(response.items[0]).toHaveProperty('sourceTimestamp');
    expect(response.metadata).toMatchObject({
      marketId: 'KRW-BTC',
      canonicalSymbol: 'BTC',
      displaySymbol: 'BTC/KRW',
    });
    expect(response.meta).toMatchObject({
      isRenderable: true,
      freshnessState: 'live',
      fallbackReason: null,
      lastSuccessfulAt: 1_712_345_000_000,
      pointCount: 12,
      recommendedClientBehavior: 'first_paint_ok',
    });
  });

  it('normalizes pair-like Korbit stablecoin symbol requests onto the listed market identity', async () => {
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'USDT',
        exchangeSymbol: 'usdt_krw',
        marketId: 'usdt_krw',
        market: 'USDT/KRW',
        baseCurrency: 'USDT',
        quoteCurrency: 'KRW',
        rawSymbol: 'usdt_krw',
        tradable: true,
      },
      {
        symbol: 'XRP',
        exchangeSymbol: 'xrp_krw',
        marketId: 'xrp_krw',
        market: 'XRP/KRW',
        baseCurrency: 'XRP',
        quoteCurrency: 'KRW',
        rawSymbol: 'xrp_krw',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['USDT', 'XRP'],
      capabilitySymbols: {
        tickers: ['USDT', 'XRP'],
        orderbook: ['USDT', 'XRP'],
        trades: ['USDT', 'XRP'],
        candles: ['USDT', 'XRP'],
      },
    });
    provider.getCandles.mockResolvedValueOnce(makeCandles(60, 1_712_345_000_000, {
      symbol: 'USDT',
      market: 'USDT/KRW',
      rawSymbol: 'usdt_krw',
      marketId: 'usdt_krw',
    }));

    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    const response = await getCandlesWithMeta('korbit', { symbol: 'USDT_KRW' }, '1h', 12);

    expect(provider.getCandles).toHaveBeenCalledWith('USDT', '1h', 60);
    expect(response.items).toHaveLength(12);
    expect(response.metadata).toMatchObject({
      marketId: 'usdt_krw',
      canonicalSymbol: 'USDT',
      displaySymbol: 'USDT/KRW',
      isChartAvailable: true,
    });
  });

  it('returns stale candle payloads from the market service instead of throwing 503 when only last known good data exists', async () => {
    provider.getCandles.mockResolvedValueOnce(makeCandles(12));

    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { resetCandleSnapshotCachesForTest } = await import('../src/domains/charts/candle.snapshot');
    resetCandleSnapshotCachesForTest();

    await getCandlesWithMeta('upbit', 'BTC', '1m', 12);

    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_966_000);
    provider.getCandles.mockRejectedValueOnce(new Error('HTTP 503'));

    const response = await getCandlesWithMeta('upbit', 'BTC', '1m', 12);

    expect(response.items).toHaveLength(12);
    expect(response.metadata.marketId).toBe('KRW-BTC');
    expect(response.meta).toMatchObject({
      isRenderable: true,
      freshnessState: 'stale',
      recommendedClientBehavior: 'first_paint_ok',
    });
  });
});
