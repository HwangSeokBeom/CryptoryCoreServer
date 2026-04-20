import { describe, expect, it, vi } from 'vitest';
import { UpbitProvider } from '../src/providers/exchanges/upbit.provider';

describe('provider resync universe', () => {
  it('keeps reconnect/resync scoped to the actual subscribed universe instead of the curated registry', async () => {
    const provider = new UpbitProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'KRW-BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradable: true,
      },
      {
        symbol: 'TNSR',
        exchangeSymbol: 'KRW-TNSR',
        market: 'TNSR/KRW',
        baseCurrency: 'TNSR',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-TNSR',
        tradable: true,
      },
    ]);

    (provider as any).activeSubscriptions = [
      {
        exchange: 'upbit',
        channel: 'tickers',
        symbols: ['BTC', 'TNSR', 'MATIC'],
      },
    ];
    (provider as any).supportedStreamSymbols = new Set(['BTC', 'TNSR']);

    const plan = await (provider as any).buildActiveStreamPlan();

    expect(plan.resolvedByChannel.tickers).toEqual(['BTC', 'TNSR']);
    expect(plan.skippedSymbols).toEqual([
      {
        channel: 'tickers',
        symbol: 'MATIC',
        reason: 'not_listed_on_exchange_market_universe',
      },
    ]);
  });
});
