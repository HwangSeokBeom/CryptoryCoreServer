import type { FastifyReply, FastifyRequest } from 'fastify';
import { featureFlags } from '../config/feature-flags';
import { AppError, createErrorResponse } from '../utils/errors';
import { logger } from '../utils/logger';

export type TransactionalFeature =
  | 'order'
  | 'trading'
  | 'transfer'
  | 'deposit_withdraw'
  | 'wallet'
  | 'private_exchange_trading_api';

export const FEATURE_DISABLED_FOR_APP_STORE = 'FEATURE_DISABLED_FOR_APP_STORE';
export const APP_STORE_FEATURE_DISABLED_MESSAGE =
  'Trading, transfer, deposit, and withdrawal features are not available in this app version.';

const featureFlagKey: Record<TransactionalFeature, keyof typeof featureFlags> = {
  order: 'isOrderEnabled',
  trading: 'isTradingEnabled',
  transfer: 'isTransferEnabled',
  deposit_withdraw: 'isDepositWithdrawEnabled',
  wallet: 'isWalletEnabled',
  private_exchange_trading_api: 'isPrivateExchangeTradingAPIEnabled',
};

const publicMarketPrefixes = [
  '/api/v1/public',
  '/market',
  '/charts',
  '/kimchi-premium',
  '/exchange-metadata',
  '/news',
  '/health',
];

function getHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizePath(url: string) {
  return url.split('?')[0].toLowerCase().replace(/\/+$/, '') || '/';
}

function getPathSegments(path: string) {
  return path.split('/').filter(Boolean);
}

function isPublicMarketDataPath(path: string) {
  return publicMarketPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function detectTransactionalFeatureFromPath(method: string, url: string): TransactionalFeature | null {
  const path = normalizePath(url);
  if (isPublicMarketDataPath(path)) {
    return null;
  }

  if (path === '/portfolio/history' || path.startsWith('/portfolio/history/')) {
    return 'trading';
  }

  if (path === '/trading' || path.startsWith('/trading/')) {
    return 'trading';
  }

  if (path.startsWith('/api/v1/private/orders') || path.startsWith('/api/v1/orders')) {
    return 'order';
  }

  if (path.startsWith('/api/v1/private/open-orders') || path.startsWith('/api/v1/private/fills')) {
    return 'trading';
  }

  const segments = getPathSegments(path);
  if (segments.some((segment) => ['wallet', 'wallets'].includes(segment))) {
    return 'wallet';
  }
  if (segments.some((segment) => ['transfer', 'transfers', 'send', 'remittance'].includes(segment))) {
    return 'transfer';
  }
  if (segments.some((segment) => ['withdraw', 'withdrawal', 'withdrawals', 'deposit', 'deposits'].includes(segment))) {
    return 'deposit_withdraw';
  }
  if (segments.some((segment) => ['buy', 'sell', 'trade', 'trading'].includes(segment))) {
    return 'trading';
  }
  if (segments.some((segment) => ['order', 'orders', 'open-orders', 'fills'].includes(segment))) {
    return method.toUpperCase() === 'GET' ? 'trading' : 'order';
  }

  return null;
}

export function isTransactionalFeatureEnabled(feature: TransactionalFeature) {
  return Boolean(featureFlags[featureFlagKey[feature]]);
}

export class FeatureDisabledError extends AppError {
  constructor(feature: TransactionalFeature) {
    super(
      403,
      APP_STORE_FEATURE_DISABLED_MESSAGE,
      { feature, reason: 'app_store_review_mode' },
      FEATURE_DISABLED_FOR_APP_STORE,
    );
    this.name = 'FeatureDisabledError';
  }
}

export function auditBlockedFeatureRequest(params: {
  userId?: string | null;
  method?: string;
  path?: string;
  feature: TransactionalFeature;
  reason?: string;
  userAgent?: string | null;
  appVersion?: string | null;
  buildChannel?: string | null;
  ip?: string | null;
}) {
  logger.warn(
    {
      domain: 'compliance',
      event: 'feature_blocked',
      userId: params.userId ?? null,
      method: params.method ?? null,
      path: params.path ?? null,
      feature: params.feature,
      reason: params.reason ?? 'app_store_review_mode',
      timestamp: new Date().toISOString(),
      userAgent: params.userAgent ?? null,
      appVersion: params.appVersion ?? null,
      buildChannel: params.buildChannel ?? null,
      ip: params.ip ?? null,
    },
    'Blocked transactional feature for App Store mode',
  );
}

export function assertTransactionalFeatureEnabled(
  feature: TransactionalFeature,
  auditContext?: {
    userId?: string | null;
    method?: string;
    path?: string;
    reason?: string;
  },
) {
  if (isTransactionalFeatureEnabled(feature)) {
    return;
  }

  auditBlockedFeatureRequest({
    ...auditContext,
    feature,
    reason: auditContext?.reason ?? 'app_store_review_mode',
  });
  throw new FeatureDisabledError(feature);
}

export async function complianceMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const feature = detectTransactionalFeatureFromPath(request.method, request.url);
  if (!feature || isTransactionalFeatureEnabled(feature)) {
    return;
  }

  auditBlockedFeatureRequest({
    userId: request.user?.id ?? null,
    method: request.method,
    path: normalizePath(request.url),
    feature,
    reason: 'app_store_review_mode',
    userAgent: getHeaderValue(request.headers['user-agent']) ?? null,
    appVersion: getHeaderValue(request.headers['x-app-version']) ?? null,
    buildChannel: getHeaderValue(request.headers['x-build-channel']) ?? null,
    ip: request.ip,
  });

  return reply.status(403).send(createErrorResponse(
    APP_STORE_FEATURE_DISABLED_MESSAGE,
    { feature, reason: 'app_store_review_mode' },
    FEATURE_DISABLED_FOR_APP_STORE,
  ));
}
