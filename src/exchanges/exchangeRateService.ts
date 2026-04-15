import { exchangeProviderRegistry } from '../core/exchange/registry.bootstrap';
import { logger } from '../utils/logger';

let cachedRate = 1350;

export async function getUsdKrwRate(): Promise<number> {
  try {
    const fxRate = await exchangeProviderRegistry.getFxRateProvider().getUsdKrwRate();
    cachedRate = fxRate.rate;
    return fxRate.rate;
  } catch (error) {
    logger.warn({ domain: 'fx', err: error }, 'Falling back to in-memory USD/KRW rate');
    return cachedRate;
  }
}

export async function refreshUsdKrwRate(): Promise<void> {
  const rate = await getUsdKrwRate();
  cachedRate = rate;
}
