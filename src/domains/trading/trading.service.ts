import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type { CreateOrderRequest, ExchangeId, OrderChance } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import {
  getUserExchangeConnectionRecord,
  requireUserOwnedExchangeCredentials,
} from '../exchange-connections/user-exchange-credentials.service';
import { markExchangeConnectionSync } from '../../modules/private-account/exchange-connections.service';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { classifyExchangeValidationError } from '../../modules/private-account/private-adapters/validation-error-classifier';
import {
  getTradingFeatureCapability,
  type TradingFeature,
  type TradingPermission,
} from './trading.capabilities';

function resolveTradingProvider(exchange: ExchangeId) {
  try {
    return exchangeProviderRegistry.getTradingProvider(exchange);
  } catch (error) {
    if (error instanceof ExchangeCapabilityError) {
      throw createTradingAppError(
        501,
        'not_implemented',
        `${exchange} trading provider is not implemented yet`,
        { feature: 'provider' },
      );
    }
    throw error;
  }
}

function requireSymbolForOrderLookup(exchange: ExchangeId, symbol: string | undefined, action: string) {
  if (!symbol && (exchange === 'coinone' || exchange === 'korbit')) {
    throw createTradingAppError(
      422,
      'invalid_symbol_or_market',
      `${exchange} ${action} requires symbol query parameter`,
      { exchange, action, field: 'symbol' },
    );
  }
}

function validateCreateOrderInput(input: CreateOrderRequest) {
  if (input.quantity <= 0) {
    throw new AppError(400, 'quantity must be greater than 0');
  }

  if (input.type === 'stop_limit') {
    throw new AppError(501, 'stop_limit is unsupported by the canonical trading API');
  }

  if (input.type === 'limit' && (!input.price || input.price <= 0)) {
    throw new AppError(400, 'limit order requires a positive price');
  }
}

function createTradingAppError(
  statusCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new AppError(statusCode, message, { ...details, code }, code);
}

function ensureTradingFeatureSupported(exchange: ExchangeId, feature: TradingFeature) {
  const capability = getTradingFeatureCapability(exchange, feature);
  if (!capability.supported) {
    const featureLabelByName: Record<TradingFeature, string> = {
      chance: 'trading chance',
      openOrders: 'trading open orders',
      fills: 'trading fills',
      privateWs: 'private websocket',
    };
    throw createTradingAppError(
      501,
      capability.status === 'not_implemented' ? 'not_implemented' : 'not_supported',
      `${exchange} ${featureLabelByName[feature]} is unsupported`,
      {
        exchange,
        feature,
        capability,
      },
    );
  }

  return capability;
}

function readUpstreamStatus(details: Record<string, unknown>) {
  return typeof details.upstreamStatus === 'number' ? details.upstreamStatus : undefined;
}

function normalizeAppError(exchange: ExchangeId, error: AppError) {
  const detailCode = typeof error.details?.code === 'string' ? error.details.code : error.code;

  if (error.statusCode === 404 && /not connected/i.test(error.message)) {
    return createTradingAppError(409, 'exchange_not_connected', error.message, {
      exchange,
      reason: 'missing_connection',
    });
  }

  if (error.statusCode === 400 && /must be verified/i.test(error.message)) {
    return createTradingAppError(409, 'exchange_not_connected', error.message, {
      exchange,
      reason: 'connection_unverified',
    });
  }

  if (error.statusCode === 403 || detailCode === 'INSUFFICIENT_SCOPE' || detailCode === 'insufficient_permissions') {
    return createTradingAppError(403, 'permission_denied', 'API 키 권한이 부족합니다.', {
      exchange,
      reason: detailCode ?? 'permission_denied',
      ...(error.details ?? {}),
    });
  }

  if (error.statusCode === 501) {
    const code = error.code === 'not_supported' || error.code === 'not_implemented'
      ? error.code
      : 'not_implemented';
    return createTradingAppError(error.statusCode, code, error.message, {
      exchange,
      ...(error.details ?? {}),
    });
  }

  if (error.statusCode === 400 && /symbol|market/i.test(error.message)) {
    return createTradingAppError(422, 'invalid_symbol_or_market', error.message, {
      exchange,
      ...(error.details ?? {}),
    });
  }

  if (error.code) {
    return error;
  }

  return createTradingAppError(error.statusCode, detailCode ?? 'exchange_upstream_error', error.message, {
    exchange,
    ...(error.details ?? {}),
  });
}

