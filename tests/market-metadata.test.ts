import { describe, expect, it } from 'vitest';
import {
  buildCanonicalMarketMetadata,
  resolveExchangeMarketInput,
} from '../src/core/exchange/market-metadata';
import { buildResolvedMarketCapabilityFlags } from '../src/core/exchange/market.contract';
import { resolveIconUrl } from '../src/core/exchange/icon.resolver';
import { getSupportedCandleIntervals } from '../src/core/exchange/interval.mapper';
import { toCanonicalMarket } from '../src/core/exchange/symbol.mapper';
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
      canonicalMarketId: `${canonicalSymbol}/KRW`,
      rawSymbol: marketId,
      canonicalSymbol,
      baseAsset: canonicalSymbol,
      quoteAsset: 'KRW',
      displaySymbol: `${canonicalSymbol}/KRW`,
      isActive: true,
      candlesSupported: true,
      graphSupported: true,
      supportedIntervals: expect.any(Array),
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

  it('exposes additive candle capability metadata without inflating identity fields', () => {
    const metadata = buildCanonicalMarketMetadata({
      exchange: 'korbit',
      marketId: 'w_krw',
      rawSymbol: 'w_krw',
      symbol: 'W',
      capabilities: {
        supportsCandles: false,
        supportsOrderBook: true,
        supportsTrades: true,
        graphSupported: false,
        supportedIntervals: [],
        unsupportedReason: 'provider_not_supported',
      },
    });

    expect(metadata).toMatchObject({
      marketId: 'w_krw',
      canonicalMarketId: 'W/KRW',
      canonicalSymbol: 'W',
      candlesSupported: false,
      graphSupported: false,
      supportedIntervals: [],
      unsupportedReason: 'provider_not_supported',
    });
  });

  it('keeps Korbit special market identity stable across alias inputs', () => {
    const markets: ExchangeMarketDescriptor[] = [
      {
        symbol: 'W',
        exchangeSymbol: 'w_krw',
        marketId: 'w_krw',
        market: 'W/KRW',
        baseCurrency: 'W',
        quoteCurrency: 'KRW',
        rawSymbol: 'w_krw',
        tradable: true,
      },
    ];

    const byHyphenAlias = resolveExchangeMarketInput({
      exchange: 'korbit',
      markets,
      input: { marketId: 'KRW-W' },
    });
    const byNativeAlias = resolveExchangeMarketInput({
      exchange: 'korbit',
      markets,
      input: { marketId: 'W_KRW' },
    });
    const bySymbol = resolveExchangeMarketInput({
      exchange: 'korbit',
      markets,
      input: { symbol: 'W' },
    });

    expect(byHyphenAlias).toMatchObject({
      ok: true,
      metadata: {
        marketId: 'w_krw',
        canonicalMarketId: 'W/KRW',
        canonicalSymbol: 'W',
      },
      matchSource: 'market_alias',
      identitySpecialCase: 'single_char_symbol',
    });
    expect(byNativeAlias).toMatchObject({
      ok: true,
      metadata: {
        marketId: 'w_krw',
        canonicalMarketId: 'W/KRW',
        canonicalSymbol: 'W',
      },
    });
    expect(bySymbol).toMatchObject({
      ok: true,
      metadata: {
        marketId: 'w_krw',
        canonicalMarketId: 'W/KRW',
        canonicalSymbol: 'W',
      },
      matchSource: 'symbol',
      identitySpecialCase: 'single_char_symbol',
    });
  });

  it('keeps canonical marketId consistent between market metadata and canonical market views', () => {
    const metadata = buildCanonicalMarketMetadata({
      exchange: 'korbit',
      marketId: 'btc_krw',
      rawSymbol: 'btc_krw',
    });
    const canonicalMarket = toCanonicalMarket('korbit', 'BTC');

    expect(metadata.canonicalMarketId).toBe('BTC/KRW');
    expect(canonicalMarket.canonicalMarketId).toBe('BTC/KRW');
    expect(canonicalMarket.marketId).toBe('btc_krw');
  });

  it('uses the official Korbit candle interval matrix in capability metadata', () => {
    const supportedIntervals = getSupportedCandleIntervals('korbit');
    const capabilities = buildResolvedMarketCapabilityFlags({
      exchange: 'korbit',
      market: { symbol: 'BTC' },
      capabilitySnapshot: {
        websocketTickerSymbols: ['BTC'],
        capabilitySymbols: {
          tickers: ['BTC'],
          orderbook: ['BTC'],
          trades: ['BTC'],
          candles: ['BTC'],
        },
      },
    });

    expect(supportedIntervals).toEqual(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']);
    expect(supportedIntervals).not.toContain('3m');
    expect(supportedIntervals).not.toContain('10m');
    expect(capabilities.supportedIntervals).toEqual(supportedIntervals);
    expect(capabilities.graphSupported).toBe(true);
  });
});
