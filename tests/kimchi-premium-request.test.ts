import { describe, expect, it } from 'vitest';
import { normalizeKimchiPremiumQuery } from '../src/domains/kimchi-premium/kimchi-premium.request';

describe('kimchi premium request normalization', () => {
  it('normalizes comma-separated symbols by trimming, uppercasing, and deduping', () => {
    const normalized = normalizeKimchiPremiumQuery({
      symbols: ' btc, ETH ,btc , xrp ',
      venue: 'upbit',
    });

    expect(normalized.symbols).toEqual(['BTC', 'ETH', 'XRP']);
    expect(normalized.venues).toEqual(['upbit']);
    expect(normalized.quoteCurrency).toBe('KRW');
  });

  it('rejects wildcard-like symbol values and points clients to the symbols endpoint', () => {
    expect(() =>
      normalizeKimchiPremiumQuery({
        symbols: 'all',
        venue: 'upbit',
      }),
    ).toThrowError(/explicit canonical symbols/i);
  });

  it('rejects raw exchange symbols and requires canonical-only symbols', () => {
    expect(() =>
      normalizeKimchiPremiumQuery({
        symbols: 'KRW-BTC,BTCUSDT',
        venue: 'upbit',
      }),
    ).toThrowError(/canonical symbols only/i);
  });

  it('rejects unsupported quote currencies', () => {
    expect(() =>
      normalizeKimchiPremiumQuery({
        symbols: 'BTC',
        venue: 'upbit',
        quoteCurrency: 'USDT',
      }),
    ).toThrowError(/unsupported quoteCurrency/i);
  });

  it('accepts domesticExchange as an alias of venue/exchange', () => {
    const normalized = normalizeKimchiPremiumQuery({
      symbols: 'BTC',
      domesticExchange: 'coinone',
    });

    expect(normalized.venues).toEqual(['coinone']);
  });
});
