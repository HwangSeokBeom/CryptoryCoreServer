import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type { ExchangeId } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import { AppError } from '../../utils/errors';
import { getUserExchangeCredentials } from '../exchange-connections/user-exchange-credentials.service';

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

export async function getOrderChance(userId: string, exchange: ExchangeId, symbol: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrderChance) {
    throw new AppError(501, `${exchange} trading chance is not implemented yet`);
  }

  return provider.getOrderChance(symbol, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}

export async function createTradingOrder(userId: string, input: any) {
  const provider = resolveTradingProvider(input.exchange);
  if (!provider.createOrder) {
    throw new AppError(501, `${input.exchange} trading create order is not implemented yet`);
  }

  return provider.createOrder(input, {
    credentials: await getUserExchangeCredentials(userId, input.exchange),
  });
}

export async function cancelTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.cancelOrder) {
    throw new AppError(501, `${exchange} trading cancel order is not implemented yet`);
  }

  return provider.cancelOrder(
    { exchange, orderId, symbol },
    { credentials: await getUserExchangeCredentials(userId, exchange) },
  );
}

export async function getTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrder) {
    throw new AppError(501, `${exchange} trading get order is not implemented yet`);
  }

  return provider.getOrder(orderId, symbol, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}

export async function getOpenOrders(userId: string, exchange: ExchangeId, symbol?: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listOpenOrders) {
    throw new AppError(501, `${exchange} trading open orders is not implemented yet`);
  }

  return provider.listOpenOrders(symbol, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}

export async function getRecentFills(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listFills) {
    throw new AppError(501, `${exchange} trading fills are not implemented yet`);
  }

  return provider.listFills(symbol, limit, {
    credentials: await getUserExchangeCredentials(userId, exchange),
  });
}