function toOperationAppError(exchange: ExchangeId, error: unknown, fallbackMessage: string) {
  if (error instanceof AppError) {
    return normalizeAppError(exchange, error);
  }

  const classified = classifyExchangeValidationError(error);
  const upstreamStatus = readUpstreamStatus(classified.details);

  if (
    classified.code === 'insufficient_permissions'
    || classified.code === 'invalid_credentials'
    || classified.code === 'ip_not_whitelisted'
    || classified.code === 'signature_error'
  ) {
    return createTradingAppError(403, 'permission_denied', classified.message, {
      exchange,
      validationCode: classified.code,
      details: classified.details,
    });
  }

  if (classified.code === 'timeout' || classified.code === 'rate_limited') {
    return createTradingAppError(503, 'temporary_unavailable', classified.message, {
      exchange,
      validationCode: classified.code,
      details: classified.details,
    });
  }

  if (classified.code === 'unsupported_exchange') {
    return createTradingAppError(501, 'not_supported', fallbackMessage, {
      exchange,
      validationCode: classified.code,
      details: classified.details,
    });
  }

  if (upstreamStatus === 400) {
    return createTradingAppError(422, 'invalid_symbol_or_market', classified.message, {
      exchange,
      validationCode: classified.code,
      details: classified.details,
    });
  }

  if (upstreamStatus === 404) {
    return createTradingAppError(501, 'not_implemented', '거래소 private API 경로가 현재 구현과 일치하지 않습니다.', {
      exchange,
      validationCode: classified.code,
      details: classified.details,
    });
  }

  return createTradingAppError(502, 'exchange_upstream_error', fallbackMessage, {
    exchange,
    validationCode: classified.code,
    message: classified.message,
    details: classified.details,
  });
}

async function getTradingContext(
  userId: string,
  exchange: ExchangeId,
  requiredCapability: TradingPermission = 'read',
) {
  const [connection, credentials] = await Promise.all([
    getUserExchangeConnectionRecord(userId, exchange),
    requireUserOwnedExchangeCredentials(userId, exchange, requiredCapability),
  ]);

  logger.debug(
    { domain: 'credentials', exchange, userId, source: 'user_connection', capabilityGroup: 'trading' },
    'Resolved user-owned private exchange credentials',
  );

  return {
    connectionId: connection.id,
    credentials,
  };
}

async function getTradingContextForFeature(
  userId: string,
  exchange: ExchangeId,
  feature: TradingFeature,
) {
  const capability = ensureTradingFeatureSupported(exchange, feature);
  try {
    return await getTradingContext(userId, exchange, capability.requiredPermission);
  } catch (error) {
    throw toOperationAppError(exchange, error, '거래소 연결 상태를 확인할 수 없습니다.');
  }
}

async function recordOrderRequest(params: {
  userId: string;
  exchange: ExchangeId;
  connectionId: string;
  input: CreateOrderRequest;
  status: 'submitted' | 'rejected';
  providerOrderId?: string;
  responsePayload?: Record<string, unknown>;
  failureCode?: string;
  failureMessage?: string;
}) {
  const requestPayload = JSON.parse(JSON.stringify(params.input)) as Prisma.InputJsonValue;
  const responsePayload = params.responsePayload
    ? (JSON.parse(JSON.stringify(params.responsePayload)) as Prisma.InputJsonValue)
    : undefined;

  return prisma.orderRequest.create({
    data: {
      userId: params.userId,
      exchangeConnectionId: params.connectionId,
      exchange: params.exchange,
      symbol: params.input.symbol,
      side: params.input.side,
      type: params.input.type,
      status: params.status,
      providerOrderId: params.providerOrderId,
      requestPayload,
      responsePayload,
      failureCode: params.failureCode,
      failureMessage: params.failureMessage,
    },
  });
}

