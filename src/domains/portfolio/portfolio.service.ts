import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { AppError } from '../../utils/errors';
import { getUserExchangeCredentials } from '../exchange-connections/user-exchange-credentials.service';

function resolvePortfolioProvider(exchange: ExchangeId) {
  try {
    return exchangeProviderRegistry.getPortfolioProvider(exchange);
  } catch (error) {
    if (error instanceof ExchangeCapabilityError) {
      throw new AppError(501, `${exchange} portfolio provider is not implemented yet`);
    }
    throw error;
  }
}

export async function getPortfolioSnapshot(userId: string, exchange: ExchangeId) {
  const provider = resolvePortfolioProvider(exchange);
  return provider.getPortfolioSnapshot({
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}

export async function getAssetHistory(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolvePortfolioProvider(exchange);
  if (!provider.getAssetHistory) {
    throw new AppError(501, `${exchange} asset history is not implemented yet`);
  }

  return provider.getAssetHistory(symbol, limit, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}
