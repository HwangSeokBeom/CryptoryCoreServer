import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedTicker } from '../src/exchanges/ExchangeAdapter';
import { BinanceProvider } from '../src/providers/exchanges/binance.provider';
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

describe('BinanceProvider ticker request filtering', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('filters non-listed symbols out of the upstream symbols query to avoid batch 400 failures', async () => {
    const provider = new BinanceProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', exchangeSymbol: 'BTCUSDT', marketId: 'BTCUSDT', market: 'BTC/USDT', baseCurrency: 'BTC', quoteCurrency: 'USDT', rawSymbol: 'BTCUSDT', tradable: true },
      { symbol: 'ETH', exchangeSymbol: 'ETHUSDT', marketId: 'ETHUSDT', market: 'ETH/USDT', baseCurrency: 'ETH', quoteCurrency: 'USDT', rawSymbol: 'ETHUSDT', tradable: true },
    ]);
    vi.spyOn(provider, 'getMarketCapabilitySnapshot').mockResolvedValue({
      capabilitySymbols: {
        tickers: ['BTC', 'ETH'],
        orderbook: ['BTC', 'ETH'],
        trades: ['BTC', 'ETH'],
        candles: ['BTC', 'ETH'],
      },
      websocketTickerSymbols: ['BTC', 'ETH'],
    });
    const requestDetailed = vi.spyOn((provider as any).restClient, 'requestDetailed').mockResolvedValue({
      data: [
        {
          symbol: 'BTCUSDT',
          lastPrice: '100',
          priceChangePercent: '1',
          quoteVolume: '1000',
          highPrice: '110',
          lowPrice: '90',
        },
        {
          symbol: 'ETHUSDT',
          lastPrice: '50',
          priceChangePercent: '2',
          quoteVolume: '500',
          highPrice: '55',
          lowPrice: '45',
        },
      ],
      meta: {
        owner: 'binance',
        path: '/api/v3/ticker/24hr',
        requestUrl: 'https://data-api.binance.vision/api/v3/ticker/24hr',
        statusCode: 200,
        responseSnippet: null,
      },
    });

    const snapshots = await provider.getTickerSnapshot(['BTC', 'FAKE', 'ETH']);

    expect(requestDetailed).toHaveBeenCalledTimes(1);
    expect(requestDetailed).toHaveBeenCalledWith(
      '/api/v3/ticker/24hr',
      expect.objectContaining({
        query: {
          symbols: JSON.stringify(['BTCUSDT', 'ETHUSDT']),
        },
      }),
    );
    expect(snapshots.map((ticker) => ticker.symbol)).toEqual(['BTC', 'ETH']);
  });

  it('uses exchange-native symbols for special assets instead of re-normalizing them into duplicate upstream symbols', async () => {
    const provider = new BinanceProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'A', exchangeSymbol: 'AUSDT', marketId: 'AUSDT', market: 'A/USDT', baseCurrency: 'A', quoteCurrency: 'USDT', rawSymbol: 'AUSDT', tradable: true },
      { symbol: 'AEUR', exchangeSymbol: 'AEURUSDT', marketId: 'AEURUSDT', market: 'AEUR/USDT', baseCurrency: 'AEUR', quoteCurrency: 'USDT', rawSymbol: 'AEURUSDT', tradable: true },
    ]);
    vi.spyOn(provider, 'getMarketCapabilitySnapshot').mockResolvedValue({
      capabilitySymbols: {
        tickers: ['A', 'AEUR'],
        orderbook: ['A', 'AEUR'],
        trades: ['A', 'AEUR'],
        candles: ['A', 'AEUR'],
      },
      websocketTickerSymbols: ['A', 'AEUR'],
    });
    const requestDetailed = vi.spyOn((provider as any).restClient, 'requestDetailed').mockResolvedValue({
      data: [
        {
          symbol: 'AUSDT',
          lastPrice: '1',
          priceChangePercent: '1',
          quoteVolume: '10',
          highPrice: '2',
          lowPrice: '0.5',
        },
        {
          symbol: 'AEURUSDT',
          lastPrice: '2',
          priceChangePercent: '2',
          quoteVolume: '20',
          highPrice: '3',
          lowPrice: '1.5',
        },
      ],
      meta: {
        owner: 'binance',
        path: '/api/v3/ticker/24hr',
        requestUrl: 'https://data-api.binance.vision/api/v3/ticker/24hr',
        statusCode: 200,
        responseSnippet: null,
      },
    });

    const snapshots = await provider.getTickerSnapshot(['A', 'AEUR']);

    expect(requestDetailed).toHaveBeenCalledWith(
      '/api/v3/ticker/24hr',
      expect.objectContaining({
        query: {
          symbols: JSON.stringify(['AUSDT', 'AEURUSDT']),
        },
      }),
    );
    expect(snapshots.map((ticker) => ticker.symbol)).toEqual(['A', 'AEUR']);
  });
});
