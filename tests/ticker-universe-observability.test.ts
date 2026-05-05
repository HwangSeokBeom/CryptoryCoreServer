import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedTicker } from '../src/exchanges/ExchangeAdapter';
import { logger } from '../src/utils/logger';
import { BithumbProvider } from '../src/providers/exchanges/bithumb.provider';

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

describe('Ticker universe observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs requested, returned, dropped symbols and capability-specific universes', async () => {
    const provider = new BithumbProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC' },
      { symbol: 'ETH', market: 'ETH/KRW', rawSymbol: 'KRW-ETH' },
      { symbol: 'XRP', market: 'XRP/KRW', rawSymbol: 'KRW-XRP' },
    ]);
    vi.spyOn((provider as any).adapter, 'fetchTickers').mockResolvedValue([
      createTicker('BTC', 100),
      createTicker('ETH', 50),
    ]);
    (provider as any).supportedStreamSymbols = new Set(['BTC', 'ETH', 'XRP']);
    (provider as any).capabilityExcludedSymbols.orderbook.set('XRP', 'capability not supported');

    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    const tickers = await provider.getTickerSnapshot(['BTC', 'ETH', 'XRP']);

    expect(tickers.map((ticker) => ticker.symbol)).toEqual(['BTC', 'ETH']);

    const universeLog = infoSpy.mock.calls.find(([, message]) => message === 'Resolved exchange market universe');
    expect(universeLog?.[0]).toMatchObject({
      exchange: 'bithumb',
      operation: 'tickers',
      requestedSymbols: ['BTC', 'ETH', 'XRP'],
      returnedSymbols: ['BTC', 'ETH'],
      droppedSymbols: [{ symbol: 'XRP', reason: 'missing_upstream_ticker' }],
      registrySymbolCount: expect.any(Number),
      marketSymbolCount: 3,
      websocketTickerSymbolCount: 3,
      capabilitySymbolCounts: {
        tickers: 3,
        orderbook: 2,
      },
      universe: {
        marketSymbols: {
          count: 3,
          sample: ['BTC', 'ETH', 'XRP'],
          omittedCount: 0,
        },
        websocketTickerSymbols: {
          count: 3,
          sample: ['BTC', 'ETH', 'XRP'],
          omittedCount: 0,
        },
        capabilitySymbols: {
          tickers: {
            count: 3,
            sample: ['BTC', 'ETH', 'XRP'],
            omittedCount: 0,
          },
          orderbook: {
            count: 2,
            sample: ['BTC', 'ETH'],
            omittedCount: 0,
          },
        },
        capabilityExcludedSymbols: {
          orderbook: [{ symbol: 'XRP', reason: 'capability not supported' }],
        },
      },
    });
  });
});
