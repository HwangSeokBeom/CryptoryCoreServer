import { getAdapter } from '../../exchanges/ExchangeManager';
import { COIN_MAP } from '../../config/constants';
import type { NormalizedOrderbook } from '../../exchanges/ExchangeAdapter';

export async function getOrderbook(
  symbol: string,
  exchangeId: string,
  depth: number,
): Promise<NormalizedOrderbook | null> {
  if (!COIN_MAP.has(symbol)) return null;

  const adapter = getAdapter(exchangeId);
  if (!adapter) return null;

  return adapter.fetchOrderbook(symbol, depth);
}
