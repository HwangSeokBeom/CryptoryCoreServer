import { env } from '../../config/env';
import { prisma } from '../../config/database';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';
import {
  evaluateAlertCondition,
  isRepeatAlertInCooldown,
} from '../market-data/contracts/candle-aggregation';
import {
  getCurrentPriceSnapshots,
  normalizeContractMarket,
} from '../market-data/contracts/market-data-contract.service';
import type { ContractExchange, ContractQuoteCurrency } from '../market-data/contracts/market-data.types';
import {
  deactivateFcmTokenById,
  isInvalidFcmTokenError,
  sendPriceAlertPush,
  type FcmSendResult,
} from '../push/fcm.service';

export type AlertCondition = 'ABOVE' | 'BELOW';
export type AlertRepeatMode = 'ONCE' | 'REPEAT';

export type CreatePriceAlertInput = {
  userId: string;
  exchange: ContractExchange;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
  condition: AlertCondition;
  targetPrice: number;
  repeatMode: AlertRepeatMode;
  isActive: boolean;
};

export type UpdatePriceAlertInput = Partial<Pick<CreatePriceAlertInput, 'condition' | 'targetPrice' | 'repeatMode' | 'isActive'>>;

function normalizeAlertSymbol(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) {
    throw new AppError(400, 'symbol is required', { field: 'symbol' }, 'INVALID_SYMBOL');
  }
  return normalized;
}

function assertTargetPrice(value: number | undefined) {
  if (value === undefined) {
    return;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new AppError(400, 'targetPrice must be greater than 0', { field: 'targetPrice' }, 'INVALID_TARGET_PRICE');
  }
}

async function getCurrentPriceOrThrow(params: {
  exchange: ContractExchange;
  symbol: string;
  quoteCurrency: ContractQuoteCurrency;
}) {
  const [snapshot] = await getCurrentPriceSnapshots([params]);
  if (!snapshot) {
    throw new AppError(503, 'current price is temporarily unavailable', params, 'CURRENT_PRICE_UNAVAILABLE');
  }
  return snapshot.currentPrice;
}

