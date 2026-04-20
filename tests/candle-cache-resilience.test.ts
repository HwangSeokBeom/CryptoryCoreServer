import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  getCandles: vi.fn(),
};

vi.mock('../src/config/redis', () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn(() => provider),
  },
}));

function makeCandles(count: number, closeAnchor = 1_712_345_000_000) {
  return Array.from({ length: count }, (_, index) => {
    const openTime = closeAnchor - (count - index) * 60_000;
    return {
      exchange: 'upbit' as const,
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW' as const,
      rawSymbol: 'KRW-BTC',
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
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_000_000);
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
    expect(response.items[0]).toHaveProperty('sourceTimestamp');
    expect(response.meta).toMatchObject({
      isRenderable: true,
      freshnessState: 'live',
      fallbackReason: null,
      lastSuccessfulAt: 1_712_345_000_000,
      pointCount: 12,
      recommendedClientBehavior: 'first_paint_ok',
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
    expect(response.meta).toMatchObject({
      isRenderable: true,
      freshnessState: 'stale',
      recommendedClientBehavior: 'first_paint_ok',
    });
  });
});
