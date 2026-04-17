import { ExchangeAuthError, ExchangeCapabilityError, ExchangeRequestError } from '../../core/exchange/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { AppError } from '../../utils/errors';
import { getUserExchangeCredentials } from '../exchange-connections/user-exchange-credentials.service';
import { markExchangeConnectionSync } from '../../modules/private-account/exchange-connections.service';

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

async function executePortfolioOperation<T>(
  userId: string,
  exchange: ExchangeId,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    await markExchangeConnectionSync(userId, exchange, { success: true });
    return result;
  } catch (error) {
    await markExchangeConnectionSync(userId, exchange, {
      success: false,
      failureReason: error instanceof Error ? error.message : 'Portfolio operation failed',
    });
    if (error instanceof AppError) {
      throw error;
    }
    if (error instanceof ExchangeCapabilityError) {
      throw new AppError(501, error.message);
    }
    if (error instanceof ExchangeAuthError) {
      throw new AppError(400, error.message);
    }
    if (error instanceof ExchangeRequestError) {
      throw new AppError(502, `${exchange} request failed with HTTP ${error.statusCode}`);
    }
    throw error;
  }
}

export async function getPortfolioSnapshot(userId: string, exchange: ExchangeId) {
  const provider = resolvePortfolioProvider(exchange);
  return executePortfolioOperation(userId, exchange, async () => provider.getPortfolioSnapshot({
    credentials: await getUserExchangeCredentials(userId, exchange),
  }));
}

export async function getAssetHistory(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolvePortfolioProvider(exchange);
  if (!provider.getAssetHistory) {
    throw new AppError(501, `${exchange} asset history is unsupported`);
  }

  return executePortfolioOperation(userId, exchange, async () => provider.getAssetHistory!(symbol, limit, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  }));
}
