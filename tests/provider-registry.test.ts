import { describe, expect, it } from 'vitest';
import { exchangeProviderRegistry } from '../src/core/exchange/registry.bootstrap';

describe('Exchange Provider Registry', () => {
  it('registers market providers and reference sources', () => {
    expect(exchangeProviderRegistry.getMarketDataProvider('upbit').exchange).toBe('upbit');
    expect(exchangeProviderRegistry.getMarketDataProvider('binance').exchange).toBe('binance');
    expect(exchangeProviderRegistry.getReferencePriceSource()).toBeTruthy();
    expect(exchangeProviderRegistry.getFxRateProvider()).toBeTruthy();
  });
});
