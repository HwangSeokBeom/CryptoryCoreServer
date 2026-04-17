import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeRequestError } from '../src/core/exchange/errors';
import { KorbitProvider } from '../src/providers/exchanges/korbit.provider';

describe('KorbitProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the v2 trades endpoint with symbol query', async () => {
    const provider = new KorbitProvider();
    const request = vi.fn().mockResolvedValue({
      success: true,
      data: [
        {
          tradeId: 42,
          price: '100',
          qty: '0.25',
          isBuyerTaker: false,
          timestamp: 1710000000000,
        },
      ],
    });
    (provider as any).restClient.request = request;

    const [trade] = await provider.getRecentTrades('BTC', 1);

    expect(request).toHaveBeenCalledWith(
      '/v2/trades',
      expect.objectContaining({
        query: {
          symbol: 'btc_krw',
          limit: 1,
        },
      }),
    );
    expect(trade.side).toBe('sell');
    expect(trade.tradeId).toBe('42');
  });

  it('suppresses repeated recent-trade polling after a Cloudflare block', async () => {
    const provider = new KorbitProvider();
    const blockedError = new ExchangeRequestError(
      'korbit',
      403,
      'https://api.korbit.co.kr/v1/transactions?currency_pair=btc_krw',
      'korbit request failed with HTTP 403',
      '<!DOCTYPE html><title>Attention Required! | Cloudflare</title>',
    );
    const request = vi.fn().mockRejectedValueOnce(blockedError);
    (provider as any).restClient.request = request;

    await expect(provider.getRecentTrades('BTC', 10)).rejects.toBe(blockedError);

    const suppressedResult = await provider.getRecentTrades('BTC', 10);

    expect(suppressedResult).toEqual([]);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
