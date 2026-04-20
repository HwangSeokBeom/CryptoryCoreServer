import { describe, expect, it } from 'vitest';
import { serializeTradeDto } from '../src/modules/public-market/public-market.contract';
import {
  normalizeExchangeTimestamp,
  normalizeExchangeTimestampFromCandidates,
  toIsoTimestamp,
} from '../src/providers/exchanges/provider-utils';

describe('trade timestamp normalization', () => {
  it('normalizes second-based exchange timestamps to epoch milliseconds', () => {
    const normalized = normalizeExchangeTimestampFromCandidates(['1713578123'], {
      assumeTimezone: 'UTC',
    });

    expect(normalized.raw).toBe(1_713_578_123);
    expect(normalized.timestamp).toBe(1_713_578_123_000);
    expect(normalized.reason).toBeNull();
    expect(toIsoTimestamp(normalized.timestamp)).toBe('2024-04-20T01:55:23.000Z');
  });

  it('normalizes bithumb-style local datetime strings using KST', () => {
    const normalized = normalizeExchangeTimestampFromCandidates(['2026-04-20 09:12:03.456'], {
      assumeTimezone: 'KST',
    });

    expect(normalized.timestamp).toBe(1_776_643_923_456);
    expect(toIsoTimestamp(normalized.timestamp)).toBe('2026-04-20T00:12:03.456Z');
  });

  it('blocks date-only timestamps instead of fabricating a default time', () => {
    const normalized = normalizeExchangeTimestamp('2026-04-20', {
      assumeTimezone: 'KST',
    });

    expect(normalized).toEqual({
      raw: '2026-04-20',
      timestamp: null,
      reason: 'date_only_string_blocked',
    });
  });

  it('preserves invalid trade times as null in the serialized contract', () => {
    const trade = serializeTradeDto({
      channel: 'trades',
      exchange: 'bithumb',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'BTC_KRW',
      tradeId: 'trade-1',
      side: 'buy',
      price: 100_000_000,
      quantity: 0.01,
      timestamp: null,
      executedAt: null,
    } as never);

    expect(trade.timestamp).toBeNull();
    expect(trade.executedAt).toBeNull();
  });
});
