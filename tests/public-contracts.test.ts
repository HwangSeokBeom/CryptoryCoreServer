import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARKET_WS_PROTOCOL_VERSION,
  serializeCandlesResponse,
  serializeKimchiPremiumResponse,
  serializeOrderbookResponse,
  serializeTickersResponse,
  serializeTradesResponse,
  serializeWsWelcomePayload,
  serializeWsCandleEvent,
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
        canonicalAssetKey: 'BTC',
        assetImageUrl: 'https://assets.example.com/btc.png',
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
      meta: {
        isRenderable: true,
        freshnessState: 'live',
        lastSuccessfulAt: 1_712_345_678_000,
        source: 'memory',
        fallbackReason: null,
        pointCount: 1,
        renderPriority: 'cached',
        refreshPriority: 'visible',
        recommendedClientBehavior: 'first_paint_ok',
      },
    });
    const kimchi = serializeKimchiPremiumResponse([
      {
        symbol: 'BTC',
        canonicalAssetKey: 'BTC',
        assetImageUrl: 'https://assets.example.com/btc.png',
        nameKo: '비트코인',
        nameEn: 'Bitcoin',
        displayMeta: {
          status: 'ready',
          hasUsableDomesticPrice: true,
          hasUsableReferencePrice: true,
          hasUsableFxRate: true,
          lastSuccessfulDomesticAt: 1_712_345_678_000,
          lastSuccessfulReferenceAt: 1_712_345_678_000,
          lastSuccessfulFxAt: 1_712_345_678_000,
          delayBucket: 'none',
          displayHint: 'keep_last_good',
        },
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
    expect(tickers.items[0].canonicalAssetKey).toBe('BTC');
    expect(tickers.items[0].assetImageUrl).toBe('https://assets.example.com/btc.png');
    expect(orderbook.spread).toBe(20000);
    expect(trades.items[0].notional).toBe(1000000);
    expect(candles.items[0].close).toBe(100000000);
    expect(candles.meta?.freshnessState).toBe('live');
    expect(candles.meta?.recommendedClientBehavior).toBe('first_paint_ok');
    expect(kimchi.items[0].domestic[0].market).toBe('BTC/KRW');
    expect(kimchi.items[0].canonicalAssetKey).toBe('BTC');
    expect(kimchi.items[0].assetImageUrl).toBe('https://assets.example.com/btc.png');
    expect(kimchi.items[0].displayMeta?.status).toBe('ready');
    expect(kimchi.items[0].displayHint).toBe('keep_last_good');
  });

  it('serializes partial and unavailable kimchi rows with terminal statuses', () => {
    const kimchi = serializeKimchiPremiumResponse([
      {
        symbol: 'BTC',
        nameKo: '비트코인',
        nameEn: 'Bitcoin',
        status: 'partial',
        missingFields: ['domesticPrice', 'premiumPercent'],
        failureStage: 'domestic_ticker',
        binanceKrwPrice: 99500000,
        convertedReferencePrice: 99500000,
        domesticPrice: null,
        premiumPercent: null,
        premiums: [],
      },
      {
        symbol: 'ETH',
        nameKo: '이더리움',
        nameEn: 'Ethereum',
        status: 'unavailable',
        missingFields: ['referencePrice', 'domesticPrice', 'premiumPercent'],
        failureStage: 'reference_ticker',
        binanceKrwPrice: null,
        convertedReferencePrice: null,
        domesticPrice: null,
        premiumPercent: null,
        premiums: [],
      },
    ]);

    expect(kimchi.items[0].status).toBe('partial');
    expect(kimchi.items[0].failureStage).toBe('domestic_ticker');
    expect(kimchi.items[0].domesticPrice).toBeNull();
    expect(kimchi.items[1].status).toBe('unavailable');
    expect(kimchi.items[1].binanceKrwPrice).toBeNull();
  });

  it('serializes stale kimchi rows as a terminal status', () => {
    const kimchi = serializeKimchiPremiumResponse([
      {
        symbol: 'BTC',
        nameKo: '비트코인',
        nameEn: 'Bitcoin',
        status: 'stale',
        missingFields: [],
        failureStage: null,
        binanceKrwPrice: 99500000,
        convertedReferencePrice: 99500000,
        domesticPrice: 100000000,
        premiumPercent: 0.5,
        premiums: [
          {
            exchange: 'upbit',
            exchangeName: '업비트',
            domesticPrice: 100000000,
            premiumPercent: 0.5,
            reason: null,
          },
        ],
      },
    ]);

    expect(kimchi.items[0].status).toBe('stale');
    expect(kimchi.items[0].domesticPrice).toBe(100000000);
  });

  it('accepts the fixed websocket subscribe payload and emits versioned welcome payload', () => {
    const parsed = wsMarketRequestSchema.parse({
      requestId: 'req-1',
      action: 'subscribe',
      channel: 'candles',
      exchange: 'upbit',
      symbols: ['BTC', 'ETH'],
      interval: '1m',
    });
    const welcome = serializeWsWelcomePayload();
    const candleEvent = serializeWsCandleEvent({
      channel: 'candles',
      exchange: 'upbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'KRW-BTC',
      interval: '1m',
      openTime: 1_712_345_620_000,
      closeTime: 1_712_345_680_000,
      open: 100000000,
      high: 100100000,
      low: 99900000,
      close: 100050000,
      volume: 1.2,
      asOf: 1_712_345_650_000,
      confirmed: false,
      candleStatus: 'live',
      sourceEvent: 'trade',
      timestamp: 1_712_345_650_000,
    });

    expect(parsed.channel).toBe('candles');
    expect(parsed.symbols).toEqual(['BTC', 'ETH']);
    expect(parsed.interval).toBe('1m');
    expect(welcome.protocolVersion).toBe(MARKET_WS_PROTOCOL_VERSION);
    expect(welcome.path).toBe('/ws/market');
    expect(welcome.channels).toContain('candles');
    expect(candleEvent.data.interval).toBe('1m');
  });
});