async function executeTradingOperation<T>(
  userId: string,
  exchange: ExchangeId,
  fallbackMessage: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    const result = await operation();
    await markExchangeConnectionSync(userId, exchange, { success: true });
    return result;
  } catch (error) {
    const appError = toOperationAppError(exchange, error, fallbackMessage);
    await markExchangeConnectionSync(userId, exchange, {
      success: false,
      failureCode: appError.code ?? (typeof appError.details?.code === 'string' ? appError.details.code : 'unknown_error'),
      failureReason:
        typeof appError.details?.message === 'string' ? appError.details.message : appError.message,
    });
    throw appError;
  }
}

function normalizeOrderChance(exchange: ExchangeId, requestedSymbol: string, chance: OrderChance): OrderChance {
  const makerFee = chance.makerFee ?? chance.fees?.maker;
  const takerFee = chance.takerFee ?? chance.fees?.taker;
  const minTotal = chance.minTotal ?? chance.limits?.minTotal;
  const minQuantity = chance.minQuantity ?? chance.limits?.minQuantity;
  const maxQuantity = chance.maxQuantity ?? chance.limits?.maxQuantity;
  const maxTotal = chance.maxTotal ?? chance.limits?.maxTotal;
  const supportedOrderTypes = chance.supportedOrderTypes ?? [];

  return {
    ...chance,
    exchange,
    symbol: chance.symbol || requestedSymbol.trim().toUpperCase(),
    market: chance.market || `${requestedSymbol.trim().toUpperCase()}/${chance.quoteCurrency}`,
    baseAsset: chance.baseAsset ?? chance.symbol ?? requestedSymbol.trim().toUpperCase(),
    availableKRW: chance.quoteCurrency === 'KRW' ? (chance.availableKRW ?? chance.availableQuote ?? 0) : chance.availableKRW,
    availableQuote: chance.availableQuote ?? chance.availableKRW ?? 0,
    availableBaseAsset: chance.availableBaseAsset ?? 0,
    minTotal,
    minQuantity,
    maxQuantity,
    maxTotal,
    makerFee,
    takerFee,
    supportedOrderTypes,
    fees: {
      maker: makerFee,
      taker: takerFee,
    },
    limits: {
      minTotal,
      minQuantity,
      maxQuantity,
      maxTotal,
    },
    precision: chance.precision ?? {},
    orderable: chance.orderable ?? {
      buy: supportedOrderTypes.length > 0,
      sell: supportedOrderTypes.length > 0,
      limit: supportedOrderTypes.includes('limit'),
      market: supportedOrderTypes.includes('market'),
    },
  };
}

export async function getOrderChance(userId: string, exchange: ExchangeId, symbol: string) {
  ensureTradingFeatureSupported(exchange, 'chance');
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrderChance) {
    throw createTradingAppError(501, 'not_implemented', `${exchange} trading chance is not implemented`, {
      exchange,
      feature: 'chance',
    });
  }

  return executeTradingOperation(userId, exchange, '주문 가능 정보 조회에 실패했습니다.', async () =>
    normalizeOrderChance(
      exchange,
      symbol,
      await provider.getOrderChance!(symbol, {
        ...(await getTradingContextForFeature(userId, exchange, 'chance')),
      }),
    ),
  );
}

