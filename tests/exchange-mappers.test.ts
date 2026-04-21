import { describe, expect, it } from 'vitest';
import { resolveExchangeInterval } from '../src/core/exchange/interval.mapper';
import { fromExchangeSymbol, resolveCanonicalAssetKey, toExchangeSymbol } from '../src/core/exchange/symbol.mapper';

describe('Exchange Mappers', () => {
  it('normalizes symbol formats per exchange', () => {
    expect(toExchangeSymbol('upbit', 'btc')).toBe('KRW-BTC');
    expect(toExchangeSymbol('bithumb', 'btc')).toBe('BTC_KRW');
    expect(toExchangeSymbol('coinone', 'btc')).toBe('BTC');
    expect(toExchangeSymbol('korbit', 'btc')).toBe('btc_krw');
    expect(toExchangeSymbol('binance', 'btc')).toBe('BTCUSDT');

    expect(fromExchangeSymbol('upbit', 'KRW-BTC')).toBe('BTC');
    expect(fromExchangeSymbol('bithumb', 'BTC_KRW')).toBe('BTC');
    expect(fromExchangeSymbol('coinone', 'btc')).toBe('BTC');
    expect(fromExchangeSymbol('korbit', 'btc_krw')).toBe('BTC');
    expect(fromExchangeSymbol('binance', 'btcusdt')).toBe('BTC');
    expect(fromExchangeSymbol('binance', 'ETHUSDC')).toBe('ETH');
    expect(fromExchangeSymbol('binance', 'FDUSDUSDT')).toBe('FDUSD');
  });

  it('falls back to the next supported interval when needed', () => {
    expect(resolveExchangeInterval('coinone', '10m')).toEqual({
      requestedInterval: '10m',
      normalizedInterval: '10m',
      resolvedInterval: '15m',
      exchangeInterval: '15m',
      fallbackApplied: true,
    });
    expect(resolveExchangeInterval('upbit', '1h')).toEqual({
      requestedInterval: '1h',
      normalizedInterval: '1h',
      resolvedInterval: '1h',
      exchangeInterval: '60',
      fallbackApplied: false,
    });
  });

  it('canonicalizes asset image keys for alias and wrapped variants', () => {
    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      exchangeSymbol: 'ETHUSDC',
    })).toMatchObject({
      canonicalAssetKey: 'ETH',
      aliasHit: false,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      exchangeSymbol: 'FDUSDUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'FDUSD',
      aliasHit: false,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      symbol: '1000SHIB',
      exchangeSymbol: '1000SHIBUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'SHIB',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'RNDR',
    })).toMatchObject({
      canonicalAssetKey: 'RENDER',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'USDC.E',
    })).toMatchObject({
      canonicalAssetKey: 'USDC',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      symbol: 'WBTC',
    })).toMatchObject({
      canonicalAssetKey: 'BTC',
      aliasHit: true,
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'upbit',
      symbol: 'T',
      exchangeSymbol: 'KRW-T',
    })).toMatchObject({
      canonicalAssetKey: 'T',
      aliasHit: true,
      matchedBy: 'exchange_alias',
    });

    expect(resolveCanonicalAssetKey({
      exchange: 'binance',
      symbol: '1000000MOG',
      exchangeSymbol: '1000000MOGUSDT',
    })).toMatchObject({
      canonicalAssetKey: 'MOG',
      aliasHit: true,
    });
  });
});
