import { getAdapter } from '../../exchanges/ExchangeManager';
import { COIN_MAP } from '../../config/constants';
import type { NormalizedCandle } from '../../exchanges/ExchangeAdapter';

export async function getCandles(
  symbol: string,
  exchangeId: string,
  period: string,
  limit: number,
): Promise<NormalizedCandle[]> {
  if (!COIN_MAP.has(symbol)) return [];

  const adapter = getAdapter(exchangeId);
  if (!adapter) return [];

  return adapter.fetchCandles(symbol, period, limit);
}