export async function createTradingOrder(userId: string, input: CreateOrderRequest) {
  validateCreateOrderInput(input);

  const provider = resolveTradingProvider(input.exchange);
  if (!provider.createOrder) {
    throw createTradingAppError(501, 'not_implemented', `${input.exchange} trading create order is not implemented`, {
      exchange: input.exchange,
      feature: 'createOrder',
    });
  }

  let context: Awaited<ReturnType<typeof getTradingContext>>;
  try {
    context = await getTradingContext(userId, input.exchange, 'trade');
  } catch (error) {
    throw toOperationAppError(input.exchange, error, '거래소 연결 상태를 확인할 수 없습니다.');
  }

  try {
    const order = await executeTradingOperation(userId, input.exchange, '주문 생성에 실패했습니다.', async () =>
      provider.createOrder!(input, {
        credentials: context.credentials,
      }),
    );
    const orderRequest = await recordOrderRequest({
      userId,
      exchange: input.exchange,
      connectionId: context.connectionId,
      input,
      status: 'submitted',
      providerOrderId: order.orderId,
      responsePayload: order as unknown as Record<string, unknown>,
    });

    return {
      requestId: orderRequest.id,
      submittedAt: orderRequest.createdAt.toISOString(),
      order,
    };
  } catch (error) {
    const appError = toOperationAppError(input.exchange, error, '주문 생성에 실패했습니다.');
    await recordOrderRequest({
      userId,
      exchange: input.exchange,
      connectionId: context.connectionId,
      input,
      status: 'rejected',
      failureCode: appError.code ?? (typeof appError.details?.code === 'string' ? appError.details.code : 'unknown_error'),
      failureMessage: typeof appError.details?.message === 'string' ? appError.details.message : appError.message,
      responsePayload:
        appError.details && typeof appError.details === 'object'
          ? (appError.details as Record<string, unknown>)
          : undefined,
    });
    throw appError;
  }
}

export async function cancelTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  requireSymbolForOrderLookup(exchange, symbol, 'order cancellation');
  const provider = resolveTradingProvider(exchange);
  if (!provider.cancelOrder) {
    throw createTradingAppError(501, 'not_implemented', `${exchange} trading cancel order is not implemented`, {
      exchange,
      feature: 'cancelOrder',
    });
  }

  return executeTradingOperation(userId, exchange, '주문 취소에 실패했습니다.', async () =>
    provider.cancelOrder!(
      { exchange, orderId, symbol },
      await getTradingContext(userId, exchange, 'trade').catch((error) => {
        throw toOperationAppError(exchange, error, '거래소 연결 상태를 확인할 수 없습니다.');
      }),
    ),
  );
}

export async function getTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  requireSymbolForOrderLookup(exchange, symbol, 'order lookup');
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrder) {
    throw createTradingAppError(501, 'not_implemented', `${exchange} trading get order is not implemented`, {
      exchange,
      feature: 'getOrder',
    });
  }

  return executeTradingOperation(userId, exchange, '주문 조회에 실패했습니다.', async () =>
    provider.getOrder!(
      orderId,
      symbol,
      await getTradingContextForFeature(userId, exchange, 'openOrders'),
    ),
  );
}

export async function getOpenOrders(userId: string, exchange: ExchangeId, symbol?: string) {
  ensureTradingFeatureSupported(exchange, 'openOrders');
  const provider = resolveTradingProvider(exchange);
  if (!provider.listOpenOrders) {
    throw createTradingAppError(501, 'not_implemented', `${exchange} trading open orders are not implemented`, {
      exchange,
      feature: 'openOrders',
    });
  }

  return executeTradingOperation(userId, exchange, '미체결 주문 조회에 실패했습니다.', async () =>
    provider.listOpenOrders!(symbol, {
      ...(await getTradingContextForFeature(userId, exchange, 'openOrders')),
    }),
  );
}

export async function getRecentFills(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  ensureTradingFeatureSupported(exchange, 'fills');
  const provider = resolveTradingProvider(exchange);
  if (!provider.listFills) {
    throw createTradingAppError(501, 'not_implemented', `${exchange} trading fills are not implemented`, {
      exchange,
      feature: 'fills',
    });
  }

  return executeTradingOperation(userId, exchange, '체결 내역 조회에 실패했습니다.', async () =>
    provider.listFills!(symbol, limit, {
      ...(await getTradingContextForFeature(userId, exchange, 'fills')),
    }),
  );
}
