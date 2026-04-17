import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/exchange/registry.bootstrap', () => ({
  exchangeProviderRegistry: {
    getTradingProvider: () => ({
      exchange: 'coinone',
      metadata: { displayName: '코인원' },
      supports: () => true,
    }),
  },
}));

vi.mock('../src/domains/exchange-connections/user-exchange-credentials.service', () => ({
  getUserExchangeCredentials: vi.fn(),
}));

describe('Unsupported Capability Handling', () => {
  it('returns explicit unsupported error for missing trading chance capability', async () => {
    const { getOrderChance } = await import('../src/domains/trading/trading.service');
    await expect(getOrderChance('user-1', 'coinone', 'BTC')).rejects.toMatchObject({
      statusCode: 501,
      message: 'coinone trading chance is unsupported',
    });
  });
});
