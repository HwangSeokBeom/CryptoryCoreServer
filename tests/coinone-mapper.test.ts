import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseCoinoneMarketsResponse, parseCoinoneTickersResponse } from '../src/providers/exchanges/coinone.mapper';

function readFixture<T>(path: string) {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
}

describe('Coinone mapping', () => {
  it('maps raw Coinone ticker payload to canonical tickers', () => {
    const payload = readFixture<{ tickers: unknown[] }>('./fixtures/coinone/tickers-krw.json');
    const { tickers, missingSymbols, dropped } = parseCoinoneTickersResponse(payload, ['BTC', 'ETH', 'XRP']);

    expect(missingSymbols).toEqual([]);
    expect(dropped).toEqual([]);
    expect(tickers.map((ticker) => ticker.symbol)).toEqual(['BTC', 'ETH', 'XRP']);
    expect(tickers[0]).toMatchObject({
      symbol: 'BTC',
      price: 112260000,
      volume24h: 9012764771.9973,
      high24h: 112790000,
      low24h: 108620000,
      timestamp: 1776429078302,
    });
    expect(tickers[0].change24h).toBeCloseTo(((112260000 - 110700000) / 110700000) * 100, 2);
  });

  it('keeps ticker items even when optional numeric fields are malformed', () => {
    const { tickers, missingSymbols } = parseCoinoneTickersResponse(
      {
        tickers: [
          {
            quote_currency: 'krw',
            target_currency: 'btc',
            timestamp: '1776429078302',
            high: 'NaN',
            low: 'oops',
            first: '100',
            last: '101',
            quote_volume: 'bad-volume',
            yesterday_last: 'bad-yesterday',
          },
        ],
      },
      ['BTC'],
    );

    expect(missingSymbols).toEqual([]);
    expect(tickers).toHaveLength(1);
    expect(tickers[0]).toMatchObject({
      symbol: 'BTC',
      price: 101,
      change24h: 1,
      volume24h: 0,
      high24h: 0,
      low24h: 0,
    });
  });

  it('keeps market list aligned to the canonical supported symbol set', () => {
    const payload = readFixture<{ markets: unknown[] }>('./fixtures/coinone/markets-krw.json');
    const markets = parseCoinoneMarketsResponse(payload, new Set(['BTC', 'ETH', 'XRP']));

    expect(markets.map((market) => market.symbol)).toEqual(['BTC', 'ETH', 'XRP']);
  });
});