export async function listPriceAlerts(userId: string, filters: {
  symbol?: string;
  exchange?: ContractExchange;
  quoteCurrency?: ContractQuoteCurrency;
  isActive?: boolean;
}) {
  return prisma.priceAlert.findMany({
    where: {
      userId,
      ...(filters.symbol ? { symbol: normalizeAlertSymbol(filters.symbol) } : {}),
      ...(filters.exchange ? { exchange: filters.exchange } : {}),
      ...(filters.quoteCurrency ? { quoteCurrency: filters.quoteCurrency } : {}),
      ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function createPriceAlert(input: CreatePriceAlertInput) {
  assertTargetPrice(input.targetPrice);
  const symbol = normalizeAlertSymbol(input.symbol);
  const market = normalizeContractMarket(input.exchange, symbol, input.quoteCurrency);
  const currentPrice = await getCurrentPriceOrThrow({
    exchange: input.exchange,
    symbol,
    quoteCurrency: input.quoteCurrency,
  });

  const existing = await prisma.priceAlert.findFirst({
    where: {
      userId: input.userId,
      exchange: input.exchange,
      symbol,
      quoteCurrency: input.quoteCurrency,
      condition: input.condition,
      targetPrice: input.targetPrice,
    },
  });
  if (existing) {
    const updated = await prisma.priceAlert.update({
      where: { id: existing.id },
      data: {
        repeatMode: input.repeatMode,
        isActive: input.isActive,
        market,
        currentPriceAtCreate: currentPrice,
      },
    });
    return { ...updated, duplicatePolicy: 'updated_existing' };
  }

  const created = await prisma.priceAlert.create({
    data: {
      userId: input.userId,
      exchange: input.exchange,
      symbol,
      quoteCurrency: input.quoteCurrency,
      market,
      condition: input.condition,
      targetPrice: input.targetPrice,
      currentPriceAtCreate: currentPrice,
      repeatMode: input.repeatMode,
      isActive: input.isActive,
    },
  });

  logger.info(
    {
      domain: 'price-alert',
      userId: input.userId,
      exchange: input.exchange,
      symbol,
      quote: input.quoteCurrency,
      condition: input.condition,
    },
    `[PriceAlert] create userId=${input.userId} exchange=${input.exchange} symbol=${symbol} quote=${input.quoteCurrency} condition=${input.condition}`,
  );
  return created;
}

export async function updatePriceAlert(userId: string, alertId: string, input: UpdatePriceAlertInput) {
  assertTargetPrice(input.targetPrice);
  const existing = await prisma.priceAlert.findUnique({ where: { id: alertId } });
  if (!existing || existing.userId !== userId) {
    throw new AppError(404, 'price alert not found', { alertId }, 'PRICE_ALERT_NOT_FOUND');
  }

  return prisma.priceAlert.update({
    where: { id: alertId },
    data: {
      ...(input.condition ? { condition: input.condition } : {}),
      ...(input.targetPrice !== undefined ? { targetPrice: input.targetPrice } : {}),
      ...(input.repeatMode ? { repeatMode: input.repeatMode } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
}

export async function deletePriceAlert(userId: string, alertId: string) {
  const result = await prisma.priceAlert.deleteMany({
    where: { id: alertId, userId },
  });
  if (result.count === 0) {
    throw new AppError(404, 'price alert not found', { alertId }, 'PRICE_ALERT_NOT_FOUND');
  }
  return { deleted: true };
}

async function logDelivery(params: {
  alertId: string;
  userId: string;
  fcmTokenId?: string | null;
  result: FcmSendResult;
}) {
  await prisma.alertDeliveryLog.create({
    data: {
      alertId: params.alertId,
      userId: params.userId,
      fcmTokenId: params.fcmTokenId ?? null,
      status: params.result.status,
      providerMessageId: params.result.providerMessageId,
      errorCode: params.result.errorCode,
      errorMessage: params.result.errorMessage?.slice(0, 500),
    },
  });
}

export async function triggerPriceAlert(alert: {
  id: string;
  userId: string;
  exchange: string;
  symbol: string;
  quoteCurrency: string;
  condition: string;
  targetPrice: number;
  repeatMode: string;
}, currentPrice: number) {
  const tokens = await prisma.fcmToken.findMany({
    where: { userId: alert.userId, isActive: true },
  });

  if (tokens.length === 0) {
    await logDelivery({
      alertId: alert.id,
      userId: alert.userId,
      result: { status: 'SKIPPED', errorCode: 'NO_ACTIVE_FCM_TOKEN', errorMessage: 'No active FCM token' },
    });
    return { sent: false, successCount: 0 };
  }

  let successCount = 0;
  for (const token of tokens) {
    const result = await sendPriceAlertPush(token.token, {
      alertId: alert.id,
      exchange: alert.exchange,
      symbol: alert.symbol,
      quoteCurrency: alert.quoteCurrency,
      condition: alert.condition as AlertCondition,
      targetPrice: alert.targetPrice,
      currentPrice,
    });
    await logDelivery({ alertId: alert.id, userId: alert.userId, fcmTokenId: token.id, result });
    if (result.status === 'SUCCESS') {
      successCount += 1;
    }
    if (isInvalidFcmTokenError(result.errorCode)) {
      await deactivateFcmTokenById(token.id, result.errorCode ?? 'invalid_token');
    }
  }

  if (successCount > 0) {
    await prisma.priceAlert.update({
      where: { id: alert.id },
      data: {
        lastTriggeredAt: new Date(),
        triggerCount: { increment: 1 },
        ...(alert.repeatMode === 'ONCE' ? { isActive: false } : {}),
      },
    });
  }

  return { sent: successCount > 0, successCount };
}

export function shouldTriggerPriceAlert(alert: {
  condition: string;
  targetPrice: number;
  repeatMode: string;
  lastTriggeredAt?: Date | string | null;
}, currentPrice: number, now = new Date()) {
  if (isRepeatAlertInCooldown({
    repeatMode: alert.repeatMode as AlertRepeatMode,
    lastTriggeredAt: alert.lastTriggeredAt,
    now,
    cooldownSeconds: env.PRICE_ALERT_REPEAT_COOLDOWN_SECONDS,
  })) {
    return false;
  }
  return evaluateAlertCondition({
    condition: alert.condition as AlertCondition,
    currentPrice,
    targetPrice: alert.targetPrice,
  });
}
