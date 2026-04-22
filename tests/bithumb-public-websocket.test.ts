import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketStreamSink } from '../src/core/exchange/provider.interfaces';

const managerInstances: MockWebSocketClientManager[] = [];

class MockWebSocketClientManager {
  readonly sendJson = vi.fn();
  readonly stop = vi.fn(async () => {});

  constructor(public readonly definition: any) {
    managerInstances.push(this);
  }

  async start() {
    await this.definition.onOpen(this);
  }

  getReconnectMetadata() {
    return null;
  }

  getDiagnostics() {
    return {
      instanceId: 'mock-ws-client',
      reconnectScheduled: false,
    };
  }
}

vi.mock('../src/core/exchange/websocket.client-manager', () => ({
  WebSocketClientManager: MockWebSocketClientManager,
}));

describe('Bithumb public websocket provider', () => {
  beforeEach(() => {
    managerInstances.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the documented array-based websocket subscription payload and skips duplicate starts', async () => {
    const { BithumbProvider } = await import('../src/providers/exchanges/bithumb.provider');
    const provider = new BithumbProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC', tradable: true },
    ] as any);
    vi.spyOn(provider, 'getTickerSnapshot').mockResolvedValue([]);
    vi.spyOn(provider, 'getOrderbookSnapshot').mockResolvedValue({
      exchange: 'bithumb',
      symbol: 'BTC',
      market: 'BTC/KRW',
      asks: [],
      bids: [],
      bestAsk: 0,
      bestBid: 0,
      spread: 0,
      timestamp: Date.now(),
    } as any);
    vi.spyOn(provider, 'getRecentTrades').mockResolvedValue([]);

    const sink: MarketStreamSink = {
      onTicker: vi.fn(),
      onOrderbook: vi.fn(),
      onTrade: vi.fn(),
      onReconnect: vi.fn(),
    };

    const subscriptions = [
      { exchange: 'bithumb', channel: 'tickers' as const, symbols: ['BTC'] },
      { exchange: 'bithumb', channel: 'orderbook' as const, symbols: ['BTC'] },
      { exchange: 'bithumb', channel: 'trades' as const, symbols: ['BTC'] },
    ];

    await provider.startPublicStream(subscriptions, sink);
    await provider.startPublicStream(subscriptions, sink);

    expect(managerInstances).toHaveLength(1);
    expect(managerInstances[0].sendJson).toHaveBeenCalledTimes(1);

    const [payload] = managerInstances[0].sendJson.mock.calls[0];
    expect(payload).toEqual([
      { ticket: expect.stringMatching(/^bithumb-public-/) },
      { type: 'ticker', codes: ['KRW-BTC'], isOnlyRealtime: true },
      { type: 'orderbook', codes: ['KRW-BTC'], isOnlyRealtime: true },
      { type: 'trade', codes: ['KRW-BTC'], isOnlyRealtime: true },
      { format: 'DEFAULT' },
    ]);
  });

  it('parses documented ticker, orderbook, and trade websocket payloads', async () => {
    const { BithumbProvider } = await import('../src/providers/exchanges/bithumb.provider');
    const provider = new BithumbProvider();
    vi.spyOn(provider, 'listMarkets').mockResolvedValue([
      { symbol: 'BTC', market: 'BTC/KRW', rawSymbol: 'KRW-BTC', tradable: true },
    ] as any);
    vi.spyOn(provider, 'getTickerSnapshot').mockResolvedValue([]);
    vi.spyOn(provider, 'getOrderbookSnapshot').mockResolvedValue({
      exchange: 'bithumb',
      symbol: 'BTC',
      market: 'BTC/KRW',
      asks: [],
      bids: [],
      bestAsk: 0,
      bestBid: 0,
      spread: 0,
      timestamp: Date.now(),
    } as any);
    vi.spyOn(provider, 'getRecentTrades').mockResolvedValue([]);

    const sink: MarketStreamSink = {
      onTicker: vi.fn(),
      onOrderbook: vi.fn(),
      onTrade: vi.fn(),
      onReconnect: vi.fn(),
    };

    await provider.startPublicStream([
      { exchange: 'bithumb', channel: 'tickers', symbols: ['BTC'] },
      { exchange: 'bithumb', channel: 'orderbook', symbols: ['BTC'] },
      { exchange: 'bithumb', channel: 'trades', symbols: ['BTC'] },
    ], sink);

    const manager = managerInstances[0];

    await manager.definition.onMessage(Buffer.from(JSON.stringify({
      type: 'ticker',
      code: 'KRW-BTC',
      trade_price: 115_831_000,
      signed_change_rate: 0.03328278,
      acc_trade_price_24h: 90_085_274_658.4914,
      high_price: 115_931_000,
      low_price: 111_400_000,
      trade_timestamp: 1_776_863_191_822,
      timestamp: 1_776_863_192_210,
      trade_date: '20260422',
      trade_time: '220631',
    })), manager);

    await manager.definition.onMessage(Buffer.from(JSON.stringify({
      type: 'orderbook',
      code: 'KRW-BTC',
      orderbook_units: [
        { ask_price: 115_831_000, ask_size: 0.0011, bid_price: 115_820_000, bid_size: 0.0404 },
        { ask_price: 115_832_000, ask_size: 0.2234, bid_price: 115_819_000, bid_size: 0.1279 },
      ],
      timestamp: 1_776_863_188_534_786,
    })), manager);

    await manager.definition.onMessage(Buffer.from(JSON.stringify({
      type: 'trade',
      code: 'KRW-BTC',
      trade_price: 115_830_000,
      trade_volume: 0.00028731,
      ask_bid: 'BID',
      trade_timestamp: 1_776_863_191_822,
      timestamp: 1_776_863_192_203,
      sequential_id: '634675095989675400',
      trade_date: '2026-04-22',
      trade_time: '22:06:31',
    })), manager);

    expect(sink.onTicker).toHaveBeenCalledWith(expect.objectContaining({
      exchange: 'bithumb',
      symbol: 'BTC',
      price: 115_831_000,
      change24h: 0.03328278,
      high24h: 115_931_000,
      low24h: 111_400_000,
      volume24h: 90_085_274_658.4914,
      timestamp: 1_776_863_191_822,
    }));

    expect(sink.onOrderbook).toHaveBeenCalledWith(expect.objectContaining({
      exchange: 'bithumb',
      symbol: 'BTC',
      bestAsk: 115_831_000,
      bestBid: 115_820_000,
      spread: 11_000,
      timestamp: 1_776_863_188_534,
    }));

    expect(sink.onTrade).toHaveBeenCalledWith(expect.objectContaining({
      exchange: 'bithumb',
      symbol: 'BTC',
      tradeId: '634675095989675400',
      side: 'buy',
      price: 115_830_000,
      quantity: 0.00028731,
      timestamp: 1_776_863_191_822,
    }));
  });
});
