import { describe, expect, it } from 'vitest';
import { resolveExchangeInterval } from '../src/core/exchange/interval.mapper';
import { fromExchangeSymbol, toExchangeSymbol } from '../src/core/exchange/symbol.mapper';

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
});
