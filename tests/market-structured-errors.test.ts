import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exchangeProviderRegistry } from '../src/core/exchange/registry.bootstrap';
import { publicMarketDataStore } from '../src/modules/public-market/market.data.store';

const korbitProvider = {
  exchange: 'korbit',
  metadata: {
    displayName: '코빗',
    quoteCurrency: 'KRW',
    capabilities: [],
  },
  listMarkets: vi.fn(),
  getMarketCapabilitySnapshot: vi.fn(),
  getTickerSnapshot: vi.fn(),
  getOrderbookSnapshot: vi.fn(),
  getRecentTrades: vi.fn(),
  getCandles: vi.fn(),
};

function mockKorbitMarket() {
  korbitProvider.listMarkets.mockResolvedValue([
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
  korbitProvider.getMarketCapabilitySnapshot.mockResolvedValue({
    websocketTickerSymbols: ['BTC'],
    capabilitySymbols: {
      tickers: ['BTC'],
      orderbook: ['BTC'],
      trades: ['BTC'],
      candles: ['BTC'],
    },
  });
}

describe('structured market data responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(exchangeProviderRegistry, 'getMarketDataProvider').mockReturnValue(korbitProvider as never);
    vi.spyOn(exchangeProviderRegistry, 'listMarketDataProviders').mockReturnValue([korbitProvider] as never);
    vi.spyOn(exchangeProviderRegistry, 'getReferencePriceSource').mockReturnValue({
      getReferenceTicker: vi.fn(),
    } as never);
    mockKorbitMarket();
    vi.spyOn(publicMarketDataStore, 'getOrderbook').mockReturnValue(null);
    vi.spyOn(publicMarketDataStore, 'getTrades').mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns structured candle unavailable errors with metadata', async () => {
    korbitProvider.getCandles.mockImplementation(async () => {
      throw new Error('Korbit candles HTTP 503');
    });

    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { createMarketDataErrorBody, MarketDataAvailabilityError } = await import('../src/domains/market-data/market-data.errors');

    let body: ReturnType<typeof createMarketDataErrorBody> | null = null;
    try {
      await getCandlesWithMeta('korbit', { marketId: 'btc_krw' }, '1h', 60);
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataAvailabilityError);
      body = createMarketDataErrorBody(error as InstanceType<typeof MarketDataAvailabilityError>);
    }

    expect(body).not.toBeNull();
    expect(body).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'candles',
      exchange: 'korbit',
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
      retryable: true,
      metadata: {
        marketId: 'btc_krw',
        canonicalSymbol: 'BTC',
        iconUrl: expect.stringContaining('/btc.png'),
      },
    });
  }, 10000);

  it('returns structured candle unsupported errors with capability metadata', async () => {
    korbitProvider.getMarketCapabilitySnapshot.mockResolvedValueOnce({
      websocketTickerSymbols: ['BTC'],
      capabilitySymbols: {
        tickers: ['BTC'],
        orderbook: ['BTC'],
        trades: ['BTC'],
        candles: [],
      },
      capabilityExcludedSymbols: {
        candles: [{ symbol: 'BTC', reason: 'provider_not_supported' }],
      },
    });

    const { getCandlesWithMeta } = await import('../src/domains/market-data/market-data.service');
    const { createMarketDataErrorBody, MarketDataAvailabilityError } = await import('../src/domains/market-data/market-data.errors');

    let body: ReturnType<typeof createMarketDataErrorBody> | null = null;
    try {
      await getCandlesWithMeta('korbit', { marketId: 'btc_krw' }, '1h', 60);
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataAvailabilityError);
      expect((error as InstanceType<typeof MarketDataAvailabilityError>).statusCode).toBe(400);
      body = createMarketDataErrorBody(error as InstanceType<typeof MarketDataAvailabilityError>);
    }

    expect(korbitProvider.getCandles).not.toHaveBeenCalled();
    expect(body).not.toBeNull();
    expect(body).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'candles',
      exchange: 'korbit',
      marketId: 'btc_krw',
      canonicalMarketId: 'BTC/KRW',
      canonicalSymbol: 'BTC',
      candlesSupported: false,
      graphSupported: false,
      supportedIntervals: [],
      retryable: false,
      reason: 'provider_not_supported',
    });
  });

  it('returns structured orderbook unavailable errors when no stale cache exists', async () => {
    korbitProvider.getOrderbookSnapshot.mockRejectedValueOnce(new Error('Korbit orderbook HTTP 503'));

    const { getOrderbook } = await import('../src/domains/market-data/market-data.service');
    const { createMarketDataErrorBody, MarketDataAvailabilityError } = await import('../src/domains/market-data/market-data.errors');

    let body: ReturnType<typeof createMarketDataErrorBody> | null = null;
    try {
      await getOrderbook('korbit', { marketId: 'btc_krw' });
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataAvailabilityError);
      body = createMarketDataErrorBody(error as InstanceType<typeof MarketDataAvailabilityError>);
    }

    expect(korbitProvider.getOrderbookSnapshot).toHaveBeenCalledWith('BTC');
    expect(body).not.toBeNull();
    expect(body).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      target: 'orderbook',
      exchange: 'korbit',
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
    });
  });

  it('treats empty trades as a successful empty section', async () => {
    korbitProvider.getRecentTrades.mockResolvedValueOnce([]);

    const { getTradesWithMeta } = await import('../src/domains/market-data/market-data.service');

    const response = await getTradesWithMeta('korbit', { marketId: 'btc_krw' }, 20);

    expect(response.items).toEqual([]);
    expect(response.total).toBe(0);
    expect(response.metadata).toMatchObject({
      marketId: 'btc_krw',
      canonicalSymbol: 'BTC',
      availability: {
        trades: 'available',
      },
    });
  });

  it('rejects ambiguous symbol input before calling Korbit upstream', async () => {
    const { getOrderbook } = await import('../src/domains/market-data/market-data.service');
    const { createMarketDataErrorBody, MarketDataAvailabilityError } = await import('../src/domains/market-data/market-data.errors');

    let body: ReturnType<typeof createMarketDataErrorBody> | null = null;
    try {
      await getOrderbook('korbit', { symbol: 'C' });
    } catch (error) {
      expect(error).toBeInstanceOf(MarketDataAvailabilityError);
      body = createMarketDataErrorBody(error as InstanceType<typeof MarketDataAvailabilityError>);
    }

    expect(korbitProvider.getOrderbookSnapshot).not.toHaveBeenCalled();
    expect(body).not.toBeNull();
    expect(body).toMatchObject({
      success: false,
      code: 'MARKET_DATA_UNSUPPORTED',
      target: 'orderbook',
      exchange: 'korbit',
      retryable: false,
    });
  });
});
