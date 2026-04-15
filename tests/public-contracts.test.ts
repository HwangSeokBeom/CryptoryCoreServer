import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKET_WS_PROTOCOL_VERSION,
  serializeCandlesResponse,
  serializeKimchiPremiumResponse,
  serializeOrderbookResponse,
  serializeTickersResponse,
  serializeTradesResponse,
  serializeWsWelcomePayload,
  wsMarketRequestSchema,
} from '../src/modules/public-market/public-market.contract';

describe('Public Market Contracts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes ticker, orderbook, trades, candles, and kimchi premium responses', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_712_345_678_000);

    const tickers = serializeTickersResponse([
      {
        channel: 'tickers',
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        price: 100000000,
        change24h: 1.25,
        volume24h: 1234,
        high24h: 101000000,
        low24h: 98000000,
        timestamp: 1_712_345_678_000,
      },
    ]);
    const orderbook = serializeOrderbookResponse({
      channel: 'orderbook',
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      bestAsk: 100010000,
      bestBid: 99990000,
      asks: [{ price: 100010000, qty: 0.2 }],
      bids: [{ price: 99990000, qty: 0.3 }],
      timestamp: 1_712_345_678_000,
    });
    const trades = serializeTradesResponse('upbit', 'BTC', 'BTC/KRW', [
      {
        channel: 'trades',
        exchange: 'upbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'KRW-BTC',
        tradeId: 'trade-1',
        side: 'buy',
        price: 100000000,
        quantity: 0.01,
        timestamp: 1_712_345_678_000,
      },
    ]);
    const candles = serializeCandlesResponse({
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      interval: '1h',
      items: [
        {
          time: 1_712_345_320_000,
          open: 99000000,
          high: 101000000,
          low: 98500000,
          close: 100000000,
          volume: 321,
        },
      ],
    });
    const kimchi = serializeKimchiPremiumResponse([
      {
        symbol: 'BTC',
        nameKo: '비트코인',
        nameEn: 'Bitcoin',
        binanceKrwPrice: 99500000,
        premiums: [
          {
            exchange: 'upbit',
            exchangeName: '업비트',
            domesticPrice: 100000000,
            premiumPercent: 0.5,
          },
        ],
      },
    ]);

    expect(tickers.total).toBe(1);
    expect(tickers.snapshotAt).toBe(1_712_345_678_000);
    expect(orderbook.spread).toBe(20000);
    expect(trades.items[0].notional).toBe(1000000);
    expect(candles.items[0].close).toBe(100000000);
    expect(kimchi.items[0].domestic[0].market).toBe('BTC/KRW');
  });

  it('accepts the fixed websocket subscribe payload and emits versioned welcome payload', () => {
    const parsed = wsMarketRequestSchema.parse({
      requestId: 'req-1',
      action: 'subscribe',
      channel: 'orderbook',
      exchange: 'upbit',
      symbols: ['BTC', 'ETH'],
    });
    const welcome = serializeWsWelcomePayload();

    expect(parsed.channel).toBe('orderbook');
    expect(parsed.symbols).toEqual(['BTC', 'ETH']);
    expect(welcome.protocolVersion).toBe(MARKET_WS_PROTOCOL_VERSION);
    expect(welcome.path).toBe('/ws/market');
  });
});
