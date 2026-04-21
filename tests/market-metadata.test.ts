import { describe, expect, it } from 'vitest';
import {
  buildCanonicalMarketMetadata,
  resolveExchangeMarketInput,
} from '../src/core/exchange/market-metadata';
import { resolveIconUrl } from '../src/core/exchange/icon.resolver';
import type { ExchangeId, ExchangeMarketDescriptor } from '../src/core/exchange/exchange.types';

describe('canonical market metadata', () => {
  it.each([
    ['upbit', 'KRW-BTC', 'BTC'],
    ['bithumb', 'BTC_KRW', 'BTC'],
    ['coinone', 'BTC', 'BTC'],
    ['korbit', 'btc_krw', 'BTC'],
  ] satisfies Array<[ExchangeId, string, string]>)('normalizes %s market symbols', (exchange, marketId, canonicalSymbol) => {
    const metadata = buildCanonicalMarketMetadata({
      exchange,
      marketId,
      rawSymbol: marketId,
    });

    expect(metadata).toMatchObject({
      exchange,
      marketId,
      rawSymbol: marketId,
      canonicalSymbol,
      baseAsset: canonicalSymbol,
      quoteAsset: 'KRW',
      displaySymbol: `${canonicalSymbol}/KRW`,
      isActive: true,
      capabilities: {
        supportsCandles: true,
        supportsOrderBook: true,
        supportsTrades: true,
      },
    });
  });

  it('resolves icon URLs from canonical symbols, not raw symbols', () => {
    expect(resolveIconUrl('BTC')).toContain('/btc.png');
    expect(resolveIconUrl('eth')).toContain('/eth.png');
    expect(resolveIconUrl('XRP')).toContain('/xrp.png');
    expect(resolveIconUrl('NOTREAL')).toBeNull();
  });

  it('resolves marketId before provider calls and rejects ambiguous symbols', () => {
    const markets: ExchangeMarketDescriptor[] = [
      {
        symbol: 'BTC',
        exchangeSymbol: 'btc_krw',
        marketId: 'btc_krw',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'btc_krw',
        tradable: true,
      },
    ];

    expect(resolveExchangeMarketInput({
      exchange: 'korbit',
      markets,
      input: { marketId: 'btc_krw' },
    })).toMatchObject({
      ok: true,
      metadata: {
        canonicalSymbol: 'BTC',
        marketId: 'btc_krw',
      },
    });

    expect(resolveExchangeMarketInput({
      exchange: 'korbit',
      markets,
      input: { symbol: 'C' },
    })).toMatchObject({
      ok: false,
      reason: 'SYMBOL_NOT_FOUND',
      input: 'C',
    });
  });
});
