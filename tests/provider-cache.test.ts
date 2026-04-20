import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedTicker } from '../src/exchanges/ExchangeAdapter';
import { BithumbProvider } from '../src/providers/exchanges/bithumb.provider';
import { UpbitProvider } from '../src/providers/exchanges/upbit.provider';

function createTicker(symbol: string, price: number): NormalizedTicker {
  return {
    symbol,
    price,
    change24h: 1,
    volume24h: 1000,
    high24h: price + 10,
    low24h: price - 10,
    timestamp: Date.now(),
  };
}

describe('UpbitProvider cache and dedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('serves repeated ticker requests from the short TTL cache', async () => {
    const provider = new UpbitProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
    ]);
    const fetchTickers = vi.spyOn((provider as any).adapter, 'fetchTickers').mockResolvedValue([
      createTicker('BTC', 100),
      createTicker('ETH', 50),
    ]);

    const first = await provider.getTickerSnapshot(['BTC']);
    const second = await provider.getTickerSnapshot(['ETH']);

    expect(fetchTickers).toHaveBeenCalledTimes(1);
    expect(first.map((ticker) => ticker.symbol)).toEqual(['BTC']);
    expect(second.map((ticker) => ticker.symbol)).toEqual(['ETH']);

    vi.advanceTimersByTime(2_001);
    await provider.getTickerSnapshot(['BTC']);
    expect(fetchTickers).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent ticker fetches for the same exchange snapshot', async () => {
    const provider = new UpbitProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
    ]);
    let resolveFetch: ((value: NormalizedTicker[]) => void) | null = null;
    const fetchPromise = new Promise<NormalizedTicker[]>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchTickers = vi.spyOn((provider as any).adapter, 'fetchTickers').mockReturnValue(fetchPromise);

    const pendingBtc = provider.getTickerSnapshot(['BTC']);
    const pendingEth = provider.getTickerSnapshot(['ETH']);

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchTickers).toHaveBeenCalledTimes(1);
    resolveFetch?.([createTicker('BTC', 100), createTicker('ETH', 50)]);

    const [btc, eth] = await Promise.all([pendingBtc, pendingEth]);
    expect(btc.map((ticker) => ticker.symbol)).toEqual(['BTC']);
    expect(eth.map((ticker) => ticker.symbol)).toEqual(['ETH']);
  });

  it('serves Bithumb stale ticker cache immediately while refreshing in the background', async () => {
    const provider = new BithumbProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
    ]);

    let resolveRefresh: ((value: NormalizedTicker[]) => void) | null = null;
    const fetchTickers = vi.spyOn((provider as any).adapter, 'fetchTickers')
      .mockResolvedValueOnce([createTicker('BTC', 100), createTicker('ETH', 50)])
      .mockReturnValueOnce(new Promise<NormalizedTicker[]>((resolve) => {
        resolveRefresh = resolve;
      }));

    const first = await provider.getTickerSnapshot(['BTC']);
    vi.advanceTimersByTime(1_001);
    const second = await provider.getTickerSnapshot(['ETH']);

    expect(fetchTickers).toHaveBeenCalledTimes(2);
    expect(first.map((ticker) => ticker.price)).toEqual([100]);
    expect(second.map((ticker) => ticker.price)).toEqual([50]);

    resolveRefresh?.([createTicker('BTC', 110), createTicker('ETH', 55)]);
    await Promise.resolve();
  });
});
