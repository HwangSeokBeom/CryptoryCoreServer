import { describe, expect, it } from 'vitest';
import { getCapabilities, supportsCapability } from '../src/core/exchange/capability.resolver';

describe('Exchange Capability Resolver', () => {
  it('returns expected capabilities for domestic exchanges', () => {
    expect(supportsCapability('upbit', 'trading:create-order')).toBe(true);
    expect(supportsCapability('bithumb', 'portfolio:history')).toBe(true);
    expect(supportsCapability('coinone', 'trading:order-chance')).toBe(false);
    expect(supportsCapability('korbit', 'stream:private:assets')).toBe(true);
  });

  it('keeps binance in public-reference-only mode', () => {
    const capabilities = getCapabilities('binance');
    expect(capabilities).toContain('market:ticker');
    expect(capabilities).not.toContain('trading:create-order');
    expect(capabilities).not.toContain('portfolio:balances');
  });
});
