import { ExchangeAuthError, ExchangeCapabilityError, ExchangeRequestError } from '../../core/exchange/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { AppError } from '../../utils/errors';
import { resolveRuntimeExchangeCredentials } from '../exchange-connections/user-exchange-credentials.service';
import { markExchangeConnectionSync } from '../../modules/private-account/exchange-connections.service';
import { logger } from '../../utils/logger';

function resolveTradingProvider(exchange: ExchangeId) {
  try {
    return exchangeProviderRegistry.getTradingProvider(exchange);
  } catch (error) {
    if (error instanceof ExchangeCapabilityError) {
      throw new AppError(501, `${exchange} trading provider is not implemented yet`);
    }
    throw error;
  }
}

function requireSymbolForOrderLookup(exchange: ExchangeId, symbol: string | undefined, action: string) {
  if (!symbol && (exchange === 'coinone' || exchange === 'korbit')) {
    throw new AppError(400, `${exchange} ${action} requires symbol query parameter`);
  }
}

async function executeTradingOperation<T>(
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
      failureReason: error instanceof Error ? error.message : 'Trading operation failed',
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

async function getTradingContext(userId: string, exchange: ExchangeId) {
  const resolved = await resolveRuntimeExchangeCredentials(userId, exchange);
  logger.debug(
    { domain: 'credentials', exchange, userId, source: resolved.source, capabilityGroup: 'trading' },
    'Resolved private exchange credentials',
  );
  return { credentials: resolved.credentials };
}

export async function getOrderChance(userId: string, exchange: ExchangeId, symbol: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrderChance) {
    throw new AppError(501, `${exchange} trading chance is unsupported`);
  }

  return executeTradingOperation(userId, exchange, async () => provider.getOrderChance!(symbol, {
    ...(await getTradingContext(userId, exchange)),
  }));
}

export async function createTradingOrder(userId: string, input: any) {
  if (input.type === 'stop_limit') {
    throw new AppError(501, 'stop_limit is unsupported by the canonical trading API');
  }

  const provider = resolveTradingProvider(input.exchange);
  if (!provider.createOrder) {
    throw new AppError(501, `${input.exchange} trading create order is unsupported`);
  }

  return executeTradingOperation(userId, input.exchange, async () => provider.createOrder!(input, {
    ...(await getTradingContext(userId, input.exchange)),
  }));
}

export async function cancelTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  requireSymbolForOrderLookup(exchange, symbol, 'order cancellation');
  const provider = resolveTradingProvider(exchange);
  if (!provider.cancelOrder) {
    throw new AppError(501, `${exchange} trading cancel order is unsupported`);
  }

  return executeTradingOperation(userId, exchange, async () => provider.cancelOrder!(
    { exchange, orderId, symbol },
    await getTradingContext(userId, exchange),
  ));
}

export async function getTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  requireSymbolForOrderLookup(exchange, symbol, 'order lookup');
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrder) {
    throw new AppError(501, `${exchange} trading get order is unsupported`);
  }

  return executeTradingOperation(userId, exchange, async () => provider.getOrder!(
    orderId,
    symbol,
    await getTradingContext(userId, exchange),
  ));
}

export async function getOpenOrders(userId: string, exchange: ExchangeId, symbol?: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listOpenOrders) {
    throw new AppError(501, `${exchange} trading open orders are unsupported`);
  }

  return executeTradingOperation(userId, exchange, async () => provider.listOpenOrders!(symbol, {
    ...(await getTradingContext(userId, exchange)),
  }));
}

export async function getRecentFills(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listFills) {
    throw new AppError(501, `${exchange} trading fills are unsupported`);
  }

  return executeTradingOperation(userId, exchange, async () => provider.listFills!(symbol, limit, {
    ...(await getTradingContext(userId, exchange)),
  }));
}
