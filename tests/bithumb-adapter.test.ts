import { afterEach, describe, expect, it, vi } from 'vitest';
import { BithumbAdapter } from '../src/exchanges/BithumbAdapter';

const originalFetch = global.fetch;

describe('BithumbAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('accepts nested orderbook payload shapes', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: '0000',
          data: {
            data: {
              asks: [{ price: '101', quantity: '1.2' }],
              bids: [{ price: '99', quantity: '0.8' }],
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )) as typeof fetch;

    const result = await new BithumbAdapter().fetchOrderbook('BTC', 1);

    expect(result.asks).toHaveLength(1);
    expect(result.bids).toHaveLength(1);
    expect(result.asks[0]).toEqual({ price: 101, qty: 1.2 });
    expect(result.bids[0]).toEqual({ price: 99, qty: 0.8 });
  });

  it('throws a descriptive error for malformed orderbook payloads', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: '0000',
          data: {
            timestamp: '1710000000000',
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )) as typeof fetch;

    await expect(new BithumbAdapter().fetchOrderbook('BTC', 1)).rejects.toThrow(/malformed payload/i);
    await expect(new BithumbAdapter().fetchOrderbook('BTC', 1)).rejects.toThrow(/shape=/i);
  });

  it('classifies unlisted orderbook payloads as unsupported symbols', async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: '5500',
          message: '상장 코인 아님',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )) as typeof fetch;

    await expect(new BithumbAdapter().fetchOrderbook('MATIC', 1)).rejects.toMatchObject({
      name: 'ExchangeUnsupportedSymbolError',
      kind: 'unsupported_symbol',
      symbol: 'MATIC',
    });
  });
});
