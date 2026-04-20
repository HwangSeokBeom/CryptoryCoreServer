import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoinoneProvider } from '../src/providers/exchanges/coinone.provider';

function readFixture(path: string) {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('Market and ticker join consistency', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/public/v2/markets/KRW')) {
        return new Response(readFixture('./fixtures/coinone/markets-krw.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (url.includes('/public/v2/ticker_new/KRW')) {
        return new Response(readFixture('./fixtures/coinone/tickers-krw.json'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the same canonical symbol keys for Coinone markets and tickers', async () => {
    const provider = new CoinoneProvider();

    const markets = await provider.listMarkets();
    const tickers = await provider.getTickerSnapshot();

    expect(markets.map((market) => market.symbol).sort()).toEqual(['BTC', 'ETH', 'TNSR', 'XRP']);
    expect(tickers.map((ticker) => ticker.symbol).sort()).toEqual(['BTC', 'ETH', 'TNSR', 'XRP']);
  });
});
