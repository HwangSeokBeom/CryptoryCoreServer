import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = {
  exchange: 'korbit',
  metadata: {
    displayName: '코빗',
    quoteCurrency: 'KRW',
  },
  listMarkets: vi.fn(),
  getMarketCapabilitySnapshot: vi.fn(),
  getTickerSnapshot: vi.fn(),
  getOrderbookSnapshot: vi.fn(),
  getRecentTrades: vi.fn(),
  getCandles: vi.fn(),
};

const publicMarketDataStore = {
  getTickers: vi.fn(() => []),
  getOrderbook: vi.fn(() => null),
  getTrades: vi.fn(() => []),
};

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getMarketDataProvider: vi.fn(() => provider),
    listMarketDataProviders: vi.fn(() => [provider]),
    getReferencePriceSource: vi.fn(() => ({
      getReferenceTicker: vi.fn(),
    })),
  },
}));

vi.mock('../src/modules/public-market/market.data.store', () => ({
  publicMarketDataStore,
}));

describe('market-data.service fallbacks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    publicMarketDataStore.getTickers.mockReturnValue([]);
    publicMarketDataStore.getOrderbook.mockReturnValue(null);
    publicMarketDataStore.getTrades.mockReturnValue([]);
    provider.listMarkets.mockResolvedValue([
      {
        symbol: 'BTC',
        exchangeSymbol: 'btc_krw',
        marketId: 'btc_krw',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'btc_krw',
        tradable: true,
      },
    ]);
    provider.getMarketCapabilitySnapshot.mockResolvedValue({
      websocketTickerSymbols: ['BTC'],
      capabilitySymbols: {
        tickers: ['BTC'],
        orderbook: ['BTC'],
        trades: ['BTC'],
        candles: ['BTC'],
      },
    });
  });

  it('falls back to cached orderbook data when provider snapshot fails', async () => {
    provider.getOrderbookSnapshot.mockRejectedValueOnce(new Error('orderbook failed'));
    publicMarketDataStore.getOrderbook.mockReturnValueOnce({
      channel: 'orderbook',
      exchange: 'korbit',
      symbol: 'BTC',
      market: 'BTC/KRW',
      baseCurrency: 'BTC',
      quoteCurrency: 'KRW',
      rawSymbol: 'btc_krw',
      asks: [{ price: 101, qty: 1 }],
      bids: [{ price: 99, qty: 2 }],
      bestAsk: 101,
      bestBid: 99,
      timestamp: 1710000000000,
    });

    const { getOrderbook } = await import('../src/domains/market-data/market-data.service');
    const snapshot = await getOrderbook('korbit', 'BTC');

    expect(publicMarketDataStore.getOrderbook).toHaveBeenCalledWith('korbit', 'BTC');
    expect(snapshot.marketId).toBe('btc_krw');
    expect(snapshot.displaySymbol).toBe('BTC/KRW');
    expect(snapshot.bestAsk).toBe(101);
    expect(snapshot.bestBid).toBe(99);
    expect(snapshot.sourceTimestamp).toBe(1710000000000);
  });

  it('falls back to cached trade data when provider returns no trades', async () => {
    provider.getRecentTrades.mockResolvedValueOnce([]);
    publicMarketDataStore.getTrades.mockReturnValueOnce([
      {
        channel: 'trades',
        exchange: 'korbit',
        symbol: 'BTC',
        market: 'BTC/KRW',
        baseCurrency: 'BTC',
        quoteCurrency: 'KRW',
        rawSymbol: 'btc_krw',
        tradeId: 'cached-trade',
        price: 100,
        quantity: 0.1,
        side: 'buy',
        timestamp: 1710000000000,
      },
    ]);

    const { getTrades } = await import('../src/domains/market-data/market-data.service');
    const trades = await getTrades('korbit', 'BTC', 20);

    expect(publicMarketDataStore.getTrades).toHaveBeenCalledWith('korbit', 'BTC', 20);
    expect(trades).toHaveLength(1);
    expect(trades[0].marketId).toBe('btc_krw');
    expect(trades[0].tradeId).toBe('cached-trade');
    expect(trades[0].notional).toBe(10);
  });
});
