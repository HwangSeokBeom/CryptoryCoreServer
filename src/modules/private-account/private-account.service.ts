import { logger } from '../../utils/logger';
import { assertTransactionalFeatureEnabled } from '../../middleware/compliance.middleware';
import type { PrivateAccountDataProviderInfo } from './private-adapters/private-adapter.types';
import {
  getPlaceholderBalances,
  getPlaceholderFills,
  getPlaceholderHoldings,
  getPlaceholderOpenOrders,
  getPlaceholderOrders,
  getPlaceholderPortfolio,
  getPlaceholderPortfolioSummary,
} from './database-placeholder-account.service';

export const PRIVATE_ACCOUNT_PROVIDER: PrivateAccountDataProviderInfo = {
  source: 'database-placeholder',
  description: 'Internal database-backed placeholder service until live exchange private adapters are implemented.',
  supportsLiveExchangeData: false,
};

export function getPrivateAccountProviderInfo() {
  return PRIVATE_ACCOUNT_PROVIDER;
}

function logPrivateProviderCall(userId: string, action: string, exchange?: string) {
  logger.info(
    {
      domain: 'private-account',
      provider: PRIVATE_ACCOUNT_PROVIDER.source,
      action,
      userId,
      exchange: exchange ?? null,
    },
    'Private account provider invoked',
  );
}

export async function getPrivateBalances(userId: string, exchange = 'upbit') {
  logPrivateProviderCall(userId, 'balances', exchange);
  return getPlaceholderBalances(userId, exchange);
}

export async function getPrivateHoldings(userId: string, exchange = 'upbit') {
  logPrivateProviderCall(userId, 'holdings', exchange);
  return getPlaceholderHoldings(userId, exchange);
}

export async function getPrivatePortfolio(userId: string, exchange = 'upbit') {
  logPrivateProviderCall(userId, 'portfolio', exchange);
  return getPlaceholderPortfolio(userId, exchange);
}

export async function getPrivatePortfolioSummary(userId: string, exchange = 'upbit') {
  logPrivateProviderCall(userId, 'portfolio-summary', exchange);
  return getPlaceholderPortfolioSummary(userId, exchange);
}

export async function getPrivateOrders(userId: string, exchange?: string, limit = 50) {
  assertTransactionalFeatureEnabled('trading', {
    userId,
    path: '/api/v1/private/orders',
    reason: 'private_orders_disabled',
  });
  logPrivateProviderCall(userId, 'orders', exchange);
  return getPlaceholderOrders(userId, exchange, limit);
}

export async function getPrivateOpenOrders(userId: string, exchange?: string) {
  assertTransactionalFeatureEnabled('trading', {
    userId,
    path: '/api/v1/private/open-orders',
    reason: 'private_open_orders_disabled',
  });
  logPrivateProviderCall(userId, 'open-orders', exchange);
  return getPlaceholderOpenOrders(userId, exchange);
}

export async function getPrivateFills(userId: string, exchange?: string, limit = 50) {
  assertTransactionalFeatureEnabled('trading', {
    userId,
    path: '/api/v1/private/fills',
    reason: 'private_fills_disabled',
  });
  logPrivateProviderCall(userId, 'fills', exchange);
  return getPlaceholderFills(userId, exchange, limit);
}
