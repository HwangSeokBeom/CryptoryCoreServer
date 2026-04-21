import type { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { ExchangeCapabilityError } from '../../core/exchange/errors';
import type { CreateOrderRequest, ExchangeId } from '../../core/exchange/exchange.types';
import { exchangeProviderRegistry } from '../../core/exchange/registry.bootstrap';
import {
  getUserExchangeConnectionRecord,
  requireUserOwnedExchangeCredentials,
} from '../exchange-connections/user-exchange-credentials.service';
import { markExchangeConnectionSync } from '../../modules/private-account/exchange-connections.service';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { classifyExchangeValidationError } from '../../modules/private-account/private-adapters/validation-error-classifier';

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

function toOperationAppError(exchange: ExchangeId, error: unknown, fallbackMessage: string) {
  if (error instanceof AppError) {
    return error;
  }

  const classified = classifyExchangeValidationError(error);
  const statusCodeByCode: Record<string, number> = {
    invalid_credentials: 400,
    insufficient_permissions: 403,
    ip_not_whitelisted: 400,
    signature_error: 400,
    timeout: 504,
    rate_limited: 429,
    exchange_unavailable: 503,
    unsupported_exchange: 501,
    unknown_error: 502,
    verified: 200,
  };

  return new AppError(statusCodeByCode[classified.code] ?? 502, fallbackMessage, {
    code: classified.code,
    exchange,
    message: classified.message,
    details: classified.details,
  });
}

async function getTradingContext(userId: string, exchange: ExchangeId) {
  const [connection, credentials] = await Promise.all([
    getUserExchangeConnectionRecord(userId, exchange),
    requireUserOwnedExchangeCredentials(userId, exchange),
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
      failureCode: typeof appError.details?.code === 'string' ? appError.details.code : 'unknown_error',
      failureReason:
        typeof appError.details?.message === 'string' ? appError.details.message : appError.message,
    });
    throw appError;
  }
}

export async function getOrderChance(userId: string, exchange: ExchangeId, symbol: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrderChance) {
    throw new AppError(501, `${exchange} trading chance is unsupported`);
  }

  return executeTradingOperation(userId, exchange, '주문 가능 정보 조회에 실패했습니다.', async () =>
    provider.getOrderChance!(symbol, {
      ...(await getTradingContext(userId, exchange)),
    }),
  );
}

export async function createTradingOrder(userId: string, input: CreateOrderRequest) {
  validateCreateOrderInput(input);

  const provider = resolveTradingProvider(input.exchange);
  if (!provider.createOrder) {
    throw new AppError(501, `${input.exchange} trading create order is unsupported`);
  }

  const context = await getTradingContext(userId, input.exchange);

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
      failureCode: typeof appError.details?.code === 'string' ? appError.details.code : 'unknown_error',
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
    throw new AppError(501, `${exchange} trading cancel order is unsupported`);
  }

  return executeTradingOperation(userId, exchange, '주문 취소에 실패했습니다.', async () =>
    provider.cancelOrder!(
      { exchange, orderId, symbol },
      await getTradingContext(userId, exchange),
    ),
  );
}

export async function getTradingOrder(userId: string, exchange: ExchangeId, orderId: string, symbol?: string) {
  requireSymbolForOrderLookup(exchange, symbol, 'order lookup');
  const provider = resolveTradingProvider(exchange);
  if (!provider.getOrder) {
    throw new AppError(501, `${exchange} trading get order is unsupported`);
  }

  return executeTradingOperation(userId, exchange, '주문 조회에 실패했습니다.', async () =>
    provider.getOrder!(
      orderId,
      symbol,
      await getTradingContext(userId, exchange),
    ),
  );
}

export async function getOpenOrders(userId: string, exchange: ExchangeId, symbol?: string) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listOpenOrders) {
    throw new AppError(501, `${exchange} trading open orders are unsupported`);
  }

  return executeTradingOperation(userId, exchange, '미체결 주문 조회에 실패했습니다.', async () =>
    provider.listOpenOrders!(symbol, {
      ...(await getTradingContext(userId, exchange)),
    }),
  );
}

export async function getRecentFills(userId: string, exchange: ExchangeId, symbol?: string, limit?: number) {
  const provider = resolveTradingProvider(exchange);
  if (!provider.listFills) {
    throw new AppError(501, `${exchange} trading fills are unsupported`);
  }

  return executeTradingOperation(userId, exchange, '체결 내역 조회에 실패했습니다.', async () =>
    provider.listFills!(symbol, limit, {
      ...(await getTradingContext(userId, exchange)),
    }),
  );
}
