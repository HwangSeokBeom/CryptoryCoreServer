import { describe, expect, it } from 'vitest';
import { buildStreamSubscriptionPlan } from '../src/core/exchange/stream-subscription.plan';

describe('Stream subscription plan', () => {
  it('keeps reconnect resync scoped to active channel subscriptions', () => {
    const plan = buildStreamSubscriptionPlan({
      subscriptions: [
        {
          exchange: 'bithumb',
          channel: 'tickers',
          symbols: ['BTC', 'ETH', 'MATIC'],
        },
      ],
      supportedSymbolsByChannel: {
        tickers: ['BTC', 'ETH'],
        orderbook: ['BTC', 'ETH'],
        trades: ['BTC', 'ETH'],
        candles: [],
      },
    });

    expect(plan.activeChannels).toEqual(['tickers']);
    expect(plan.resolvedByChannel.tickers).toEqual(['BTC', 'ETH']);
    expect(plan.resolvedByChannel.orderbook).toEqual([]);
    expect(plan.resolvedByChannel.trades).toEqual([]);
    expect(plan.skippedSymbols).toEqual([
      {
        channel: 'tickers',
        symbol: 'MATIC',
        reason: 'not_listed_on_exchange_market_universe',
      },
    ]);
  });

  it('excludes capability-specific unsupported symbols without dropping ticker scope', () => {
    const plan = buildStreamSubscriptionPlan({
      subscriptions: [
        {
          exchange: 'bithumb',
          channel: 'tickers',
          symbols: ['BTC', 'ETH'],
        },
        {
          exchange: 'bithumb',
          channel: 'orderbook',
          symbols: ['BTC', 'ETH'],
        },
      ],
      supportedSymbolsByChannel: {
        tickers: ['BTC', 'ETH'],
        orderbook: ['BTC', 'ETH'],
        trades: [],
        candles: [],
      },
      capabilityExclusionsByChannel: {
        orderbook: new Map([['ETH', 'unsupported_symbol']]),
      },
    });

    expect(plan.activeChannels).toEqual(['tickers', 'orderbook']);
    expect(plan.resolvedByChannel.tickers).toEqual(['BTC', 'ETH']);
    expect(plan.resolvedByChannel.orderbook).toEqual(['BTC']);
    expect(plan.skippedSymbols).toContainEqual({
      channel: 'orderbook',
      symbol: 'ETH',
      reason: 'unsupported_symbol',
    });
  });
});
