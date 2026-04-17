import { describe, expect, it } from 'vitest';
import { exchangeProviderRegistry } from '../src/core/exchange/registry.bootstrap';

describe('Exchange Provider Registry', () => {
  it('registers market providers and reference sources', () => {
    expect(exchangeProviderRegistry.getMarketDataProvider('upbit').exchange).toBe('upbit');
    expect(exchangeProviderRegistry.getMarketDataProvider('binance').exchange).toBe('binance');
    expect(exchangeProviderRegistry.getReferencePriceSource()).toBeTruthy();
    expect(exchangeProviderRegistry.getFxRateProvider()).toBeTruthy();
  });

  it('registers domestic trading and portfolio providers', () => {
    expect(exchangeProviderRegistry.getTradingProvider('upbit').exchange).toBe('upbit');
    expect(exchangeProviderRegistry.getTradingProvider('bithumb').exchange).toBe('bithumb');
    expect(exchangeProviderRegistry.getTradingProvider('coinone').exchange).toBe('coinone');
    expect(exchangeProviderRegistry.getTradingProvider('korbit').exchange).toBe('korbit');

    expect(exchangeProviderRegistry.getPortfolioProvider('upbit').exchange).toBe('upbit');
    expect(exchangeProviderRegistry.getPortfolioProvider('bithumb').exchange).toBe('bithumb');
    expect(exchangeProviderRegistry.getPortfolioProvider('coinone').exchange).toBe('coinone');
    expect(exchangeProviderRegistry.getPortfolioProvider('korbit').exchange).toBe('korbit');
  });
});
